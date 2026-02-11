#!/usr/bin/env node

/**
 * Acura EV Connect - Node.js Client
 *
 * Authenticates to the Acura EV connected vehicle services,
 * establishes an MQTT WebSocket connection to AWS IoT, and
 * retrieves vehicle dashboard status (battery, range, tires, etc.)
 *
 * Flow:
 *   1. Register client → get client_reg_key
 *   2. Login with credentials → get access_token
 *   3. Get vehicle list → get VIN
 *   4. Get CIG token → get JWT + signature for MQTT auth
 *   5. Connect MQTT over WebSocket to AWS IoT (custom authorizer)
 *   6. Subscribe to vehicle shadow topic (DASHBOARD_ASYNC)
 *   7. POST async dashboard request
 *   8. Receive dashboard data over MQTT
 */

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
  console.log("\n[1/7] Registering client...");
  const body = `client_id=${CONFIG.clientId}&client_secret=${CONFIG.clientSecret}`;

  const data = await request(`${CONFIG.identityHost}/hidas/rs/client/register`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const key = data.clientregistrationkey?.client_reg_key;
  if (!key) throw new Error("Failed to get client_reg_key");
  console.log(`  ✓ client_reg_key: ${key}`);
  return key;
}

// ─── Step 2: Generate Token (Login) ──────────────────────────────────────────

async function generateToken(clientRegKey, username, password) {
  console.log("[2/7] Authenticating...");
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
  console.log(`  ✓ access_token: ${token.substring(0, 10)}...`);
  console.log(`  ✓ hidas_ident: ${hidasIdent}`);
  console.log(`  ✓ user: ${data.user.first_name} ${data.user.last_name}`);
  return { accessToken: token, hidasIdent, user: data.user };
}

// ─── Step 3: Get Vehicle List ────────────────────────────────────────────────

async function getVehicles(accessToken, hidasIdent) {
  console.log("[3/7] Fetching vehicles...");

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
    console.log(`  ✓ ${v.ModelYear} ${v.DivisionName} ${v.ModelCode} (${v.VIN})`);
    console.log(`    Color: ${v.ExteriorMarketingColorCode}`);
    console.log(`    Platform: ${v.TelematicsPlatform}`);
  }
  return vehicles;
}

// ─── Step 4: Get CIG Token (for MQTT auth) ───────────────────────────────────

async function getCigToken(accessToken, hidasIdent, vin) {
  console.log("[4/7] Getting CIG token for MQTT...");

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
  console.log(`  ✓ CIG JWT: ${token.substring(0, 40)}...`);
  console.log(`  ✓ Signature: ${tokenSignature.substring(0, 40)}...`);
  return { cigToken: token, cigSignature: tokenSignature };
}

// ─── Step 5 & 6: Connect MQTT and Subscribe ──────────────────────────────────

function connectMqtt(vin, cigToken, cigSignature) {
  return new Promise((resolve, reject) => {
    console.log("[5/7] Connecting to MQTT over WebSocket...");

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
      console.log("  ✓ MQTT connected!");
      console.log(`[6/7] Subscribing to: ${topic}`);
      client.subscribe(topic, { qos: 1 }, (err) => {
        if (err) {
          reject(err);
        } else {
          console.log("  ✓ Subscribed!");
          resolve(client);
        }
      });
    });

    client.on("error", (err) => {
      console.error("  ✗ MQTT error:", err.message);
      reject(err);
    });

    client.on("close", () => {
      console.log("  MQTT connection closed");
    });

    // Timeout after 15 seconds
    setTimeout(() => {
      if (!client.connected) {
        client.end(true);
        reject(new Error("MQTT connection timed out after 15s"));
      }
    }, 15000);
  });
}

// ─── Step 7: Request Dashboard Data ──────────────────────────────────────────

