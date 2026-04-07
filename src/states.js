const { log, debug } = require("./config");
const geoTz = require("geo-tz");
const { zonedTimeToUtc, utcToZonedTime } = require("date-fns-tz");

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

// Standard charger rates (DC power to battery after conversion losses)
const L2_RATES_KW = [10.4, 8.6, 6.9, 5.2, 3.5]; // 48A, 40A, 32A, 24A, 16A @ 240V, 90% eff
const L1_RATES_KW = [1.5, 1.2, 0.8];            // 16A, 12A, 8A @ 120V, 80% eff

// Charge rate tracking state (persists across poll cycles)
const chargeState = {
  active: false,
  isDcfc: null,
  samples: [],        // Rolling window of raw kW calculations
  snappedKw: null,    // The locked-in standard rate
  lastSoc: null,
  lastIsoTime: null,
};

// Vehicle location state for timezone detection
const vehicleState = {
  timezone: null,
  lastLocation: null,
};

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function snapToStandardRate(rawKw) {
  const rates = rawKw < 3 ? L1_RATES_KW : L2_RATES_KW;

  // Find closest rate
  let closest = rates[0];
  let minDiff = Math.abs(rawKw - closest);

  for (const rate of rates) {
    const diff = Math.abs(rawKw - rate);
    if (diff < minDiff) {
      minDiff = diff;
      closest = rate;
    }
  }

  return closest;
}

function resolveChargeCompleteTime(ct, responseTimestamp, vehicleTimezone = null) {
  const now = new Date(responseTimestamp);
  const targetDayIdx = DAYS.indexOf(ct.day);
  if (targetDayIdx === -1) return null;

  const hour = parseInt(ct.hour);
  const minute = parseInt(ct.minute);
  if (isNaN(hour) || isNaN(minute)) return null;

  // Use vehicle timezone if available, otherwise fall back to server timezone
  const tz = vehicleTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Convert UTC timestamp to vehicle's local time
  const nowInVehicleTz = utcToZonedTime(now, tz);
  const currentDayIdx = nowInVehicleTz.getDay();

  // Calculate days ahead
  let daysAhead = targetDayIdx - currentDayIdx;
  if (daysAhead < 0) daysAhead += 7;

  // Create a date in vehicle timezone for the completion time
  const candidate = new Date(nowInVehicleTz);
  candidate.setDate(candidate.getDate() + daysAhead);
  candidate.setHours(hour, minute, 0, 0);

  // If completion time is in the past, add a week
  if (candidate <= nowInVehicleTz) {
    candidate.setDate(candidate.getDate() + 7);
  }

  // Convert from vehicle timezone to UTC
  const utcTime = zonedTimeToUtc(candidate, tz);

  return utcTime.toISOString();
}

