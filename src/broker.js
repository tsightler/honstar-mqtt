const mqtt = require("mqtt");
const { log, debug } = require("./config");

function connectBroker(mqttUrl) {
  return new Promise((resolve, reject) => {
    log(`Connecting to MQTT broker...`);
    debug(`Broker URL: ${mqttUrl.replace(/\/\/.*@/, "//***@")}`);

    const client = mqtt.connect(mqttUrl, {
      clientId: `acura-ev-${Date.now()}`,
      clean: true,
      keepalive: 60,
      reconnectPeriod: 5000,
    });

    client.on("connect", () => {
      log("Connected to MQTT broker");
      resolve(client);
    });

    client.on("reconnect", () => {
      debug("Reconnecting to MQTT broker...");
    });

    client.on("error", (err) => {
      log(`MQTT broker error: ${err.message}`);
    });

    client.on("offline", () => {
      debug("MQTT broker connection offline");
    });

    // Timeout initial connection after 30 seconds
    setTimeout(() => {
      if (!client.connected) {
        client.end(true);
        reject(new Error("MQTT broker connection timed out after 30s"));
      }
    }, 30000);
  });
}

function publishData(brokerClient, vin, dashboard) {
  const topic = `acura-ev/${vin}/data`;
  const payload = JSON.stringify(dashboard);
  brokerClient.publish(topic, payload, { retain: true, qos: 1 }, (err) => {
    if (err) {
      log(`Failed to publish to ${topic}: ${err.message}`);
    } else {
      log(`Published dashboard data to ${topic}`);
    }
  });
}

module.exports = { connectBroker, publishData };