async function requestDashboard(accessToken, vin, { maxRetries = 5, retryDelay = 5000, silent = false, cancelSignal = null } = {}) {
  if (!silent) console.log("[7/7] Requesting dashboard data (async)...");

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Stop retrying if we already got what we need
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
        console.log(`  ✓ Request ID: ${data.responseBody.cigServiceRequestId}`);
        return data.responseBody.cigServiceRequestId;
      }

      // Server error (500, etc.) — retry
      const errMsg = data.responseBody?.errorMessage || data.status || resp.statusText;
      console.log(`  ⚠ Attempt ${attempt}/${maxRetries} failed (HTTP ${resp.status}): ${errMsg}`);
    } catch (err) {
      console.log(`  ⚠ Attempt ${attempt}/${maxRetries} error: ${err.message}`);
    }

    if (attempt < maxRetries) {
      if (cancelSignal?.cancelled) return null;
      console.log(`     Retrying in ${retryDelay / 1000}s...`);
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
        stateOfCharge: `${rb.evStatus.soc}%`,
        range: `${rb.evStatus.evRange} miles`,
        chargeStatus: rb.evStatus.chargeStatus,
        plugStatus: rb.evStatus.plugStatus,
        chargeMode: rb.evStatus.chargeMode,
      };
    }

    // Odometer
    if (rb.odometer) {
      result.odometer = `${rb.odometer.value} ${rb.odometer.unit}`;
    }

    // Tire Pressures
    if (rb.tireStatus) {
      const kpaToPsi = (kpa) => (parseFloat(kpa) * 0.145038).toFixed(1);
      result.tires = {};
      for (const [pos, data] of Object.entries(rb.tireStatus)) {
        if (data.pressureData) {
          result.tires[pos] = {
            pressure: `${kpaToPsi(data.pressureData.value)} PSI (${data.pressureData.value} kPa)`,
            warning: data.warningState?.value || "unknown",
          };
        }
      }
    }

    // Charge settings
    if (rb.getChargeMode) {
      result.chargeMode = {
        type: rb.getChargeMode.chargeModeType?.value,
        targetLevel: rb.getChargeMode.generalAwayTargetChargeLevel?.value
          ? `${rb.getChargeMode.generalAwayTargetChargeLevel.value}%`
          : undefined,
        cabinPrecond: rb.getChargeMode.cabinPrecondRequest?.value,
      };
    }

    // Estimated range at target charge level
    if (rb.targetChargeLevelSettings?.projectedEVRangeGeneralAwayTargetChargeSet) {
      const proj = rb.targetChargeLevelSettings.projectedEVRangeGeneralAwayTargetChargeSet;
      result.projectedRangeAtTarget = `${proj.value} ${proj.unit}`;
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
    console.error("Failed to parse dashboard:", err.message);
    return null;
  }
}

// ─── Pretty Print ────────────────────────────────────────────────────────────

