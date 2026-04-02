const { log, debug } = require("./config");

function getBatteryCapacity(vehicle) {
  const model = vehicle?.ModelCode?.toUpperCase() || "";
  return model.includes("ZDX") ? 102 : 85;
}

const TIRE_POSITIONS = {
  frontLeft:  { slug: "tire_pressure_lf", placard: "placardFront" },
  frontRight: { slug: "tire_pressure_rf", placard: "placardFront" },
  rearLeft:   { slug: "tire_pressure_lr", placard: "placardRear" },
  rearRight:  { slug: "tire_pressure_rr", placard: "placardRear" },
};

const L2_MAX_KW = 11;

// Charge rate tracking state (persists across poll cycles)
const chargeState = {
  active: false,
  isDcfc: null,
  rollingAverage: null,
  locked: false,
  hadEnoughTime: false,
  lastSoc: null,
  lastIsoTime: null,
};

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function resolveChargeCompleteTime(ct, responseTimestamp) {
  const now = new Date(responseTimestamp);
  const targetDayIdx = DAYS.indexOf(ct.day);
  if (targetDayIdx === -1) return null;

  const hour = parseInt(ct.hour);
  const minute = parseInt(ct.minute);
  if (isNaN(hour) || isNaN(minute)) return null;

  const candidate = new Date(now);
  let daysAhead = targetDayIdx - candidate.getDay();
  if (daysAhead < 0) daysAhead += 7;

  candidate.setDate(candidate.getDate() + daysAhead);
  candidate.setHours(hour, minute, 0, 0);

  if (candidate <= now) candidate.setDate(candidate.getDate() + 7);

  return candidate.toISOString();
}

function publishAvailability(brokerClient, vin, available) {
  brokerClient.publish(
    `honstar-mqtt/${vin}/available`,
    available ? "true" : "false",
    { retain: true, qos: 1 }
  );
}