function updateVehicleLocation(latitude, longitude) {
  // Only update timezone if location changed significantly (> 0.5 degrees ~ 55km)
  if (
    !vehicleState.lastLocation ||
    Math.abs(latitude - vehicleState.lastLocation.lat) > 0.5 ||
    Math.abs(longitude - vehicleState.lastLocation.lon) > 0.5
  ) {
    try {
      const timezones = geoTz.find(latitude, longitude);
      if (timezones && timezones.length > 0) {
        const newTimezone = timezones[0];
        if (vehicleState.timezone !== newTimezone) {
          vehicleState.timezone = newTimezone;
          debug(`Vehicle timezone updated: ${newTimezone}`);
        }
        vehicleState.lastLocation = { lat: latitude, lon: longitude };
      }
    } catch (err) {
      debug(`Failed to detect timezone: ${err.message}`);
    }
  }
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
    let socToPublish = dashboard.battery.stateOfCharge;

    // Detect stale SOC by comparing to range-based estimate
    if (
      dashboard.projectedRangeAtTarget?.value &&
      dashboard.chargeSettings?.targetLevel &&
      dashboard.battery?.range != null
    ) {
      const milesPerPercent =
        dashboard.projectedRangeAtTarget.value / dashboard.chargeSettings.targetLevel;
      const estimatedSoc = dashboard.battery.range / milesPerPercent;
      const socDiff = Math.abs(estimatedSoc - dashboard.battery.stateOfCharge);

      if (socDiff > 3) {
        debug(
          `Stale SOC detected: reported=${dashboard.battery.stateOfCharge.toFixed(1)}% ` +
          `estimated=${estimatedSoc.toFixed(1)}% (diff=${socDiff.toFixed(1)}%) - using estimated value`
        );
        socToPublish = estimatedSoc;
      }
    }

    brokerClient.publish(
      `honstar-mqtt/${vin}/ev_battery_level/state`,
      String(Math.round(socToPublish)),
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
        chargeState.samples = [];
        chargeState.snappedKw = null;
        chargeState.lastSoc = null;
        chargeState.lastIsoTime = null;
        debug("Charge session started");
      }

      if (dashboard.chargeCompleteTime?.hour != null && dashboard.timestamp) {
        const isoTime = resolveChargeCompleteTime(
          dashboard.chargeCompleteTime,
          dashboard.timestamp,
          vehicleState.timezone
        );
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

            // Detect charge type on first valid calculation
            if (chargeState.isDcfc === null) {
              const minutesRemaining = hoursRemaining * 60;
              chargeState.isDcfc = (targetSoc - currentSoc) > 5 && minutesRemaining < 10;
              debug(`Charge type detected: ${chargeState.isDcfc ? "DCFC" : "L1/L2"}`);
            }

            let rawKw;
            if (hoursRemaining > 0) {
              // Calculate raw kW from ETA
              rawKw = ((targetSoc - currentSoc) / 100) * capacity / hoursRemaining;
            }

            if (rawKw && rawKw > 0) {
              // Detect stale data: SOC and completion time unchanged from last cycle
              const staleData = chargeState.lastSoc !== null
                && currentSoc === chargeState.lastSoc
                && isoTime === chargeState.lastIsoTime;
              chargeState.lastSoc = currentSoc;
              chargeState.lastIsoTime = isoTime;

              let kw;
              if (chargeState.isDcfc) {
                // DCFC: just round to nearest integer
                kw = Math.round(rawKw);
              } else {
                // L1/L2: use rolling average and snap to standard rates
                if (!staleData) {
                  // Add new sample to rolling window
                  chargeState.samples.push(rawKw);
                  // Keep last 6 samples (90 minutes of data at 15 min polls)
                  if (chargeState.samples.length > 6) {
                    chargeState.samples.shift();
                  }
                }

                if (chargeState.samples.length > 0) {
                  // Calculate average of samples
                  const avgRaw = chargeState.samples.reduce((a, b) => a + b, 0) / chargeState.samples.length;

                  // Snap to standard rate
                  const snapped = snapToStandardRate(avgRaw);

                  // Lock in the rate once we have enough samples (3+)
                  if (chargeState.snappedKw === null || chargeState.samples.length < 3) {
                    chargeState.snappedKw = snapped;
                  }
                  // Allow adjustments if average has shifted significantly
                  else if (Math.abs(snapped - chargeState.snappedKw) > 1.5) {
                    chargeState.snappedKw = snapped;
                    debug(`Charge rate adjusted to ${snapped}kW based on new average`);
                  }

                  kw = chargeState.snappedKw;
                }
              }

              if (kw !== undefined) {
                const avgStr = chargeState.samples.length > 0
                  ? (chargeState.samples.reduce((a,b)=>a+b,0)/chargeState.samples.length).toFixed(1)
                  : 'n/a';
                debug(`Charge rate: raw=${rawKw.toFixed(1)}kW samples=${chargeState.samples.length} avg=${avgStr}kW published=${kw}kW`);
                brokerClient.publish(
                  `honstar-mqtt/${vin}/ev_charge_rate/state`,
                  String(kw),
                  opts
                );
              }
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
      chargeState.samples = [];
      chargeState.snappedKw = null;
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

module.exports = { publishAvailability, publishStates, updateVehicleLocation };
