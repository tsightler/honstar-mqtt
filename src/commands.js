const { log, debug } = require("./config");
const { getAwsClient, extendConnectionDeadline } = require("./aws-mqtt");
const {
  requestSetTargetChargeLevel,
  requestStartClimate,
  requestStopClimate,
  requestLockDoors,
  requestUnlockDoors,
  requestLocateVehicle,
} = require("./api");

/**
 * Helper: wait for an MQTT response matching a topic filter.
 * Fails fast if the connection drops instead of waiting for the full timeout.
 */
function waitForMqttResponse(awsClient, topicFilter, verifyTimeout, parseResponse) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for ${topicFilter} confirmation (${verifyTimeout / 1000}s)`
        )
      );
    }, verifyTimeout);

    function cleanup() {
      clearTimeout(timeout);
      awsClient.removeListener("message", handler);
      awsClient.removeListener("close", onClose);
    }

    function onClose() {
      cleanup();
      reject(new Error("MQTT connection lost"));
    }

    function handler(topic, message) {
      if (!topic.includes(topicFilter)) return;

      try {
        const payload = JSON.parse(message.toString());
        const reported = payload.state?.reported;
        if (!reported) return;

        const result = parseResponse(reported);
        if (result !== undefined) {
          cleanup();
          if (result instanceof Error) {
            reject(result);
          } else {
            resolve(result);
          }
        }
      } catch {
        // ignore parse errors
      }
    }

    awsClient.on("message", handler);
    awsClient.on("close", onClose);
  });
}

function parseStatusResponse(label) {
  return (reported) => {
    debug(`${label} response: ${reported.status} (${reported.cigServiceRequestId})`);

    if (reported.status === "SUCCESS") return true;
    if (reported.status !== "IN_PROGRESS" && reported.status !== "PENDING") {
      return new Error(`${label} failed with status: ${reported.status}`);
    }
    return undefined; // keep waiting
  };
}

/**
 * Common command executor: HTTP request → MQTT wait → retry with deadline extension.
 */
async function executeCommand({
  name,
  httpRequest,
  topicFilter,
  parseResponse,
  timeout = 60000,
  maxAttempts = 3,
  retryDelay = 10000,
  nonRetryableErrors = [],
}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const awsClient = await getAwsClient();
    extendConnectionDeadline(timeout + 60000);
    try {
      await httpRequest();
      return await waitForMqttResponse(awsClient, topicFilter, timeout, parseResponse);
    } catch (err) {
      if (nonRetryableErrors.some((msg) => err.message.includes(msg))) throw err;
      log(`${name} attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
      if (attempt < maxAttempts) {
        log("Retrying in 10 seconds...");
        await new Promise((r) => setTimeout(r, retryDelay));
      }
    }
  }
  throw new Error(`Failed to ${name} after ${maxAttempts} attempts`);
}

async function setTargetChargeLevel(
  accessToken,
  vin,
  level,
  { maxAttempts = 5, verifyTimeout = 60000 } = {}
) {
  level = Math.round(level);
  if (level < 50 || level > 100) {
    throw new Error(`Invalid charge level: ${level} (must be 50-100)`);
  }

  log(`Setting target charge level to ${level}%...`);

  await executeCommand({
    name: "set target charge level",
    httpRequest: () => requestSetTargetChargeLevel(accessToken, vin, level),
    topicFilter: "CHARGEMANAGEMENT_TARGETCHARGELEVEL_ASYNC",
    parseResponse: parseStatusResponse("Charge level"),
    timeout: verifyTimeout,
    maxAttempts,
  });

  log(`Target charge level set to ${level}%`);
  return true;
}

async function startClimate(
  accessToken,
  vin,
  pin,
  temperature,
  { maxAttempts = 3, verifyTimeout = 60000 } = {}
) {
  log(`Starting climate preconditioning (${temperature}°F)...`);

  await executeCommand({
    name: "start climate",
    httpRequest: () => requestStartClimate(accessToken, vin, pin, temperature),
    topicFilter: "ENGINE_START_STOP_ASYNC",
    parseResponse: parseStatusResponse("Climate start"),
    timeout: verifyTimeout,
    maxAttempts,
    nonRetryableErrors: ["Pin does not match"],
  });

  log(`Climate preconditioning started at ${temperature}°F`);
  return true;
}

