const { v4: uuidv4 } = require("uuid");
const { CONFIG, log, debug } = require("./config");

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

async function requestSetTargetChargeLevel(
  accessToken,
  vin,
  level,
  { maxRetries = 3, retryDelay = 5000 } = {}
) {
  log(`Requesting target charge level set to ${level}%...`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(
        `${CONFIG.wscHost}/REST/NGT/TargetChargeLevel/1.0`,
        {
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
            "hondaHeaderType.messageId": "S-1",
            "hondaHeaderType.collectedTimeStamp": new Date().toISOString(),
          },
          body: JSON.stringify({
            device: vin,
            targetChargeLevel: level,
          }),
        }
      );

      const data = await resp.json();

      if (
        resp.ok &&
        (data.status === "IN_PROGRESS" || data.status === "success")
      ) {
        const reqId = data.responseBody?.cigServiceRequestId;
        debug(`Set target charge request ID: ${reqId}`);
        return reqId;
      }

      const errMsg =
        data.responseBody?.errorMessage || data.status || resp.statusText;
      log(
        `Set target charge attempt ${attempt}/${maxRetries} failed (HTTP ${resp.status}): ${errMsg}`
      );
    } catch (err) {
      log(
        `Set target charge attempt ${attempt}/${maxRetries} error: ${err.message}`
      );
    }

    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, retryDelay));
    }
  }

  throw new Error(
    `Set target charge level failed after ${maxRetries} attempts`
  );
}

module.exports = {
  registerClient,
  generateToken,
  getVehicles,
  getCigToken,
  requestDashboard,
  requestSetTargetChargeLevel,
};
