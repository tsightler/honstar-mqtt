#!/usr/bin/env node

/**
 * Acura EV Connect - MQTT Gateway
 *
 * Authenticates to the Acura EV connected vehicle services,
 * polls vehicle dashboard status on a configurable interval,
 * and publishes the data to an MQTT broker.
 *
 * Can run standalone, as a Docker container, or as a Home Assistant addon.
 *
 * Flow (each poll cycle):
 *   1. Register client → get client_reg_key
 *   2. Login with credentials → get access_token
 *   3. Get vehicle list → get VIN
 *   4. Get CIG token → get JWT + signature for MQTT auth
 *   5. Connect MQTT over WebSocket to AWS IoT (custom authorizer)
 *   6. Subscribe to vehicle shadow topic (DASHBOARD_ASYNC)
 *   7. POST async dashboard request
 *   8. Receive dashboard data over MQTT
 *   9. Publish parsed data to user's MQTT broker
 */

require("dotenv/config");
const mqtt = require("mqtt");
const { v4: uuidv4 } = require("uuid");

// ─── Configuration ───────────────────────────────────────────────────────────

const CONFIG = {
  // Honda Identity Service (HIDAS)
  identityHost: "https://identity.services.honda.com",
  clientId: "AcuraEVAndroidAppPrOd0083",
  clientSecret: "q4w5hzeqkFVMPQaeKuil",

  // Honda Web Services
  wscHost: "https://wsc.hondaweb.com",

  // AWS IoT MQTT endpoint
  mqttHost: "am7ptks1rwalc-ats.iot.us-east-2.amazonaws.com",
  mqttAuthorizerName: "CPSD-IOT-CustAuthorizer-prod",

  // Common headers
  commonHeaders: {
    "hondaHeaderType.country_code": "US",
    "hondaHeaderType.language_code": "en",
    "hondaHeaderType.businessId": "ACURA EV",
    "User-Agent": "okhttp/4.12.0",
  },

  // Dashboard filters - all the data points to request
  dashboardFilters: [
    "DigitalTwin",
    "EV BATTERY LEVEL",
    "EV CHARGE STATE",
    "EV PLUG STATE",
    "EV PLUG VOLTAGE",
    "GET COMMUTE SCHEDULE",
    "HIGH VOLTAGE BATTERY PRECONDITIONING STATUS",
    "VEHICLE RANGE",
    "odometer",
    "tireStatus",
    "HV BATTERY CHARGE COMPLETE TIME",
    "TARGET CHARGE LEVEL SETTINGS",
    "GET CHARGE MODE",
    "CABIN PRECONDITIONING TEMP CUSTOM SETTING",
    "CHARGER POWER LEVEL",
    "HANDS FREE CALLING",
    "ENERGY EFFICIENCY",
  ],
};

// ─── Logging ─────────────────────────────────────────────────────────────────

const DEBUG = ["true", "1", "yes"].includes(
  (process.env.DEBUG || "").toLowerCase()
);

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function debug(msg) {
  if (DEBUG) log(`[DEBUG] ${msg}`);
}

// ─── HTTP Helper ─────────────────────────────────────────────────────────────

async function request(url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: {
      ...CONFIG.commonHeaders,
      ...options.headers,
    },
  });

  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!resp.ok && resp.status !== 101) {
    throw new Error(
      `HTTP ${resp.status} ${resp.statusText}: ${JSON.stringify(data)}`
    );
  }

  return data;
}

// ─── Step 1: Register Client ─────────────────────────────────────────────────

async function registerClient() {
  log("Registering client...");
  const body = `client_id=${CONFIG.clientId}&client_secret=${CONFIG.clientSecret}`;

  const data = await request(
    `${CONFIG.identityHost}/hidas/rs/client/register`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }
  );

  const key = data.clientregistrationkey?.client_reg_key;
  if (!key) throw new Error("Failed to get client_reg_key");
  debug(`client_reg_key: ${key}`);
  return key;
}

// ─── Step 2: Generate Token (Login) ──────────────────────────────────────────

