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
const { connectAwsMqtt, subscribeAwsTopic } = require("./src/aws-mqtt");
const { connectBroker, publishData } = require("./src/broker");
const { parseDashboard, printDashboard } = require("./src/dashboard");
const {
  publishDiscovery,
  publishAvailability,
  publishStates,
} = require("./src/discovery");
const {
  setTargetChargeLevel,
  startClimate,
  stopClimate,
} = require("./src/commands");

// ─── Poll Cycle ──────────────────────────────────────────────────────────────

async function pollOnce(accessToken, hidasIdent, vin) {
  const { cigToken, cigSignature } = await getCigToken(
    accessToken,
    hidasIdent,
    vin
  );
  const awsClient = await connectAwsMqtt(vin, cigToken, cigSignature);

  try {
    const dashTopic = `$aws/things/thing_${vin}/shadow/name/DASHBOARD_ASYNC/update`;
    await subscribeAwsTopic(awsClient, dashTopic);

    const cancelSignal = { cancelled: false };

    const dashboardPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cancelSignal.cancelled = true;
        awsClient.removeListener("message", handler);
        reject(new Error("Timed out waiting for dashboard data (60s)"));
      }, 60000);

      function handler(topic, message) {
        if (!topic.includes("DASHBOARD_ASYNC")) return;
        debug(`Received MQTT message on: ${topic}`);
        const payload = message.toString();
        const dashboard = parseDashboard(payload);
        if (dashboard) {
          cancelSignal.cancelled = true;
          clearTimeout(timeout);
          awsClient.removeListener("message", handler);
          resolve(dashboard);
        }
      }

      awsClient.on("message", handler);
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
  const pin = process.env.ACURA_PIN || null;
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
  ACURA_PIN        Vehicle PIN for climate commands (optional)
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
  let busy = false;
  let lastReportedTargetLevel = null;
  let optimisticTargetLevel = null;
  let optimisticExpiry = 0;
  let climateMode = "off";
  let climateTemp = 72;

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

        // Handle target charge level with optimistic mode awareness
        if (dashboard.chargeSettings?.targetLevel != null) {
          const dashLevel = dashboard.chargeSettings.targetLevel;

          if (optimisticTargetLevel != null) {
            if (dashLevel === optimisticTargetLevel) {
              // Dashboard caught up, clear optimistic mode
              log(
                `Dashboard confirmed optimistic target charge level: ${optimisticTargetLevel}%`
              );
              lastReportedTargetLevel = dashLevel;
              optimisticTargetLevel = null;
              optimisticExpiry = 0;
            } else if (Date.now() < optimisticExpiry) {
              // Still in optimistic window, override with optimistic value
              log(
                `Dashboard shows ${dashLevel}%, keeping optimistic value ${optimisticTargetLevel}%`
              );
              brokerClient.publish(
                `acura-ev/${vin}/ev_target_charge_level/state`,
                String(optimisticTargetLevel),
                { retain: true, qos: 1 }
              );
            } else {
              // Optimistic window expired, accept dashboard value
              log(
                `Optimistic mode expired, accepting dashboard value ${dashLevel}%`
              );
              lastReportedTargetLevel = dashLevel;
              optimisticTargetLevel = null;
              optimisticExpiry = 0;
            }
          } else {
            lastReportedTargetLevel = dashLevel;
          }
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
    const climateModeTopic = `acura-ev/${vin}/climate/mode/set`;
    const climateTempTopic = `acura-ev/${vin}/climate/temperature/set`;

    const commandTopics = [setChargeTopic, climateModeTopic, climateTempTopic];
    brokerClient.subscribe(commandTopics, { qos: 1 }, (err) => {
      if (err) {
        log(`Failed to subscribe to command topics: ${err.message}`);
      } else {
        log("Listening for commands");
      }
    });

    // Publish initial climate state
    const mqttOpts = { retain: true, qos: 1 };
    brokerClient.publish(
      `acura-ev/${vin}/climate/mode/state`,
      climateMode,
      mqttOpts
    );
    brokerClient.publish(
      `acura-ev/${vin}/climate/temperature/state`,
      String(climateTemp),
      mqttOpts
    );

    brokerClient.on("message", async (topic, message) => {
      // ── Climate temperature (no API call, just store) ──
      if (topic === climateTempTopic) {
        const temp = parseInt(message.toString(), 10);
        if (isNaN(temp) || temp < 60 || temp > 90) {
          log(
            `Invalid climate temperature: ${message.toString()} (must be 60-90)`
          );
          return;
        }
        climateTemp = temp;
        brokerClient.publish(
          `acura-ev/${vin}/climate/temperature/state`,
          String(climateTemp),
          mqttOpts
        );
        log(`Climate temperature set to ${climateTemp}°F`);
        return;
      }

      // ── Climate mode (start/stop preconditioning) ──
      if (topic === climateModeTopic) {
        const mode = message.toString().toLowerCase();
        if (mode !== "auto" && mode !== "off") {
          log(`Invalid climate mode: ${message.toString()}`);
          return;
        }

        if (!pin) {
          log("Cannot control climate: ACURA_PIN not configured");
          return;
        }

        if (busy) {
          log("Operation in progress, ignoring climate command");
          return;
        }

        busy = true;
        let awsClient;
        try {
          const { cigToken, cigSignature } = await getCigToken(
            accessToken,
            hidasIdent,
            vin
          );
          awsClient = await connectAwsMqtt(vin, cigToken, cigSignature);

          if (mode === "auto") {
            await startClimate(
              awsClient,
              accessToken,
              vin,
              pin,
              climateTemp
            );
          } else {
            await stopClimate(
              awsClient,
              accessToken,
              vin,
              pin,
              climateTemp
            );
          }

          climateMode = mode;
          brokerClient.publish(
            `acura-ev/${vin}/climate/mode/state`,
            climateMode,
            mqttOpts
          );
        } catch (err) {
          log(`Climate command failed: ${err.message}`);

          // Re-publish current state (revert optimistic HA state)
          brokerClient.publish(
            `acura-ev/${vin}/climate/mode/state`,
            climateMode,
            mqttOpts
          );

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
          if (awsClient) awsClient.end(true);
          busy = false;
        }
        return;
      }

      // ── Set target charge level ──
      if (topic !== setChargeTopic) return;

      const value = parseInt(message.toString(), 10);
      if (isNaN(value) || value < 50 || value > 100) {
        log(
          `Invalid target charge level received: ${message.toString()} (must be 50-100)`
        );
        return;
      }

      if (busy) {
        log("Operation in progress, ignoring set target charge level");
        return;
      }

      busy = true;
      const stateTopic = `acura-ev/${vin}/ev_target_charge_level/state`;

      // Optimistically publish the desired value immediately
      brokerClient.publish(stateTopic, String(value), mqttOpts);
      log(`Optimistically set target charge level state to ${value}%`);

      let awsClient;
      try {
        const { cigToken, cigSignature } = await getCigToken(
          accessToken,
          hidasIdent,
          vin
        );
        awsClient = await connectAwsMqtt(vin, cigToken, cigSignature);

        await setTargetChargeLevel(awsClient, accessToken, vin, value);

        // Command accepted — enter optimistic mode for 15 minutes
        optimisticTargetLevel = value;
        optimisticExpiry = Date.now() + 15 * 60 * 1000;
        log(`Command accepted, optimistic mode active for 15 minutes`);
      } catch (err) {
        log(`Failed to set target charge level: ${err.message}`);

        // Revert since the command itself failed
        optimisticTargetLevel = null;
        optimisticExpiry = 0;
        if (lastReportedTargetLevel != null) {
          log(
            `Reverting target charge level state to ${lastReportedTargetLevel}%`
          );
          brokerClient.publish(
            stateTopic,
            String(lastReportedTargetLevel),
            mqttOpts
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
        if (awsClient) awsClient.end(true);
        busy = false;
      }
    });

    // Run first poll immediately
    await poll();

    // Schedule recurring polls
    log(`Next poll in ${pollInterval}s`);
    pollTimer = setInterval(async () => {
      if (busy) {
        log("Skipping scheduled poll (operation in progress)");
        return;
      }
      busy = true;
      try {
        await poll();
      } finally {
        busy = false;
      }
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