async function stopClimate(
  accessToken,
  vin,
  pin,
  temperature,
  { maxAttempts = 3, verifyTimeout = 60000 } = {}
) {
  log(`Stopping climate preconditioning...`);

  await executeCommand({
    name: "stop climate",
    httpRequest: () => requestStopClimate(accessToken, vin, pin, temperature),
    topicFilter: "ENGINE_START_STOP_ASYNC",
    parseResponse: parseStatusResponse("Climate stop"),
    timeout: verifyTimeout,
    maxAttempts,
    nonRetryableErrors: ["Pin does not match"],
  });

  log(`Climate preconditioning stopped`);
  return true;
}

async function lockDoors(
  accessToken,
  vin,
  pin,
  { maxAttempts = 3, verifyTimeout = 60000 } = {}
) {
  log("Locking doors...");

  await executeCommand({
    name: "lock doors",
    httpRequest: () => requestLockDoors(accessToken, vin, pin),
    topicFilter: "LOCK_ASYNC",
    timeout: verifyTimeout,
    maxAttempts,
    nonRetryableErrors: ["Pin does not match"],
    parseResponse: (reported) => {
      // Only handle lock responses (not unlock)
      if (
        reported.cigServiceRequestId &&
        !reported.cigServiceRequestId.startsWith("lockDoor")
      )
        return undefined;

      debug(
        `Lock response: ${reported.status} (${reported.cigServiceRequestId})`
      );

      if (reported.status === "SUCCESS") return true;
      if (reported.status !== "IN_PROGRESS" && reported.status !== "PENDING") {
        return new Error(`Door lock failed with status: ${reported.status}`);
      }
      return undefined;
    },
  });

  log("Doors locked");
  return true;
}

async function unlockDoors(
  accessToken,
  vin,
  pin,
  { maxAttempts = 3, verifyTimeout = 60000 } = {}
) {
  log("Unlocking doors...");

  await executeCommand({
    name: "unlock doors",
    httpRequest: () => requestUnlockDoors(accessToken, vin, pin),
    topicFilter: "LOCK_ASYNC",
    timeout: verifyTimeout,
    maxAttempts,
    nonRetryableErrors: ["Pin does not match"],
    parseResponse: (reported) => {
      // Only handle unlock responses (not lock)
      if (
        reported.cigServiceRequestId &&
        !reported.cigServiceRequestId.startsWith("unlockDoor")
      )
        return undefined;

      debug(
        `Unlock response: ${reported.status} (${reported.cigServiceRequestId})`
      );

      if (reported.status === "SUCCESS") return true;
      if (reported.status !== "IN_PROGRESS" && reported.status !== "PENDING") {
        return new Error(`Door unlock failed with status: ${reported.status}`);
      }
      return undefined;
    },
  });

  log("Doors unlocked");
  return true;
}

async function locateVehicle(
  accessToken,
  vin,
  pin,
  { maxAttempts = 3, verifyTimeout = 120000 } = {}
) {
  log("Locating vehicle...");

  const result = await executeCommand({
    name: "locate vehicle",
    httpRequest: () => requestLocateVehicle(accessToken, vin, pin),
    topicFilter: "CARFINDER_LOCATION_ASYNC",
    timeout: verifyTimeout,
    maxAttempts,
    nonRetryableErrors: ["Pin does not match"],
    parseResponse: (reported) => {
      debug(
        `Locate response: ${reported.status} (${reported.cigServiceRequestId})`
      );

      if (reported.status === "SUCCESS") return reported.responseBody;
      if (reported.status !== "IN_PROGRESS" && reported.status !== "PENDING") {
        return new Error(
          `Locate vehicle failed with status: ${reported.status}`
        );
      }
      return undefined;
    },
  });

  const gps = result?.gpsData?.coordinate;
  if (gps) {
    log(`Vehicle located: ${gps.latitude}, ${gps.longitude}`);
  } else {
    log("Vehicle located (no GPS data in response)");
  }
  return result;
}

module.exports = {
  setTargetChargeLevel,
  startClimate,
  stopClimate,
  lockDoors,
  unlockDoors,
  locateVehicle,
};