function printDashboard(dashboard) {
  console.log("\n" + "═".repeat(60));
  console.log("  VEHICLE DASHBOARD STATUS");
  console.log("═".repeat(60));
  console.log(`  Timestamp:  ${dashboard.timestamp}`);
  console.log(`  Status:     ${dashboard.status}`);

  if (dashboard.battery) {
    console.log("\n  ⚡ BATTERY & CHARGING");
    console.log(`     Charge:        ${dashboard.battery.stateOfCharge}`);
    console.log(`     Range:         ${dashboard.battery.range}`);
    console.log(`     Charge Status: ${dashboard.battery.chargeStatus}`);
    console.log(`     Plug Status:   ${dashboard.battery.plugStatus}`);
  }

  if (dashboard.odometer) {
    console.log(`\n  🔢 ODOMETER: ${dashboard.odometer}`);
  }

  if (dashboard.tires) {
    console.log("\n  🛞 TIRE PRESSURES");
    for (const [pos, data] of Object.entries(dashboard.tires)) {
      const name = pos.replace(/([A-Z])/g, " $1").trim();
      console.log(`     ${name.padEnd(16)} ${data.pressure}  (${data.warning})`);
    }
  }

  if (dashboard.chargeMode) {
    console.log("\n  🔌 CHARGE SETTINGS");
    console.log(`     Mode:         ${dashboard.chargeMode.type}`);
    console.log(`     Target Level: ${dashboard.chargeMode.targetLevel}`);
    console.log(`     Cabin Precond: ${dashboard.chargeMode.cabinPrecond}`);
  }

  if (dashboard.projectedRangeAtTarget) {
    console.log(`     Est. Range at Target: ${dashboard.projectedRangeAtTarget}`);
  }

  if (dashboard.chargeCompleteTime?.day) {
    const ct = dashboard.chargeCompleteTime;
    console.log(
      `     Charge Complete: ${ct.day} ${ct.hour}:${String(ct.minute).padStart(2, "0")}`
    );
  }

  console.log("\n" + "═".repeat(60));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Read credentials from environment or command line
  const username = process.env.ACURA_USERNAME || process.argv[2];
  const password = process.env.ACURA_PASSWORD || process.argv[3];
  const targetVin = process.env.ACURA_VIN || process.argv[4]; // Optional

  if (!username || !password) {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║           Acura EV Connect - Vehicle Status               ║
╚════════════════════════════════════════════════════════════╝

Usage:
  node index.js <email> <password> [vin]

Or set environment variables:
  ACURA_USERNAME=your@email.com
  ACURA_PASSWORD=yourpassword
  ACURA_VIN=YOUR_VIN          (optional, uses first vehicle)

Example:
  node index.js user@example.com mypassword
  ACURA_USERNAME=user@example.com ACURA_PASSWORD=pass node index.js
`);
    process.exit(1);
  }

  try {
    // Step 1: Register client
    const clientRegKey = await registerClient();

    // Step 2: Authenticate
    const { accessToken, hidasIdent } = await generateToken(
      clientRegKey,
      username,
      password
    );

    // Step 3: Get vehicles
    const vehicles = await getVehicles(accessToken, hidasIdent);
    const vin = targetVin || vehicles[0].VIN;
    console.log(`\n  Using VIN: ${vin}`);

    // Step 4: Get CIG token for MQTT
    const { cigToken, cigSignature } = await getCigToken(
      accessToken,
      hidasIdent,
      vin
    );

    // Step 5 & 6: Connect MQTT and subscribe
    const mqttClient = await connectMqtt(vin, cigToken, cigSignature);

    // Shared cancellation signal
    const cancelSignal = { cancelled: false };

    // Listen for dashboard messages
    let received = false;
    mqttClient.on("message", (topic, message) => {
      console.log(`\n  📨 Received MQTT message on: ${topic}`);
      const payload = message.toString();
      const dashboard = parseDashboard(payload);
      if (dashboard) {
        printDashboard(dashboard);
        if (!received) {
          received = true;
          cancelSignal.cancelled = true;
          console.log("  ✓ Done! Disconnecting...\n");
          mqttClient.end();
        }
      } else {
        console.log("  (Waiting for dashboard data...)");
      }
    });

    // Step 7: Request dashboard data (with retry)
    await requestDashboard(accessToken, vin, { cancelSignal });

    // If we already got data during the retry loop, we're done
    if (received) {
      process.exit(0);
    }

    // Otherwise wait for MQTT response, re-requesting periodically
    console.log("\n  ⏳ Waiting for dashboard data via MQTT...");
    console.log("     (Data arrives asynchronously from the vehicle)\n");

    const maxWait = 60000;
    const retryInterval = 10000;
    const startTime = Date.now();

    const retryTimer = setInterval(async () => {
      if (received) {
        clearInterval(retryTimer);
        return;
      }
      if (Date.now() - startTime > maxWait - retryInterval) {
        clearInterval(retryTimer);
        return;
      }
      console.log("  🔄 Re-requesting dashboard...");
      try {
        await requestDashboard(accessToken, vin, { maxRetries: 5, retryDelay: 5000, silent: true, cancelSignal });
      } catch (err) {
        console.log(`  ⚠ Retry cycle failed: ${err.message}`);
      }
    }, retryInterval);

    // Handle clean exit when MQTT delivers data
    mqttClient.on("close", () => {
      clearInterval(retryTimer);
      if (received) process.exit(0);
    });

    // Final timeout
    setTimeout(() => {
      clearInterval(retryTimer);
      if (!received) {
        console.log(
          "\n  ⏱ Timeout waiting for dashboard data."
        );
        console.log(
          "  This can happen if the vehicle is not reachable."
        );
        console.log(
          "  The vehicle must have cellular connectivity to respond.\n"
        );
        mqttClient.end();
        process.exit(1);
      }
    }, maxWait);
  } catch (err) {
    console.error(`\n  ✗ Error: ${err.message}\n`);
    process.exit(1);
  }
}

main();