async function generateToken(clientRegKey, username, password) {
  log("Authenticating...");
  const body = new URLSearchParams({
    client_reg_key: clientRegKey,
    device_description: "NodeJS_AcuraEV_Client",
    username,
    password,
  }).toString();

  const data = await request(
    `${CONFIG.identityHost}/hidas/rs/token/generate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }
  );

  if (data.request_status !== "success") {
    throw new Error(`Auth failed: ${JSON.stringify(data)}`);
  }

  const token = data.token.access_token;
  const hidasIdent = data.user.hidas_ident;
  log(
    `Authenticated as ${data.user.first_name} ${data.user.last_name}`
  );
  debug(`access_token: ${token.substring(0, 10)}...`);
  debug(`hidas_ident: ${hidasIdent}`);
  return { accessToken: token, hidasIdent, user: data.user };
}

// ─── Step 3: Get Vehicle List ────────────────────────────────────────────────

async function getVehicles(accessToken, hidasIdent) {
  log("Fetching vehicles...");

  const data = await request(`${CONFIG.wscHost}/REST/NGT/MyVehicle/1.0`, {
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "hondaHeaderType.version": "2.0",
      "hondaHeaderType.siteId": "00e0e97f0fb543208a918fc946dea334",
      "hondaHeaderType.messageId": uuidv4(),
      "hondaHeaderType.systemId": "com.honda.dealer.cv_android",
      "hondaHeaderType.userId": hidasIdent,
      "hondaHeaderType.clientType": "Mobile",
      "hondaHeaderType.collectedTimeStamp": new Date().toISOString(),
    },
  });

  if (data.status !== "SUCCESS" || !data.vehicleInfo?.length) {
    throw new Error(`No vehicles found: ${JSON.stringify(data)}`);
  }

  const vehicles = data.vehicleInfo;
  for (const v of vehicles) {
    log(
      `Found vehicle: ${v.ModelYear} ${v.DivisionName} ${v.ModelCode} (${v.VIN})`
    );
  }
  return vehicles;
}

// ─── Step 4: Get CIG Token (for MQTT auth) ───────────────────────────────────

async function getCigToken(accessToken, hidasIdent, vin) {
  debug("Getting CIG token for MQTT...");

  const data = await request(
    `${CONFIG.wscHost}/REST/CIG/services/1.0/token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "hondaHeaderType.userId": hidasIdent,
        "hondaHeaderType.hidasId": hidasIdent,
        "hondaHeaderType.version": "1.0",
        "hondaHeaderType.messageId": uuidv4().toUpperCase(),
        "hondaHeaderType.clientType": "Mobile",
        "hondaHeaderType.systemId": "com.honda.hondalink.cv_android",
        "hondaHeaderType.siteId": "b407a3025b374f668475e97d2e750816",
        "hondaHeaderType.collectedTimeStamp": new Date().toISOString(),
      },
      body: JSON.stringify({ device: vin }),
    }
  );

  if (data.status !== "Success") {
    throw new Error(`CIG token failed: ${JSON.stringify(data)}`);
  }

  const { token, tokenSignature } = data.responseBody;
  debug(`CIG JWT: ${token.substring(0, 40)}...`);
  return { cigToken: token, cigSignature: tokenSignature };
}

// ─── Step 5 & 6: Connect AWS IoT MQTT and Subscribe ─────────────────────────

