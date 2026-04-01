#!/usr/bin/env node

/**
 * Honstar MQTT Gateway
 *
 * Authenticates to Honda/Acura EV connected vehicle services,
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
const { publishDiscovery } = require("./src/discovery");
const { publishAvailability, publishStates } = require("./src/states");
const {
  setTargetChargeLevel,
  startClimate,
  stopClimate,
  lockDoors,
  unlockDoors,
  locateVehicle,
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
  const username = process.env.HWS_USERNAME || process.argv[2];
  const password = process.env.HWS_PASSWORD || process.argv[3];
  const targetVin = process.env.VIN || process.argv[4];
  const mqttUrl = process.env.MQTT_URL;
  const pin = process.env.HWS_PIN || null;
  const pollInterval = Math.max(parseInt(process.env.POLL_INTERVAL, 10) || 900, 900);

  if (!username || !password) {
    console.log(`
Honstar MQTT Gateway

Usage:
  node index.js <email> <password> [vin]

Environment variables:
  HWS USERNAME         Honda Web Services email (required)
  PASSWORD         Honda Web Services password (required)
  HWS PIN              Vehicle PIN for climate commands (optional)
  MQTT_URL         MQTT broker URL (required)
                   e.g. mqtt://user:pass@192.168.1.100:1883
  POLL_INTERVAL    Seconds between polls (minimum/default: 900 = 15 min)
  DEBUG            Enable debug logging (true/false, default: false)

Docker:
  docker run -e HWS_USERNAME=... -e HWS_PASSWORD=... \\
             -e MQTT_URL=mqtt://user:pass@host:1883 \\
             honstar-mqtt
`);
    process.exit(1);
  }

  if (!mqttUrl) {
    console.error("Error: MQTT_URL environment variable is required");
    process.exit(1);
  }

  log("HOnStar MQTT Gateway starting...");
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
  let pendingChargeLevel = null;
  let lastReportedTargetLevel = null;
  let optimisticTargetLevel = null;
  let optimisticExpiry = 0;
  let climateMode = "off";
  let climateTemp = 72;
  let climateOffTimer = null;
  let pendingClimateCmd = null;
  let pendingLockCmd = null;
  let lockStateTimer = null;
  let pendingLocateCmd = null;
  let lastLocation = null;

  // Graceful shutdown
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    log("Shutting down...");

    if (pollTimer) clearInterval(pollTimer);
    if (climateOffTimer) clearTimeout(climateOffTimer);
    if (lockStateTimer) clearTimeout(lockStateTimer);

    if (brokerClient) {
      if (vin) {
        publishAvailability(brokerClient, vin, false);
        brokerClient.publish(`honstar-mqtt/${vin}/status`, "offline", {
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
        publishStates(brokerClient, vin, dashboard, vehicle);
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
                `honstar-mqtt/${vin}/ev_target_charge_level/state`,
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

        brokerClient.publish(`honstar-mqtt/${vin}/status`, "online", {
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

    brokerClient.publish(`honstar-mqtt/${vin}/status`, "online", {
      retain: true,
      qos: 1,
    });

    // Subscribe to command topics
    const setChargeTopic = `honstar-mqtt/${vin}/ev_target_charge_level/set`;
    const climateModeTopic = `honstar-mqtt/${vin}/ev_climate/set`;
    const climateTempTopic = `honstar-mqtt/${vin}/ev_climate_temperature/set`;
    const lockTopic = `honstar-mqtt/${vin}/door_lock/set`;
    const locateTopic = `honstar-mqtt/${vin}/locate/set`;

    const commandTopics = [
      setChargeTopic,
      climateModeTopic,
      climateTempTopic,
      lockTopic,
      locateTopic,
    ];
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
      `honstar-mqtt/${vin}/ev_climate/state`,
      climateMode === "auto" ? "ON" : "OFF",
      mqttOpts
    );
    brokerClient.publish(
      `honstar-mqtt/${vin}/ev_climate_temperature/state`,
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
          `honstar-mqtt/${vin}/ev_climate_temperature/state`,
          String(climateTemp),
          mqttOpts
        );
        log(`Climate temperature set to ${climateTemp}°F`);
        return;
      }

      // ── Door lock/unlock ──
      if (topic === lockTopic) {
        const cmd = message.toString().toUpperCase();
        if (cmd !== "LOCK" && cmd !== "UNLOCK") {
          log(`Invalid lock command: ${message.toString()}`);
          return;
        }

        if (!pin) {
          log("Cannot control door lock: PIN not configured");
          return;
        }

        if (busy) {
          pendingLockCmd = cmd;
          log(`Operation in progress, queued door ${cmd.toLowerCase()}`);
          brokerClient.publish(
            `honstar-mqtt/${vin}/door_lock/state`,
            cmd === "LOCK" ? "LOCKING" : "UNLOCKING",
            mqttOpts
          );
          return;
        }

        await executeLockCmd(cmd);
        return;
      }

      // ── Locate vehicle ──
      if (topic === locateTopic) {
        const cmd = message.toString().toUpperCase();
        if (cmd !== "PRESS") {
          log(`Invalid locate command: ${message.toString()}`);
          return;
        }

        if (!pin) {
          log("Cannot locate vehicle: PIN not configured");
          return;
        }

        if (busy) {
          pendingLocateCmd = cmd;
          log("Operation in progress, queued locate");
          return;
        }

        await executeLocateCmd();
        return;
      }

      // ── Climate switch (start/stop preconditioning) ──
      if (topic === climateModeTopic) {
        const cmd = message.toString().toUpperCase();
        if (cmd !== "ON" && cmd !== "OFF") {
          log(`Invalid climate command: ${message.toString()}`);
          return;
        }

        if (!pin) {
          log("Cannot control climate: PIN not configured");
          return;
        }

        if (busy) {
          pendingClimateCmd = cmd;
          log(`Operation in progress, queued climate ${cmd}`);
          brokerClient.publish(
            `honstar-mqtt/${vin}/ev_climate/state`,
            cmd,
            mqttOpts
          );
          return;
        }

        await executeClimateCmd(cmd);
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
        pendingChargeLevel = value;
        log(
          `Operation in progress, queued target charge level ${value}%`
        );
        // Optimistically update the display even while queued
        brokerClient.publish(
          `honstar-mqtt/${vin}/ev_target_charge_level/state`,
          String(value),
          mqttOpts
        );
        return;
      }

      await executeSetChargeLevel(value);
    });

    async function executeSetChargeLevel(value) {
      busy = true;
      pendingChargeLevel = null;
      const stateTopic = `honstar-mqtt/${vin}/ev_target_charge_level/state`;

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

      await processPendingCommands();
    }

    async function executeClimateCmd(cmd) {
      busy = true;
      pendingClimateCmd = null;
      const climateStateTopic = `honstar-mqtt/${vin}/ev_climate/state`;
      const previousMode = climateMode;

      // Optimistically publish the desired state immediately
      brokerClient.publish(climateStateTopic, cmd, mqttOpts);
      log(`Optimistically set climate state to ${cmd}`);

      let awsClient;
      try {
        const { cigToken, cigSignature } = await getCigToken(
          accessToken,
          hidasIdent,
          vin
        );
        awsClient = await connectAwsMqtt(vin, cigToken, cigSignature);

        if (cmd === "ON") {
          await startClimate(
            awsClient,
            accessToken,
            vin,
            pin,
            climateTemp
          );
          climateMode = "auto";

          // Auto-off after 60 minutes (max preconditioning duration)
          if (climateOffTimer) clearTimeout(climateOffTimer);
          climateOffTimer = setTimeout(() => {
            climateMode = "off";
            climateOffTimer = null;
            brokerClient.publish(climateStateTopic, "OFF", mqttOpts);
            log("Climate preconditioning auto-off after 60 minutes");
          }, 60 * 60 * 1000);
        } else {
          await stopClimate(
            awsClient,
            accessToken,
            vin,
            pin,
            climateTemp
          );
          climateMode = "off";
          if (climateOffTimer) {
            clearTimeout(climateOffTimer);
            climateOffTimer = null;
          }
        }
      } catch (err) {
        log(`Climate command failed: ${err.message}`);

        // Revert to previous state
        climateMode = previousMode;
        brokerClient.publish(
          climateStateTopic,
          previousMode === "auto" ? "ON" : "OFF",
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

      await processPendingCommands();
    }

    async function executeLockCmd(cmd) {
      busy = true;
      pendingLockCmd = null;
      const lockStateTopic = `honstar-mqtt/${vin}/door_lock/state`;

      if (lockStateTimer) clearTimeout(lockStateTimer);

      // Publish transitional state
      brokerClient.publish(
        lockStateTopic,
        cmd === "LOCK" ? "LOCKING" : "UNLOCKING",
        mqttOpts
      );

      let awsClient;
      try {
        const { cigToken, cigSignature } = await getCigToken(
          accessToken,
          hidasIdent,
          vin
        );
        awsClient = await connectAwsMqtt(vin, cigToken, cigSignature);

        if (cmd === "LOCK") {
          await lockDoors(awsClient, accessToken, vin, pin);
        } else {
          await unlockDoors(awsClient, accessToken, vin, pin);
        }

        // Command succeeded, publish final state then revert to unknown after 2 min
        brokerClient.publish(
          lockStateTopic,
          cmd === "LOCK" ? "LOCKED" : "UNLOCKED",
          mqttOpts
        );
        lockStateTimer = setTimeout(() => {
          brokerClient.publish(lockStateTopic, "", mqttOpts);
          lockStateTimer = null;
        }, 120000);
      } catch (err) {
        log(`Door ${cmd.toLowerCase()} command failed: ${err.message}`);

        // Clear state on failure
        brokerClient.publish(lockStateTopic, "", mqttOpts);

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

      await processPendingCommands();
    }

    async function executeLocateCmd() {
      busy = true;
      pendingLocateCmd = null;

      let awsClient;
      try {
        const { cigToken, cigSignature } = await getCigToken(
          accessToken,
          hidasIdent,
          vin
        );
        awsClient = await connectAwsMqtt(vin, cigToken, cigSignature);

        const result = await locateVehicle(
          awsClient,
          accessToken,
          vin,
          pin
        );

        if (result?.gpsData?.coordinate) {
          const gps = result.gpsData.coordinate;
          lastLocation = {
            latitude: gps.latitude,
            longitude: gps.longitude,
            timestamp: result.gpsData.dtTime || new Date().toISOString(),
          };
          brokerClient.publish(
            `honstar-mqtt/${vin}/location/state`,
            JSON.stringify(lastLocation),
            mqttOpts
          );
          log(
            `Published vehicle location: ${gps.latitude}, ${gps.longitude}`
          );
        }
      } catch (err) {
        log(`Locate vehicle command failed: ${err.message}`);

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

      await processPendingCommands();
    }

    async function processPendingCommands() {
      if (pendingLockCmd != null) {
        const next = pendingLockCmd;
        log(`Processing queued door ${next.toLowerCase()}`);
        await executeLockCmd(next);
      } else if (pendingLocateCmd != null) {
        pendingLocateCmd = null;
        log("Processing queued locate");
        await executeLocateCmd();
      } else if (pendingClimateCmd != null) {
        const next = pendingClimateCmd;
        log(`Processing queued climate ${next}`);
        await executeClimateCmd(next);
      } else if (pendingChargeLevel != null) {
        const next = pendingChargeLevel;
        log(`Processing queued target charge level ${next}%`);
        await executeSetChargeLevel(next);
      }
    }

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