function publishStates(brokerClient, vin, dashboard, vehicle) {
  const opts = { retain: true, qos: 1 };

  if (dashboard.battery?.stateOfCharge != null) {
    brokerClient.publish(
      `honstar-mqtt/${vin}/ev_battery_level/state`,
      String(Math.round(dashboard.battery.stateOfCharge)),
      opts
    );
  }

  if (dashboard.battery?.range != null) {
    brokerClient.publish(
      `honstar-mqtt/${vin}/ev_range/state`,
      String(Math.round(dashboard.battery.range)),
      opts
    );
  }

  if (dashboard.odometer?.value != null) {
    brokerClient.publish(
      `honstar-mqtt/${vin}/odometer/state`,
      String(Math.round(dashboard.odometer.value)),
      opts
    );
  }

  if (dashboard.chargeSettings?.targetLevel != null) {
    brokerClient.publish(
      `honstar-mqtt/${vin}/ev_target_charge_level/state`,
      String(dashboard.chargeSettings.targetLevel),
      opts
    );
  }

  if (dashboard.battery?.chargeStatus != null) {
    const raw = dashboard.battery.chargeStatus;
    const charging =
      raw === "charging" ||
      raw === "CHARGING" ||
      raw === "ACTIVE" ||
      raw === "connected_charging" ||
      raw === "CONNECTION_CHARGING";
    brokerClient.publish(
      `honstar-mqtt/${vin}/ev_charge_state/state`,
      charging ? "ON" : "OFF",
      opts
    );

    if (charging) {
      // Initialize charge session on first charging poll
      if (!chargeState.active) {
        chargeState.active = true;
        chargeState.isDcfc = null;
        chargeState.rollingAverage = null;
        chargeState.locked = false;
        chargeState.hadEnoughTime = false;
        chargeState.lastSoc = null;
        chargeState.lastIsoTime = null;
        debug("Charge session started");
      }

      if (dashboard.chargeCompleteTime?.hour != null && dashboard.timestamp) {
        const isoTime = resolveChargeCompleteTime(dashboard.chargeCompleteTime, dashboard.timestamp);
        if (isoTime) {
          brokerClient.publish(
            `honstar-mqtt/${vin}/ev_charge_complete_time/state`,
            isoTime,
            opts
          );

          const capacity = getBatteryCapacity(vehicle);
          const currentSoc = parseFloat(dashboard.battery?.stateOfCharge);
          const targetSoc = parseFloat(dashboard.chargeSettings?.targetLevel);
          debug(`Charge rate calc: model=${vehicle?.ModelCode} capacity=${capacity}kWh soc=${currentSoc} target=${targetSoc}`);

          if (capacity && !isNaN(currentSoc) && !isNaN(targetSoc) && targetSoc > currentSoc) {
            const hoursRemaining = (new Date(isoTime) - new Date(dashboard.timestamp)) / 3600000;
            if (hoursRemaining > 0) {
              const rawKw = ((targetSoc - currentSoc) / 100) * capacity / hoursRemaining;

              // Detect charge type on first valid calculation
              if (chargeState.isDcfc === null) {
                const minutesRemaining = hoursRemaining * 60;
                chargeState.isDcfc = (targetSoc - currentSoc) > 5 && minutesRemaining < 10;
                debug(`Charge type detected: ${chargeState.isDcfc ? "DCFC" : "L1/L2"}`);
              }

              // Detect stale data: SOC and completion time unchanged from last cycle
              const staleData = chargeState.lastSoc !== null
                && currentSoc === chargeState.lastSoc
                && isoTime === chargeState.lastIsoTime;
              chargeState.lastSoc = currentSoc;
              chargeState.lastIsoTime = isoTime;

              if (staleData && chargeState.rollingAverage !== null) {
                debug("Stale SOC/ETA detected, holding charge rate");
              }

              let kw;
              if (chargeState.isDcfc) {
                // DCFC: report raw calculated rate
                kw = Math.round(rawKw);
              } else if (chargeState.locked || (staleData && chargeState.rollingAverage !== null)) {
                // L1/L2 locked: stale data or time remaining dropped below 30 min
                kw = Math.round(Math.min(chargeState.rollingAverage, L2_MAX_KW) * 10) / 10;
              } else {
                // L1/L2: rolling average with drift limiting
                if (chargeState.rollingAverage === null) {
                  chargeState.rollingAverage = rawKw;
                } else if (rawKw <= chargeState.rollingAverage * 1.5) {
                  // Drift max ±0.1 per poll cycle
                  const diff = rawKw - chargeState.rollingAverage;
                  chargeState.rollingAverage += Math.max(-0.1, Math.min(0.1, diff));
                }
                // If rawKw > 150% of average, sample is ignored (average unchanged)

                const minutesRemaining = hoursRemaining * 60;
                // Track whether we ever had >= 30 min remaining
                if (minutesRemaining >= 30) chargeState.hadEnoughTime = true;
                // Lock once time drops below 30 min (only if it was above 30 at some point)
                if (chargeState.hadEnoughTime && minutesRemaining < 30) {
                  chargeState.locked = true;
                  debug("Charge rate locked (< 30 min remaining)");
                }

                kw = Math.round(Math.min(chargeState.rollingAverage, L2_MAX_KW) * 10) / 10;
              }

              debug(`Charge rate: raw=${rawKw.toFixed(1)}kW avg=${chargeState.rollingAverage != null ? chargeState.rollingAverage.toFixed(1) : "n/a"}kW published=${kw}kW`);
              brokerClient.publish(
                `honstar-mqtt/${vin}/ev_charge_rate/state`,
                String(kw),
                opts
              );
            }
          }
        }
      }
    } else {
      // Not charging — reset session state
      if (chargeState.active) {
        debug("Charge session ended");
      }
      chargeState.active = false;
      chargeState.isDcfc = null;
      chargeState.rollingAverage = null;
      chargeState.locked = false;
      chargeState.hadEnoughTime = false;
      chargeState.lastSoc = null;
      chargeState.lastIsoTime = null;
      brokerClient.publish(`honstar-mqtt/${vin}/ev_charge_complete_time/state`, "", opts);
      brokerClient.publish(`honstar-mqtt/${vin}/ev_charge_rate/state`, "0", opts);
    }
  }

  if (dashboard.battery?.plugStatus != null) {
    const raw = dashboard.battery.plugStatus;
    const plugged =
      raw === "plugged" ||
      raw === "CONNECT" ||
      raw === "CONNECTED" ||
      raw === "connected";
    brokerClient.publish(
      `honstar-mqtt/${vin}/ev_plug_state/state`,
      plugged ? "ON" : "OFF",
      opts
    );
  }

  if (dashboard.tires) {
    const tireState = {};
    for (const [pos, data] of Object.entries(dashboard.tires)) {
      const tp = TIRE_POSITIONS[pos];
      if (tp) {
        tireState[tp.slug] = Math.round(data.pressurePsi * 10) / 10;
        tireState[`${tp.slug}_warning`] = data.warning;
        const placardData = dashboard.tires[tp.placard];
        if (placardData) {
          tireState[`${tp.slug}_placard`] = Math.round(placardData.pressurePsi * 10) / 10;
        }
      }
    }
    brokerClient.publish(
      `honstar-mqtt/${vin}/tire_pressure/state`,
      JSON.stringify(tireState),
      opts
    );
  }

  log("Published HA entity states");
}

module.exports = { publishAvailability, publishStates };
