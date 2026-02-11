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

module.exports = { CONFIG, log, debug };
