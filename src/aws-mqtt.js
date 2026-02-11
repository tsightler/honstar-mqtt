const mqtt = require("mqtt");
const { CONFIG, debug } = require("./config");

function connectAwsMqtt(vin, cigToken, cigSignature) {
  return new Promise((resolve, reject) => {
    debug("Connecting to AWS IoT MQTT...");

    const clientId = `paho${Date.now()}`;
    const wsUrl = `wss://${CONFIG.mqttHost}/mqtt`;

    const client = mqtt.connect(wsUrl, {
      clientId,
      protocolVersion: 4,
      clean: true,
      keepalive: 300,
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

    client.on("connect", () => {
      debug("AWS IoT MQTT connected");
      resolve(client);
    });

    client.on("error", (err) => {
      debug(`AWS IoT MQTT error: ${err.message}`);
      reject(err);
    });

    // Timeout after 15 seconds
    setTimeout(() => {
      if (!client.connected) {
        client.end(true);
        reject(new Error("AWS IoT MQTT connection timed out after 15s"));
      }
    }, 15000);
  });
}

function subscribeAwsTopic(awsClient, topic) {
  return new Promise((resolve, reject) => {
    awsClient.subscribe(topic, { qos: 1 }, (err) => {
      if (err) reject(err);
      else {
        debug(`Subscribed to: ${topic}`);
        resolve();
      }
    });
  });
}

module.exports = { connectAwsMqtt, subscribeAwsTopic };
