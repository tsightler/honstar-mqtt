const { log, debug } = require("./config");
const { getCigToken, requestSetTargetChargeLevel } = require("./api");
const { connectAwsMqtt } = require("./aws-mqtt");

async function setTargetChargeLevel(
  accessToken,
  hidasIdent,
  vin,
  level,
  { maxAttempts = 3, verifyTimeout = 60000 } = {}
) {
  level = Math.round(level);
  if (level < 50 || level > 100) {
    throw new Error(`Invalid charge level: ${level} (must be 50-100)`);
  }

  log(`Setting target charge level to ${level}%...`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Get a fresh CIG token for this attempt
      const { cigToken, cigSignature } = await getCigToken(
        accessToken,
        hidasIdent,
        vin
      );

      // Connect to AWS IoT MQTT
      const awsClient = await connectAwsMqtt(vin, cigToken, cigSignature);

      try {
        // Subscribe to the charge management shadow topic
        const chargeTopic = `$aws/things/thing_${vin}/shadow/name/CHARGEMANAGEMENT_TARGETCHARGELEVEL_ASYNC/update`;
        await new Promise((resolve, reject) => {
          awsClient.subscribe(chargeTopic, { qos: 1 }, (err) => {
            if (err) reject(err);
            else {
              debug(`Subscribed to: ${chargeTopic}`);
              resolve();
            }
          });
        });

        // POST the set target charge level request
        const reqId = await requestSetTargetChargeLevel(
          accessToken,
          vin,
          level
        );

        // Wait for SUCCESS on the MQTT topic
        const success = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(
              new Error(
                `Timed out waiting for charge level confirmation (${verifyTimeout / 1000}s)`
              )
            );
          }, verifyTimeout);

          awsClient.on("message", (topic, message) => {
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
                resolve(true);
              } else if (
                reported.status !== "IN_PROGRESS" &&
                reported.status !== "PENDING"
              ) {
                clearTimeout(timeout);
                reject(
                  new Error(
                    `Set target charge failed with status: ${reported.status}`
                  )
                );
              }
            } catch {
              // ignore parse errors
            }
          });
        });

        if (success) {
          log(`Target charge level set to ${level}% (confirmed by vehicle)`);
          return true;
        }
      } finally {
        awsClient.end(true);
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

module.exports = { setTargetChargeLevel };
