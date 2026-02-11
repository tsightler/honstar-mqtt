#!/usr/bin/env node

/**
 * Acura EV Connect - MQTT Gateway
 *
 * Authenticates to the Acura EV connected vehicle services,
 * polls vehicle dashboard status on a configurable interval,
 * and publishes the data to an MQTT broker.
 *
 * Can run standalone, as a Docker container, or as a Home Assistant addon.
 */

require("dotenv/config");

const { log, debug } = require("./src/config");
const {
  registerClient,
  generateToken,
  getVehicles,
  getCigToken,
  requestDashboard,
} = require("./src/api");
const { connectAwsMqtt } = require("./src/aws-mqtt");
const { connectBroker, publishData } = require("./src/broker");
const { parseDashboard, printDashboard } = require("./src/dashboard");
const {
  publishDiscovery,
  publishAvailability,
  publishStates,
} = require("./src/discovery");
const { setTargetChargeLevel } = require("./src/commands");

// ─── Poll Cycle ──────────────────────────────────────────────────────────────

async function pollOnce(accessToken, hidasIdent, vin) {
  const { cigToken, cigSignature } = await getCigToken(
    accessToken,
    hidasIdent,
    vin
  );

  const awsClient = await connectAwsMqtt(vin, cigToken, cigSignature);

  try {
    const cancelSignal = { cancelled: false };

    const dashboardPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cancelSignal.cancelled = true;
        reject(new Error("Timed out waiting for dashboard data (60s)"));
      }, 60000);

      awsClient.on("message", (topic, message) => {
        debug(`Received MQTT message on: ${topic}`);
        const payload = message.toString();
        const dashboard = parseDashboard(payload);
        if (dashboard) {
          cancelSignal.cancelled = true;
          clearTimeout(timeout);
          resolve(dashboard);
        }
      });
    });

    await requestDashboard(accessToken, vin, { cancelSignal });

    const retryTimer = setInterval(async () => {
      if (cancelSignal.cancelled) {
        clearInterval(retryTimer);
        return;
      }
      debug("Re-requesting dashboard...");
      try {
        await requestDashboard(accessToken, vin, {
          maxRetries: 2,
          retryDelay: 3000,
          cancelSignal,
        });
      } catch (err) {
        debug(`Retry cycle failed: ${err.message}`);
      }
    }, 10000);

    const dashboard = await dashboardPromise;
    clearInterval(retryTimer);
    return dashboard;
  } finally {
    awsClient.end(true);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const username = process.env.ACURA_USERNAME || process.argv[2];
  const password = process.env.ACURA_PASSWORD || process.argv[3];
  const targetVin = process.env.ACURA_VIN || process.argv[4];
  const mqttUrl = process.env.MQTT_URL;
  const pollInterval = parseInt(process.env.POLL_INTERVAL, 10) || 900;

  if (!username || !password) {
    console.log(`
Acura EV Connect - MQTT Gateway

Usage:
  node index.js <email> <password> [vin]

Environment variables:
  ACURA_USERNAME   Acura account email (required)
  ACURA_PASSWORD   Acura account password (required)
  ACURA_VIN        Vehicle VIN (optional, uses first vehicle)
  MQTT_URL         MQTT broker URL (required)
                   e.g. mqtt://user:pass@192.168.1.100:1883
  POLL_INTERVAL    Seconds between polls (default: 900 = 15 min)
  DEBUG            Enable debug logging (true/false, default: false)

Docker:
  docker run -e ACURA_USERNAME=... -e ACURA_PASSWORD=... \\
             -e MQTT_URL=mqtt://user:pass@host:1883 \\
             acura-ev-mqtt
`);
    process.exit(1);
  }

  if (!mqttUrl) {
    console.error("Error: MQTT_URL environment variable is required");
    process.exit(1);
  }

  log("Acura EV Connect - MQTT Gateway starting...");
  log(`Poll interval: ${pollInterval}s`);

  // State
  let brokerClient = null;
  let accessToken = null;
  let hidasIdent = null;
  let vin = null;
  let vehicle = null;
  let pollTimer = null;
  let shuttingDown = false;
  let commandInProgress = false;
  let lastReportedTargetLevel = null;

  // Graceful shutdown
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    log("Shutting down...");

    if (pollTimer) clearInterval(pollTimer);

    if (brokerClient) {
      if (vin) {
        publishAvailability(brokerClient, vin, false);
        brokerClient.publish(`acura-ev/${vin}/status`, "offline", {
          retain: true,
          qos: 1,
        });
      }
      await new Promise((resolve) => brokerClient.end(false, {}, resolve));
    }

    log("Goodbye");
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Authenticate and get vehicle info
  async function authenticate() {
    const clientRegKey = await registerClient();
    const auth = await generateToken(clientRegKey, username, password);
    accessToken = auth.accessToken;
    hidasIdent = auth.hidasIdent;

    const vehicles = await getVehicles(accessToken, hidasIdent);
    vehicle = vehicles.find((v) => v.VIN === targetVin) || vehicles[0];
    vin = vehicle.VIN;
    log(`Using VIN: ${vin}`);
  }

  // Single poll + publish cycle
  async function poll() {
    if (shuttingDown) return;

    log("Starting poll cycle...");
    try {
      const dashboard = await pollOnce(accessToken, hidasIdent, vin);
      if (dashboard) {
        printDashboard(dashboard);
        publishData(brokerClient, vin, dashboard);
        publishStates(brokerClient, vin, dashboard);
        publishAvailability(brokerClient, vin, true);

        // Track last reported target level for optimistic revert
        if (dashboard.chargeSettings?.targetLevel != null) {
          lastReportedTargetLevel = dashboard.chargeSettings.targetLevel;
        }

        brokerClient.publish(`acura-ev/${vin}/status`, "online", {
          retain: true,
          qos: 1,
        });
      } else {
        log("No dashboard data received");
      }
    } catch (err) {
      log(`Poll failed: ${err.message}`);

      if (
        err.message.includes("401") ||
        err.message.includes("403") ||
        err.message.includes("Auth") ||
        err.message.includes("token")
      ) {
        log("Possible auth error, re-authenticating...");
        try {
          await authenticate();
        } catch (authErr) {
          log(`Re-authentication failed: ${authErr.message}`);
        }
      }
    }
  }

  try {
    // Initial authentication
    await authenticate();

    // Connect to user's MQTT broker
    brokerClient = await connectBroker(mqttUrl);

    // Publish HA discovery configs and availability
    publishDiscovery(brokerClient, vin, vehicle);
    publishAvailability(brokerClient, vin, true);

    brokerClient.publish(`acura-ev/${vin}/status`, "online", {
      retain: true,
      qos: 1,
    });

    // Subscribe to command topics
    const setChargeTopic = `acura-ev/${vin}/ev_target_charge_level/set`;
    brokerClient.subscribe(setChargeTopic, { qos: 1 }, (err) => {
      if (err) {
        log(`Failed to subscribe to ${setChargeTopic}: ${err.message}`);
      } else {
        log(`Listening for commands on ${setChargeTopic}`);
      }
    });

    brokerClient.on("message", async (topic, message) => {
      if (topic !== setChargeTopic) return;

      const value = parseInt(message.toString(), 10);
      if (isNaN(value) || value < 50 || value > 100) {
        log(
          `Invalid target charge level received: ${message.toString()} (must be 50-100)`
        );
        return;
      }

      if (commandInProgress) {
        log("Command already in progress, ignoring set target charge level");
        return;
      }

      commandInProgress = true;
      const stateTopic = `acura-ev/${vin}/ev_target_charge_level/state`;
      const opts = { retain: true, qos: 1 };

      // Optimistically publish the desired value immediately
      brokerClient.publish(stateTopic, String(value), opts);
      log(`Optimistically set target charge level state to ${value}%`);

      try {
        await setTargetChargeLevel(accessToken, hidasIdent, vin, value);

        // Update the last known good value
        lastReportedTargetLevel = value;

        // Trigger a dashboard poll to refresh all state
        log("Refreshing dashboard after target charge level change...");
        await poll();
      } catch (err) {
        log(`Failed to set target charge level: ${err.message}`);

        // Revert to previously reported value since all retries failed
        if (lastReportedTargetLevel != null) {
          log(
            `Reverting target charge level state to ${lastReportedTargetLevel}%`
          );
          brokerClient.publish(
            stateTopic,
            String(lastReportedTargetLevel),
            opts
          );
        }

        if (
          err.message.includes("401") ||
          err.message.includes("403") ||
          err.message.includes("Auth") ||
          err.message.includes("token")
        ) {
          log("Possible auth error, re-authenticating...");
          try {
            await authenticate();
          } catch (authErr) {
            log(`Re-authentication failed: ${authErr.message}`);
          }
        }
      } finally {
        commandInProgress = false;
      }
    });

    // Run first poll immediately
    await poll();

    // Schedule recurring polls
    log(`Next poll in ${pollInterval}s`);
    pollTimer = setInterval(async () => {
      await poll();
      if (!shuttingDown) {
        log(`Next poll in ${pollInterval}s`);
      }
    }, pollInterval * 1000);
  } catch (err) {
    log(`Fatal error: ${err.message}`);
    await shutdown();
  }
}

main();
