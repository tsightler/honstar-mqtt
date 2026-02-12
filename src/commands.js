const { log, debug } = require("./config");
const {
  requestSetTargetChargeLevel,
  requestStartClimate,
  requestStopClimate,
} = require("./api");
const { subscribeAwsTopic } = require("./aws-mqtt");

async function setTargetChargeLevel(
  awsClient,
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

  // Subscribe to the charge management shadow topic once
  const chargeTopic = `$aws/things/thing_${vin}/shadow/name/CHARGEMANAGEMENT_TARGETCHARGELEVEL_ASYNC/update`;
  await subscribeAwsTopic(awsClient, chargeTopic);

  // Retry loop: only retry the HTTP POST + MQTT confirmation
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await requestSetTargetChargeLevel(accessToken, vin, level);

      // Wait for SUCCESS on the MQTT topic
      const success = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          awsClient.removeListener("message", handler);
          reject(
            new Error(
              `Timed out waiting for charge level confirmation (${verifyTimeout / 1000}s)`
            )
          );
        }, verifyTimeout);

        function handler(topic, message) {
          if (!topic.includes("CHARGEMANAGEMENT_TARGETCHARGELEVEL_ASYNC"))
            return;

          try {
            const payload = JSON.parse(message.toString());
            const reported = payload.state?.reported;
            if (!reported) return;

            debug(
              `Charge level response: ${reported.status} (${reported.cigServiceRequestId})`
            );

            if (reported.status === "SUCCESS") {
              clearTimeout(timeout);
              awsClient.removeListener("message", handler);
              resolve(true);
            } else if (
              reported.status !== "IN_PROGRESS" &&
              reported.status !== "PENDING"
            ) {
              clearTimeout(timeout);
              awsClient.removeListener("message", handler);
              reject(
                new Error(
                  `Set target charge failed with status: ${reported.status}`
                )
              );
            }
          } catch {
            // ignore parse errors
          }
        }

        awsClient.on("message", handler);
      });

      if (success) {
        log(`Target charge level set to ${level}%`);
        return true;
      }
    } catch (err) {
      log(
        `Set target charge attempt ${attempt}/${maxAttempts} failed: ${err.message}`
      );
      if (attempt < maxAttempts) {
        log("Retrying in 10 seconds...");
        await new Promise((r) => setTimeout(r, 10000));
      }
    }
  }

  throw new Error(
    `Failed to set target charge level after ${maxAttempts} attempts`
  );
}

async function startClimate(
  awsClient,
  accessToken,
  vin,
  pin,
  temperature,
  { maxAttempts = 3, verifyTimeout = 60000 } = {}
) {
  log(`Starting climate preconditioning (${temperature}°F)...`);

  const engineTopic = `$aws/things/thing_${vin}/shadow/name/ENGINE_START_STOP_ASYNC/update`;
  await subscribeAwsTopic(awsClient, engineTopic);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await requestStartClimate(accessToken, vin, pin, temperature);

      const success = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          awsClient.removeListener("message", handler);
          reject(
            new Error(
              `Timed out waiting for climate start confirmation (${verifyTimeout / 1000}s)`
            )
          );
        }, verifyTimeout);

        function handler(topic, message) {
          if (!topic.includes("ENGINE_START_STOP_ASYNC")) return;

          try {
            const payload = JSON.parse(message.toString());
            const reported = payload.state?.reported;
            if (!reported) return;

            debug(
              `Climate response: ${reported.status} (${reported.cigServiceRequestId})`
            );

            if (reported.status === "SUCCESS") {
              clearTimeout(timeout);
              awsClient.removeListener("message", handler);
              resolve(true);
            } else if (
              reported.status !== "IN_PROGRESS" &&
              reported.status !== "PENDING"
            ) {
              clearTimeout(timeout);
              awsClient.removeListener("message", handler);
              reject(
                new Error(
                  `Climate start failed with status: ${reported.status}`
                )
              );
            }
          } catch {
            // ignore parse errors
          }
        }

        awsClient.on("message", handler);
      });

      if (success) {
        log(`Climate preconditioning started at ${temperature}°F`);
        return true;
      }
    } catch (err) {
      // Don't retry PIN errors
      if (err.message.includes("Pin does not match")) {
        throw err;
      }
      log(
        `Climate start attempt ${attempt}/${maxAttempts} failed: ${err.message}`
      );
      if (attempt < maxAttempts) {
        log("Retrying in 10 seconds...");
        await new Promise((r) => setTimeout(r, 10000));
      }
    }
  }

  throw new Error(`Failed to start climate after ${maxAttempts} attempts`);
}

async function stopClimate(
  awsClient,
  accessToken,
  vin,
  pin,
  temperature,
  { maxAttempts = 3, verifyTimeout = 60000 } = {}
) {
  log(`Stopping climate preconditioning...`);

  const engineTopic = `$aws/things/thing_${vin}/shadow/name/ENGINE_START_STOP_ASYNC/update`;
  await subscribeAwsTopic(awsClient, engineTopic);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await requestStopClimate(accessToken, vin, pin, temperature);

      const success = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          awsClient.removeListener("message", handler);
          reject(
            new Error(
              `Timed out waiting for climate stop confirmation (${verifyTimeout / 1000}s)`
            )
          );
        }, verifyTimeout);

        function handler(topic, message) {
          if (!topic.includes("ENGINE_START_STOP_ASYNC")) return;

          try {
            const payload = JSON.parse(message.toString());
            const reported = payload.state?.reported;
            if (!reported) return;

            debug(
              `Climate response: ${reported.status} (${reported.cigServiceRequestId})`
            );

            if (reported.status === "SUCCESS") {
              clearTimeout(timeout);
              awsClient.removeListener("message", handler);
              resolve(true);
            } else if (
              reported.status !== "IN_PROGRESS" &&
              reported.status !== "PENDING"
            ) {
              clearTimeout(timeout);
              awsClient.removeListener("message", handler);
              reject(
                new Error(
                  `Climate stop failed with status: ${reported.status}`
                )
              );
            }
          } catch {
            // ignore parse errors
          }
        }

        awsClient.on("message", handler);
      });

      if (success) {
        log(`Climate preconditioning stopped`);
        return true;
      }
    } catch (err) {
      if (err.message.includes("Pin does not match")) {
        throw err;
      }
      log(
        `Climate stop attempt ${attempt}/${maxAttempts} failed: ${err.message}`
      );
      if (attempt < maxAttempts) {
        log("Retrying in 10 seconds...");
        await new Promise((r) => setTimeout(r, 10000));
      }
    }
  }

  throw new Error(`Failed to stop climate after ${maxAttempts} attempts`);
}

module.exports = { setTargetChargeLevel, startClimate, stopClimate };
