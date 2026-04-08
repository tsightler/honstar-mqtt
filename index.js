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
  requestDashboard,
} = require("./src/api");
const { initAwsMqtt, getAwsClient, closeAwsMqtt } = require("./src/aws-mqtt");
const { connectBroker, publishData } = require("./src/broker");
const { parseDashboard, printDashboard } = require("./src/dashboard");
const { publishDiscovery } = require("./src/discovery");
const { publishAvailability, publishStates, updateVehicleLocation } = require("./src/states");
const {
  setTargetChargeLevel,
  startClimate,
  stopClimate,
  lockDoors,
  unlockDoors,
  locateVehicle,
} = require("./src/commands");

// ─── Poll Cycle ──────────────────────────────────────────────────────────────

async function pollOnce(accessToken, vin) {
  const awsClient = await getAwsClient();

  const cancelSignal = { cancelled: false };
  let dashTimeout;
  let dashHandler;

  const dashboardPromise = new Promise((resolve, reject) => {
    dashTimeout = setTimeout(() => {
      cancelSignal.cancelled = true;
      awsClient.removeListener("message", dashHandler);
      reject(new Error("Timed out waiting for dashboard data (60s)"));
    }, 60000);

    dashHandler = function (topic, message) {
      if (!topic.includes("DASHBOARD_ASYNC")) return;
      debug(`Received MQTT message on: ${topic}`);
      const payload = message.toString();
      const dashboard = parseDashboard(payload);
      if (dashboard) {
        cancelSignal.cancelled = true;
        clearTimeout(dashTimeout);
        awsClient.removeListener("message", dashHandler);
        resolve(dashboard);
      }
    };

    awsClient.on("message", dashHandler);
  });

  function cleanupDashboard() {
    cancelSignal.cancelled = true;
    clearTimeout(dashTimeout);
    awsClient.removeListener("message", dashHandler);
  }

  try {
    await requestDashboard(accessToken, vin, { cancelSignal });
  } catch (err) {
    cleanupDashboard();
    throw err;
  }

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

  try {
    const dashboard = await dashboardPromise;
    return dashboard;
  } finally {
    clearInterval(retryTimer);
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

  const { version } = require("./package.json");
  log(`HOnStar MQTT Gateway v${version} starting...`);
  log(`Poll interval: ${pollInterval}s`);

  // State
  let brokerClient = null;
  let accessToken = null;
  let hidasIdent = null;
  let vin = null;
  let vehicle = null;
  let pollTimer = null;
  let shuttingDown = false;
  const activeOps = new Set();
  let reauthPromise = null;
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
  let lastLocateTime = 0;
  let lastOdometer = null;
  let needsLocationUpdate = true;
  let consecutiveFailures = 0;

  // Graceful shutdown
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    log("Shutting down...");

    if (pollTimer) clearInterval(pollTimer);
    if (climateOffTimer) clearTimeout(climateOffTimer);
    if (lockStateTimer) clearTimeout(lockStateTimer);

    closeAwsMqtt();

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

    initAwsMqtt(() => ({ accessToken, hidasIdent, vin }));
  }

  function needsReauth(msg) {
    return (
      msg.includes("401") ||
      msg.includes("403") ||
      msg.includes("Auth") ||
      msg.includes("token") ||
      msg.includes("association")
    );
  }

  async function handleReauth(errMessage) {
    if (!needsReauth(errMessage)) return;
    if (reauthPromise) return reauthPromise;
    log("Auth/association error detected, re-authenticating...");
    reauthPromise = (async () => {
      try {
        await authenticate();
      } catch (authErr) {
        log(`Re-authentication failed: ${authErr.message}`);
      } finally {
        reauthPromise = null;
      }
    })();
    return reauthPromise;
  }

  // Single poll + publish cycle
  async function poll() {
    if (shuttingDown) return;

    log("Starting poll cycle...");
    try {
      const dashboard = await pollOnce(accessToken, vin);
      if (dashboard) {
        consecutiveFailures = 0;
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

        // Auto-locate: if location update needed or odometer changed
        const currentOdometer = dashboard.odometer?.value;
        if (pin && currentOdometer != null) {
          if (lastOdometer != null && currentOdometer !== lastOdometer) {
            log(`Odometer changed (${lastOdometer} -> ${currentOdometer}), queuing location update`);
            needsLocationUpdate = true;
          }
          if (needsLocationUpdate) {
            pendingLocateCmd = "PRESS";
          }
          lastOdometer = currentOdometer;
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
      consecutiveFailures++;

      if (consecutiveFailures >= 3) {
        log(`${consecutiveFailures} consecutive poll failures, re-authenticating...`);
        try {
          await authenticate();
          consecutiveFailures = 0;
        } catch (authErr) {
          log(`Re-authentication failed: ${authErr.message}`);
        }
      } else {
        await handleReauth(err.message);
      }
    }
  }

  try {
    // Initial authentication + broker connection with retry
    while (!shuttingDown) {
      try {
        await authenticate();
        brokerClient = await connectBroker(mqttUrl);
        break;
      } catch (err) {
        log(`Startup error: ${err.message}`);
        if (brokerClient) {
          try { await new Promise((r) => brokerClient.end(false, {}, r)); } catch {}
          brokerClient = null;
        }
        if (shuttingDown) break;
        log(`Retrying in ${pollInterval}s...`);
        await new Promise((r) => setTimeout(r, pollInterval * 1000));
      }
    }
    if (shuttingDown) { await shutdown(); return; }

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

    // Publish initial lock state as unknown (no way to query from API)
    brokerClient.publish(
      `honstar-mqtt/${vin}/door_lock/state`,
      "None",
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

        if (activeOps.has('lock')) {
          pendingLockCmd = cmd;
          log(`Lock operation in progress, queued door ${cmd.toLowerCase()}`);
          brokerClient.publish(
            `honstar-mqtt/${vin}/door_lock/state`,
            cmd === "LOCK" ? "LOCKING" : "UNLOCKING",
            mqttOpts
          );
          return;
        }

        executeLockCmd(cmd);
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

        const locateCooldown = 10 * 60 * 1000;
        const timeSinceLastLocate = Date.now() - lastLocateTime;
        if (timeSinceLastLocate < locateCooldown) {
          const remainMin = Math.ceil((locateCooldown - timeSinceLastLocate) / 60000);
          log(`Locate request ignored: cooldown active (${remainMin} min remaining)`);
          return;
        }

        if (activeOps.has('locate')) {
          pendingLocateCmd = cmd;
          log("Locate in progress, queued locate");
          return;
        }

        executeLocateCmd();
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

        if (activeOps.has('climate')) {
          pendingClimateCmd = cmd;
          log(`Climate operation in progress, queued climate ${cmd}`);
          brokerClient.publish(
            `honstar-mqtt/${vin}/ev_climate/state`,
            cmd,
            mqttOpts
          );
          return;
        }

        executeClimateCmd(cmd);
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

      if (activeOps.has('charge')) {
        pendingChargeLevel = value;
        log(
          `Charge operation in progress, queued target charge level ${value}%`
        );
        // Optimistically update the display even while queued
        brokerClient.publish(
          `honstar-mqtt/${vin}/ev_target_charge_level/state`,
          String(value),
          mqttOpts
        );
        return;
      }

      executeSetChargeLevel(value);
    });

    async function executeSetChargeLevel(value) {
      activeOps.add('charge');
      pendingChargeLevel = null;
      const stateTopic = `honstar-mqtt/${vin}/ev_target_charge_level/state`;

      // Optimistically publish the desired value immediately
      brokerClient.publish(stateTopic, String(value), mqttOpts);
      log(`Optimistically set target charge level state to ${value}%`);

      try {
        const awsClient = await getAwsClient();
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

        await handleReauth(err.message);
      } finally {
        activeOps.delete('charge');
      }

      if (pendingChargeLevel != null) {
        const next = pendingChargeLevel;
        log(`Processing queued target charge level ${next}%`);
        executeSetChargeLevel(next);
      }
    }

    async function executeClimateCmd(cmd) {
      activeOps.add('climate');
      pendingClimateCmd = null;
      const climateStateTopic = `honstar-mqtt/${vin}/ev_climate/state`;
      const previousMode = climateMode;

      // Optimistically publish the desired state immediately
      brokerClient.publish(climateStateTopic, cmd, mqttOpts);
      log(`Optimistically set climate state to ${cmd}`);

      try {
        const awsClient = await getAwsClient();

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

        await handleReauth(err.message);
      } finally {
        activeOps.delete('climate');
      }

      if (pendingClimateCmd != null) {
        const next = pendingClimateCmd;
        log(`Processing queued climate ${next}`);
        executeClimateCmd(next);
      }
    }

    async function executeLockCmd(cmd) {
      activeOps.add('lock');
      pendingLockCmd = null;
      const lockStateTopic = `honstar-mqtt/${vin}/door_lock/state`;

      if (lockStateTimer) clearTimeout(lockStateTimer);

      // Publish transitional state
      brokerClient.publish(
        lockStateTopic,
        cmd === "LOCK" ? "LOCKING" : "UNLOCKING",
        mqttOpts
      );

      try {
        const awsClient = await getAwsClient();

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
          brokerClient.publish(lockStateTopic, "None", mqttOpts);
          lockStateTimer = null;
        }, 120000);
      } catch (err) {
        log(`Door ${cmd.toLowerCase()} command failed: ${err.message}`);

        // Clear state on failure
        brokerClient.publish(lockStateTopic, "None", mqttOpts);

        await handleReauth(err.message);
      } finally {
        activeOps.delete('lock');
      }

      if (pendingLockCmd != null) {
        const next = pendingLockCmd;
        log(`Processing queued door ${next.toLowerCase()}`);
        executeLockCmd(next);
      }
    }

    async function executeLocateCmd() {
      activeOps.add('locate');
      pendingLocateCmd = null;
      lastLocateTime = Date.now();

      try {
        const awsClient = await getAwsClient();

        const result = await locateVehicle(
          awsClient,
          accessToken,
          vin,
          pin
        );

        if (result?.gpsData?.coordinate) {
          const gps = result.gpsData.coordinate;
          const location = {
            latitude: gps.latitude,
            longitude: gps.longitude,
            timestamp: result.gpsData.dtTime || new Date().toISOString(),
          };

          // Update vehicle timezone based on location
          updateVehicleLocation(gps.latitude, gps.longitude);

          brokerClient.publish(
            `honstar-mqtt/${vin}/location/state`,
            JSON.stringify(location),
            mqttOpts
          );
          log(
            `Published vehicle location: ${gps.latitude}, ${gps.longitude}`
          );
          needsLocationUpdate = false;
        }
      } catch (err) {
        log(`Locate vehicle command failed: ${err.message}`);

        await handleReauth(err.message);
      } finally {
        activeOps.delete('locate');
      }

      if (pendingLocateCmd != null) {
        pendingLocateCmd = null;
        log("Processing queued locate");
        executeLocateCmd();
      }
    }

    function processPendingCommands() {
      if (pendingLockCmd != null && !activeOps.has('lock')) {
        const next = pendingLockCmd;
        log(`Processing queued door ${next.toLowerCase()}`);
        executeLockCmd(next);
      }
      if (pendingLocateCmd != null && !activeOps.has('locate')) {
        pendingLocateCmd = null;
        log("Processing queued locate");
        executeLocateCmd();
      }
      if (pendingClimateCmd != null && !activeOps.has('climate')) {
        const next = pendingClimateCmd;
        log(`Processing queued climate ${next}`);
        executeClimateCmd(next);
      }
      if (pendingChargeLevel != null && !activeOps.has('charge')) {
        const next = pendingChargeLevel;
        log(`Processing queued target charge level ${next}%`);
        executeSetChargeLevel(next);
      }
    }

    // Run first poll immediately
    await poll();

    // Locate vehicle on startup (requires PIN, skip if poll failed)
    if (pin && consecutiveFailures === 0) {
      executeLocateCmd();
    }

    // Schedule recurring polls
    log(`Next poll in ${pollInterval}s`);
    pollTimer = setInterval(async () => {
      if (activeOps.has('poll')) {
        log("Skipping scheduled poll (poll in progress)");
        return;
      }
      activeOps.add('poll');
      try {
        await poll();
      } finally {
        activeOps.delete('poll');
      }
      processPendingCommands();
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
