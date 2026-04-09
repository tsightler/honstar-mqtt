const mqtt = require("mqtt");
const { CONFIG, log, debug } = require("./config");
const { getCigToken } = require("./api");

// Persistent connection state
let client = null;
let connectingPromise = null;
let getCredentials = null;

// Deadline-based connection lifecycle
let connectionDeadline = 0;
let deadlineTimer = null;

function extendConnectionDeadline(ms) {
  const newDeadline = Date.now() + ms;
  if (newDeadline <= connectionDeadline) return; // existing deadline is later
  connectionDeadline = newDeadline;
  if (deadlineTimer) clearTimeout(deadlineTimer);
  deadlineTimer = setTimeout(() => {
    if (client && Date.now() >= connectionDeadline) {
      debug("Closing MQTT connection (deadline reached)");
      client.end(true);
      client = null;
    }
    deadlineTimer = null;
  }, ms);
}

function initAwsMqtt(credentialsGetter) {
  getCredentials = credentialsGetter;
}

async function getAwsClient() {
  if (client && client.connected) {
    return client;
  }

  // If a connection attempt is already in progress, wait for it
  if (connectingPromise) {
    await connectingPromise;
    return client;
  }

  connectingPromise = (async () => {
    try {
      const { accessToken, hidasIdent, vin } = getCredentials();
      const { cigToken, cigSignature } = await getCigToken(
        accessToken,
        hidasIdent,
        vin
      );

      debug("Connecting to AWS IoT MQTT...");

      const clientId = `paho${Date.now()}`;
      const wsUrl = `wss://${CONFIG.mqttHost}/mqtt`;

      const newClient = mqtt.connect(wsUrl, {
        clientId,
        protocolVersion: 4,
        clean: true,
        keepalive: 300,
        reconnectPeriod: 0,
        wsOptions: {
          headers: {
            "User-Agent": "?SDK=Android&Version=2.75.0",
            "X-Amz-CustomAuthorizer-Signature": cigSignature,
            prod_key: cigToken,
            "X-Amz-CustomAuthorizer-Name": CONFIG.mqttAuthorizerName,
          },
          protocolVersion: 13,
          protocol: "mqtt",
        },
        protocolId: "MQTT",
        transformWsUrl: (url, options, client) => url,
      });

      await new Promise((resolve, reject) => {
        newClient.on("connect", () => {
          debug("AWS IoT MQTT connected");
          resolve();
        });

        newClient.on("error", (err) => {
          debug(`AWS IoT MQTT error: ${err.message}`);
          reject(err);
        });

        setTimeout(() => {
          if (!newClient.connected) {
            newClient.end(true);
            reject(new Error("AWS IoT MQTT connection timed out after 15s"));
          }
        }, 15000);
      });

      newClient.on("close", () => {
        debug("AWS IoT MQTT connection closed");
        if (client === newClient) {
          client = null;
          if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
          connectionDeadline = 0;
        }
      });

      newClient.on("offline", () => {
        debug("AWS IoT MQTT connection offline");
        if (client === newClient) {
          client = null;
          if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
          connectionDeadline = 0;
        }
      });

      // Subscribe to all shadow update topics for this VIN
      const shadowWildcard = `$aws/things/thing_${vin}/shadow/name/+/update`;
      await new Promise((resolve, reject) => {
        newClient.subscribe(shadowWildcard, { qos: 1 }, (err) => {
          if (err) reject(err);
          else {
            debug(`Subscribed to: ${shadowWildcard}`);
            resolve();
          }
        });
      });

      client = newClient;
      return client;
    } finally {
      connectingPromise = null;
    }
  })();

  return connectingPromise;
}

function closeAwsMqtt() {
  if (deadlineTimer) {
    clearTimeout(deadlineTimer);
    deadlineTimer = null;
  }
  connectionDeadline = 0;
  if (client) {
    client.end(true);
    client = null;
  }
  connectingPromise = null;
}

module.exports = { initAwsMqtt, getAwsClient, extendConnectionDeadline, closeAwsMqtt };