function connectAwsMqtt(vin, cigToken, cigSignature) {
  return new Promise((resolve, reject) => {
    debug("Connecting to AWS IoT MQTT...");

    const topic = `$aws/things/thing_${vin}/shadow/name/DASHBOARD_ASYNC/update`;
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
      client.subscribe(topic, { qos: 1 }, (err) => {
        if (err) {
          reject(err);
        } else {
          debug(`Subscribed to: ${topic}`);
          resolve(client);
        }
      });
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

// ─── Step 7: Request Dashboard Data ──────────────────────────────────────────

async function requestDashboard(
  accessToken,
  vin,
  { maxRetries = 5, retryDelay = 5000, cancelSignal = null } = {}
) {
  debug("Requesting dashboard data (async)...");

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (cancelSignal?.cancelled) return null;

    try {
      const resp = await fetch(`${CONFIG.wscHost}/REST/NGT/CIG/dbd/async`, {
        method: "POST",
        headers: {
          ...CONFIG.commonHeaders,
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          "hondaHeaderType.version": "1.0",
          "hondaHeaderType.siteId": "18d216af12884813987e6b7f75a005a1",
          "hondaHeaderType.systemId": "com.honda.hondalink.cv_android",
          "hondaHeaderType.clientType": "Mobile",
          "hondaHeaderType.messageId": "I-13",
          "hondaHeaderType.collectedTimeStamp": new Date().toISOString(),
        },
        body: JSON.stringify({
          device: vin,
          filters: CONFIG.dashboardFilters,
        }),
      });

      const data = await resp.json();

      if (resp.ok && data.status === "success") {
        debug(`Request ID: ${data.responseBody.cigServiceRequestId}`);
        return data.responseBody.cigServiceRequestId;
      }

      const errMsg =
        data.responseBody?.errorMessage || data.status || resp.statusText;
      log(
        `Dashboard request attempt ${attempt}/${maxRetries} failed (HTTP ${resp.status}): ${errMsg}`
      );
    } catch (err) {
      log(
        `Dashboard request attempt ${attempt}/${maxRetries} error: ${err.message}`
      );
    }

    if (attempt < maxRetries) {
      if (cancelSignal?.cancelled) return null;
      await new Promise((r) => setTimeout(r, retryDelay));
    }
  }

  throw new Error(`Dashboard request failed after ${maxRetries} attempts`);
}

// ─── Dashboard Data Parser ───────────────────────────────────────────────────

function parseDashboard(payload) {
  try {
    const data = JSON.parse(payload);
    const reported = data.state?.reported;
    if (!reported) return null;

    const rb = reported.responseBody;
    if (!rb) return null;

    const result = {
      timestamp: rb.timestamp,
      requestId: reported.cigServiceRequestId,
      status: reported.status,
    };

    // EV Status
    if (rb.evStatus) {
      result.battery = {
        stateOfCharge: rb.evStatus.soc,
        range: rb.evStatus.evRange,
        rangeUnit: "miles",
        chargeStatus: rb.evStatus.chargeStatus,
        plugStatus: rb.evStatus.plugStatus,
        chargeMode: rb.evStatus.chargeMode,
      };
    }

    // Odometer
    if (rb.odometer) {
      result.odometer = {
        value: rb.odometer.value,
        unit: rb.odometer.unit,
      };
    }

    // Tire Pressures
    if (rb.tireStatus) {
      const kpaToPsi = (kpa) =>
        parseFloat((parseFloat(kpa) * 0.145038).toFixed(1));
      result.tires = {};
      for (const [pos, tireData] of Object.entries(rb.tireStatus)) {
        if (tireData.pressureData) {
          result.tires[pos] = {
            pressurePsi: kpaToPsi(tireData.pressureData.value),
            pressureKpa: parseFloat(tireData.pressureData.value),
            warning: tireData.warningState?.value || "unknown",
          };
        }
      }
    }

    // Charge settings
    if (rb.getChargeMode) {
      result.chargeSettings = {
        type: rb.getChargeMode.chargeModeType?.value,
        targetLevel: rb.getChargeMode.generalAwayTargetChargeLevel?.value
          ? parseFloat(rb.getChargeMode.generalAwayTargetChargeLevel.value)
          : undefined,
        cabinPreconditioning: rb.getChargeMode.cabinPrecondRequest?.value,
      };
    }

    // Estimated range at target charge level
    if (
      rb.targetChargeLevelSettings
        ?.projectedEVRangeGeneralAwayTargetChargeSet
    ) {
      const proj =
        rb.targetChargeLevelSettings
          .projectedEVRangeGeneralAwayTargetChargeSet;
      result.projectedRangeAtTarget = {
        value: parseFloat(proj.value),
        unit: proj.unit,
      };
    }

    // Charge complete time
    if (rb.hvBatteryChargeCompleteTime) {
      const ct = rb.hvBatteryChargeCompleteTime;
      result.chargeCompleteTime = {
        day: ct.hvBatteryChargeCompleteDay?.value,
        hour: ct.hvBatteryChargeCompleteHour?.value,
        minute: ct.hvBatteryChargeCompleteMinute?.value,
      };
    }

    // HV Battery Preconditioning
    if (rb.highVoltageBatteryPreconditioningStatus) {
      result.hvBatteryPreconditioning =
        rb.highVoltageBatteryPreconditioningStatus.value;
    }

    return result;
  } catch (err) {
    log(`Failed to parse dashboard: ${err.message}`);
    return null;
  }
}

// ─── Pretty Print ────────────────────────────────────────────────────────────

function printDashboard(dashboard) {
  console.log("\n" + "=".repeat(60));
  console.log("  VEHICLE DASHBOARD STATUS");
  console.log("=".repeat(60));
  console.log(`  Timestamp:  ${dashboard.timestamp}`);
  console.log(`  Status:     ${dashboard.status}`);

  if (dashboard.battery) {
    console.log("\n  BATTERY & CHARGING");
    console.log(`     Charge:        ${dashboard.battery.stateOfCharge}%`);
    console.log(
      `     Range:         ${dashboard.battery.range} ${dashboard.battery.rangeUnit}`
    );
    console.log(`     Charge Status: ${dashboard.battery.chargeStatus}`);
    console.log(`     Plug Status:   ${dashboard.battery.plugStatus}`);
  }

  if (dashboard.odometer) {
    console.log(
      `\n  ODOMETER: ${dashboard.odometer.value} ${dashboard.odometer.unit}`
    );
  }

  if (dashboard.tires) {
    console.log("\n  TIRE PRESSURES");
    for (const [pos, data] of Object.entries(dashboard.tires)) {
      const name = pos.replace(/([A-Z])/g, " $1").trim();
      console.log(
        `     ${name.padEnd(16)} ${data.pressurePsi} PSI (${data.pressureKpa} kPa)  (${data.warning})`
      );
    }
  }

  if (dashboard.chargeSettings) {
    console.log("\n  CHARGE SETTINGS");
    console.log(`     Mode:          ${dashboard.chargeSettings.type}`);
    console.log(`     Target Level:  ${dashboard.chargeSettings.targetLevel}%`);
    console.log(
      `     Cabin Precond: ${dashboard.chargeSettings.cabinPreconditioning}`
    );
  }

  if (dashboard.projectedRangeAtTarget) {
    console.log(
      `     Est. Range at Target: ${dashboard.projectedRangeAtTarget.value} ${dashboard.projectedRangeAtTarget.unit}`
    );
  }

  if (dashboard.chargeCompleteTime?.day) {
    const ct = dashboard.chargeCompleteTime;
    console.log(
      `     Charge Complete: ${ct.day} ${ct.hour}:${String(ct.minute).padStart(2, "0")}`
    );
  }

  console.log("\n" + "=".repeat(60));
}

// ─── Home Assistant MQTT Discovery ───────────────────────────────────────────

// Map Acura tire position keys to friendly names and Onstar2MQTT-style slugs
const TIRE_POSITIONS = {
  leftFront:  { slug: "tire_pressure_lf", name: "Tire Pressure: Left Front" },
  rightFront: { slug: "tire_pressure_rf", name: "Tire Pressure: Right Front" },
  leftRear:   { slug: "tire_pressure_lr", name: "Tire Pressure: Left Rear" },
  rightRear:  { slug: "tire_pressure_rr", name: "Tire Pressure: Right Rear" },
};

function buildDeviceInfo(vin, vehicle) {
  return {
    identifiers: [vin],
    manufacturer: vehicle?.DivisionName || "Acura",
    model: [vehicle?.ModelYear, vehicle?.DivisionName, vehicle?.ModelCode]
      .filter(Boolean)
      .join(" "),
    name: [vehicle?.ModelYear, vehicle?.DivisionName, vehicle?.ModelCode]
      .filter(Boolean)
      .join(" "),
  };
}

function publishDiscovery(brokerClient, vin, vehicle) {
  const device = buildDeviceInfo(vin, vehicle);
  const availTopic = `homeassistant/${vin}/available`;
  const opts = { retain: true, qos: 1 };

  function pub(component, slug, config) {
    const topic = `homeassistant/${component}/${vin}/${slug}/config`;
    const payload = JSON.stringify({
      ...config,
      unique_id: `${vin}-${slug}`,
      availability_topic: availTopic,
      payload_available: "true",
      payload_not_available: "false",
      device,
    });
    brokerClient.publish(topic, payload, opts);
    debug(`Discovery: ${topic}`);
  }

  // ── Sensors ──

  // State of Charge (battery %)
  pub("sensor", "ev_battery_level", {
    name: "EV Battery Level",
    device_class: "battery",
    state_class: "measurement",
    unit_of_measurement: "%",
    icon: "mdi:battery-high",
    state_topic: `homeassistant/sensor/${vin}/ev_battery_level/state`,
    value_template: "{{ value_json.ev_battery_level }}",
  });

  // EV Range
  pub("sensor", "ev_range", {
    name: "EV Range",
    device_class: "distance",
    state_class: "measurement",
    unit_of_measurement: "mi",
    icon: "mdi:ev-station",
    state_topic: `homeassistant/sensor/${vin}/ev_range/state`,
    value_template: "{{ value_json.ev_range }}",
  });

  // Odometer
  pub("sensor", "odometer", {
    name: "Odometer",
    device_class: "distance",
    state_class: "total_increasing",
    unit_of_measurement: "mi",
    icon: "mdi:counter",
    state_topic: `homeassistant/sensor/${vin}/odometer/state`,
    value_template: "{{ value_json.odometer }}",
  });

  // Tire pressures (4 sensors)
  for (const [, tp] of Object.entries(TIRE_POSITIONS)) {
    pub("sensor", tp.slug, {
      name: tp.name,
      device_class: "pressure",
      state_class: "measurement",
      unit_of_measurement: "psi",
      icon: "mdi:car-tire-alert",
      state_topic: `homeassistant/sensor/${vin}/tire_pressure/state`,
      value_template: `{{ value_json.${tp.slug} }}`,
      json_attributes_topic: `homeassistant/sensor/${vin}/tire_pressure/state`,
      json_attributes_template: `{{ {'warning': value_json.${tp.slug}_warning} | tojson }}`,
    });
  }

  // ── Binary Sensors ──

  // EV Charge State (charging / not charging)
  pub("binary_sensor", "ev_charge_state", {
    name: "EV Charge State",
    device_class: "battery_charging",
    icon: "mdi:battery-charging",
    payload_on: true,
    payload_off: false,
    state_topic: `homeassistant/binary_sensor/${vin}/ev_charge_state/state`,
    value_template: "{{ value_json.ev_charge_state }}",
  });

  // EV Plug State (plugged / unplugged)
  pub("binary_sensor", "ev_plug_state", {
    name: "EV Plug State",
    device_class: "plug",
    icon: "mdi:ev-plug-type1",
    payload_on: true,
    payload_off: false,
    state_topic: `homeassistant/binary_sensor/${vin}/ev_plug_state/state`,
    value_template: "{{ value_json.ev_plug_state }}",
  });

  log("Published HA MQTT discovery configs");
}

function publishAvailability(brokerClient, vin, available) {
  brokerClient.publish(
    `homeassistant/${vin}/available`,
    available ? "true" : "false",
    { retain: true, qos: 1 }
  );
}

function publishStates(brokerClient, vin, dashboard) {
  const opts = { retain: true, qos: 1 };

  // Battery level
  if (dashboard.battery?.stateOfCharge != null) {
    brokerClient.publish(
      `homeassistant/sensor/${vin}/ev_battery_level/state`,
      JSON.stringify({ ev_battery_level: dashboard.battery.stateOfCharge }),
      opts
    );
  }

  // EV Range
  if (dashboard.battery?.range != null) {
    brokerClient.publish(
      `homeassistant/sensor/${vin}/ev_range/state`,
      JSON.stringify({ ev_range: dashboard.battery.range }),
      opts
    );
  }

  // Odometer
  if (dashboard.odometer?.value != null) {
    brokerClient.publish(
      `homeassistant/sensor/${vin}/odometer/state`,
      JSON.stringify({ odometer: dashboard.odometer.value }),
      opts
    );
  }

  // Charge state → binary (Onstar2MQTT mapping)
  if (dashboard.battery?.chargeStatus != null) {
    const raw = dashboard.battery.chargeStatus;
    const charging =
      raw === "charging" ||
      raw === "CHARGING" ||
      raw === "ACTIVE" ||
      raw === "connected_charging";
    brokerClient.publish(
      `homeassistant/binary_sensor/${vin}/ev_charge_state/state`,
      JSON.stringify({ ev_charge_state: charging }),
      opts
    );
  }

  // Plug state → binary (Onstar2MQTT mapping)
  if (dashboard.battery?.plugStatus != null) {
    const raw = dashboard.battery.plugStatus;
    const plugged =
      raw === "plugged" ||
      raw === "CONNECT" ||
      raw === "CONNECTED" ||
      raw === "connected";
    brokerClient.publish(
      `homeassistant/binary_sensor/${vin}/ev_plug_state/state`,
      JSON.stringify({ ev_plug_state: plugged }),
      opts
    );
  }

  // Tire pressures (single state topic with all 4 values)
  if (dashboard.tires) {
    const tireState = {};
    for (const [pos, data] of Object.entries(dashboard.tires)) {
      const tp = TIRE_POSITIONS[pos];
      if (tp) {
        tireState[tp.slug] = data.pressurePsi;
        tireState[`${tp.slug}_warning`] = data.warning;
      }
    }
    brokerClient.publish(
      `homeassistant/sensor/${vin}/tire_pressure/state`,
      JSON.stringify(tireState),
      opts
    );
  }

  log("Published HA entity states");
}

// ─── User MQTT Broker ────────────────────────────────────────────────────────

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

// ─── Poll Cycle ──────────────────────────────────────────────────────────────

async function pollOnce(accessToken, hidasIdent, vin) {
  // Step 4: Get CIG token
  const { cigToken, cigSignature } = await getCigToken(
    accessToken,
    hidasIdent,
    vin
  );

  // Step 5 & 6: Connect AWS IoT MQTT and subscribe
  const awsClient = await connectAwsMqtt(vin, cigToken, cigSignature);

  try {
    const cancelSignal = { cancelled: false };

    // Wait for dashboard data via MQTT
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

    // Step 7: Request dashboard data
    await requestDashboard(accessToken, vin, { cancelSignal });

    // If not received yet, re-request periodically
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
    // Always disconnect AWS IoT MQTT after poll
    awsClient.end(true);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const username = process.env.ACURA_USERNAME || process.argv[2];
  const password = process.env.ACURA_PASSWORD || process.argv[3];
  const targetVin = process.env.ACURA_VIN || process.argv[4];
  const mqttUrl = process.env.MQTT_URL;
  const pollInterval =
    parseInt(process.env.POLL_INTERVAL, 10) || 900;

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

  // Graceful shutdown
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    log("Shutting down...");

    if (pollTimer) clearInterval(pollTimer);

    if (brokerClient) {
      if (vin) {
        publishAvailability(brokerClient, vin, false);
        brokerClient.publish(
          `acura-ev/${vin}/status`,
          "offline",
          { retain: true, qos: 1 }
        );
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

        brokerClient.publish(`acura-ev/${vin}/status`, "online", {
          retain: true,
          qos: 1,
        });
      } else {
        log("No dashboard data received");
      }
    } catch (err) {
      log(`Poll failed: ${err.message}`);

      // If it looks like an auth error, try to re-authenticate
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
