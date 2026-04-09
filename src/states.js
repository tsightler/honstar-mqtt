const { log, debug } = require("./config");
const geoTz = require("geo-tz");
const { toZonedTime, fromZonedTime } = require("date-fns-tz");

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

// Charge rate tracking state (persists across poll cycles)
const chargeState = {
  active: false,
  isDcfc: null,
  // SOC-based rate tracking (30-min sliding window)
  socReadings: [],       // Array of {soc, timestamp} — last 3 readings
};

// Vehicle location state for timezone detection
const vehicleState = {
  timezone: null,
  lastLocation: null,
};

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function calculateSocBasedRate(currentSoc, currentTimestamp, capacity) {
  // Only add readings when SOC changes to avoid diluting the cumulative average
  const lastReading = chargeState.socReadings[chargeState.socReadings.length - 1];
  if (!lastReading || currentSoc !== lastReading.soc) {
    chargeState.socReadings.push({ soc: currentSoc, timestamp: currentTimestamp });
  }

  let rawKw = null;
  if (chargeState.socReadings.length >= 4) {
    // After 3rd charging poll, use cumulative average from pre-charge baseline
    const first = chargeState.socReadings[0]; // pre-charge baseline (midpoint-adjusted)
    const current = chargeState.socReadings[chargeState.socReadings.length - 1];
    const socDelta = current.soc - first.soc;
    const hoursElapsed = (new Date(current.timestamp) - new Date(first.timestamp)) / 3600000;

    if (socDelta > 0 && hoursElapsed > 0) {
      rawKw = (socDelta / 100) * capacity / hoursElapsed;
      debug(`SOC-based rate: ΔSOC=${socDelta.toFixed(1)}% Δt=${(hoursElapsed * 60).toFixed(0)}min raw=${rawKw.toFixed(1)}kW`);
    }
  }

  return rawKw;
}

function resolveChargeCompleteTime(ct, responseTimestamp, vehicleTimezone = null) {
  const now = new Date(responseTimestamp);
  const targetDayIdx = DAYS.indexOf(ct.day);
  if (targetDayIdx === -1) return null;

  const hour = parseInt(ct.hour);
  const minute = parseInt(ct.minute);
  if (isNaN(hour) || isNaN(minute)) return null;

  try {
    // Use vehicle timezone if available, otherwise fall back to server timezone
    const tz = vehicleTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

    // Convert UTC timestamp to vehicle's local time
    const nowInVehicleTz = toZonedTime(now, tz);
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
    const utcTime = fromZonedTime(candidate, tz);

    return utcTime.toISOString();
  } catch (err) {
    debug(`Timezone conversion failed: ${err.message}, falling back to simple calculation`);

    // Fallback: use simple server timezone calculation
    const candidate = new Date(now);
    let daysAhead = targetDayIdx - candidate.getDay();
    if (daysAhead < 0) daysAhead += 7;

    candidate.setDate(candidate.getDate() + daysAhead);
    candidate.setHours(hour, minute, 0, 0);

    if (candidate <= now) candidate.setDate(candidate.getDate() + 7);

    return candidate.toISOString();
  }
}

function updateVehicleLocation(latitude, longitude) {
  // Only update timezone if location changed significantly (> 0.5 degrees ~ 55km)
  if (
    !vehicleState.lastLocation ||
    Math.abs(latitude - vehicleState.lastLocation.lat) > 0.5 ||
    Math.abs(longitude - vehicleState.lastLocation.lon) > 0.5
  ) {
    try {
      // Use setImmediate to prevent blocking the event loop
      setImmediate(() => {
        try {
          const timezones = geoTz.find(latitude, longitude);
          if (timezones && timezones.length > 0) {
            const newTimezone = timezones[0];
            if (vehicleState.timezone !== newTimezone) {
              vehicleState.timezone = newTimezone;
              log(`Vehicle timezone detected: ${newTimezone}`);
            }
            vehicleState.lastLocation = { lat: latitude, lon: longitude };
          }
        } catch (err) {
          log(`Failed to detect timezone: ${err.message}`);
          // Continue with server timezone as fallback
        }
      });
    } catch (err) {
      log(`Failed to schedule timezone detection: ${err.message}`);
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

function correctStaleSoc(dashboard) {
  if (
    dashboard.battery?.stateOfCharge != null &&
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
        `Stale SOC detected: reported=${Number(dashboard.battery.stateOfCharge).toFixed(1)}% ` +
        `estimated=${Number(estimatedSoc).toFixed(1)}% (diff=${Number(socDiff).toFixed(1)}%) - using estimated value`
      );
      dashboard.battery.stateOfCharge = Math.round(estimatedSoc * 10) / 10;
    }
  }
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
        // Adjust baseline timestamp to midpoint between last poll and now
        // (assume charging started halfway through the poll interval)
        if (chargeState.socReadings.length > 0 && dashboard.timestamp) {
          const baseline = chargeState.socReadings[0];
          const mid = (new Date(baseline.timestamp).getTime() + new Date(dashboard.timestamp).getTime()) / 2;
          baseline.timestamp = new Date(mid).toISOString();
          debug(`Charge session started (baseline SOC: ${baseline.soc}%)`);
        } else {
          debug("Charge session started (no baseline SOC)");
        }
      }

      const capacity = getBatteryCapacity(vehicle);
      const currentSoc = parseFloat(dashboard.battery?.stateOfCharge);
      const targetSoc = parseFloat(dashboard.chargeSettings?.targetLevel);
      debug(`Charge rate calc: model=${vehicle?.ModelCode} capacity=${capacity}kWh soc=${currentSoc} target=${targetSoc}`);

      // Always track SOC-based rate when we have valid data
      let socKw = null;
      if (capacity && !isNaN(currentSoc) && dashboard.timestamp) {
        socKw = calculateSocBasedRate(currentSoc, dashboard.timestamp, capacity);
      }

      if (capacity && !isNaN(currentSoc) && !isNaN(targetSoc) && targetSoc > currentSoc) {
        // Resolve API completion time
        let apiIsoTime = null;
        let apiHoursRemaining = null;
        if (dashboard.chargeCompleteTime?.hour != null && dashboard.timestamp) {
          apiIsoTime = resolveChargeCompleteTime(
            dashboard.chargeCompleteTime,
            dashboard.timestamp,
            vehicleState.timezone
          );
          if (apiIsoTime) {
            apiHoursRemaining = (new Date(apiIsoTime) - new Date(dashboard.timestamp)) / 3600000;
          }
        }

        // Detect charge type on first valid calculation
        if (chargeState.isDcfc === null && apiHoursRemaining !== null) {
          const minutesRemaining = apiHoursRemaining * 60;
          chargeState.isDcfc = (targetSoc - currentSoc) > 5 && minutesRemaining < 10;
          debug(`Charge type detected: ${chargeState.isDcfc ? "DCFC" : "L1/L2"}`);
        }

        // Determine which rate source to use
        const apiStale = apiHoursRemaining === null || apiHoursRemaining <= 0 || apiHoursRemaining > 120;
        let rawKw = null;
        let usingSocBased = false;
        let publishedIsoTime = apiIsoTime;

        if (apiStale) {
          // API time is missing, in the past, or > 5 days away — use SOC-based
          if (socKw && socKw > 0) {
            rawKw = socKw;
            usingSocBased = true;
            // Calculate our own completion time
            const remainingKwh = ((targetSoc - currentSoc) / 100) * capacity;
            const hoursToComplete = remainingKwh / socKw;
            publishedIsoTime = new Date(new Date(dashboard.timestamp).getTime() + hoursToComplete * 3600000).toISOString();
            debug(`Stale API completion time (${apiHoursRemaining !== null ? apiHoursRemaining.toFixed(1) + 'h' : 'null'}), using SOC-based rate: ${socKw.toFixed(1)}kW`);
          }
        } else {
          // API time seems reasonable — calculate API-based kW
          const apiKw = ((targetSoc - currentSoc) / 100) * capacity / apiHoursRemaining;

          if (socKw && socKw > 0) {
            // Compare API and SOC-based completion times
            const remainingKwh = ((targetSoc - currentSoc) / 100) * capacity;
            const socHoursRemaining = remainingKwh / socKw;
            const ratio = apiHoursRemaining / socHoursRemaining;

            if (ratio >= 0.75 && ratio <= 1.25) {
              // Within 25% — average API and SOC-based rates
              rawKw = (apiKw + socKw) / 2;
              debug(`API/SOC averaged (ratio=${ratio.toFixed(2)}, api=${apiKw.toFixed(1)}kW, soc=${socKw.toFixed(1)}kW, avg=${rawKw.toFixed(1)}kW)`);
            } else {
              // Diverged — use SOC-based
              rawKw = socKw;
              usingSocBased = true;
              const hoursToComplete = remainingKwh / socKw;
              publishedIsoTime = new Date(new Date(dashboard.timestamp).getTime() + hoursToComplete * 3600000).toISOString();
              debug(`API completion differs from SOC-based estimate (ratio=${ratio.toFixed(2)}, api=${apiKw.toFixed(1)}kW, soc=${socKw.toFixed(1)}kW), using SOC-based rate`);
            }
          } else {
            // No SOC-based rate yet — use API
            rawKw = apiKw;
          }
        }

        // Publish completion time
        if (publishedIsoTime) {
          brokerClient.publish(
            `honstar-mqtt/${vin}/ev_charge_complete_time/state`,
            publishedIsoTime,
            opts
          );
        }

        if (rawKw && rawKw > 0) {
          let kw;
          if (chargeState.isDcfc) {
            kw = Math.round(rawKw);
          } else {
            // Add 5% to account for battery overhead, cap at 11kW for L1/L2
            kw = Math.min(rawKw * 1.05, 11);
            kw = Math.round(kw * 10) / 10;
          }
          const src = usingSocBased ? 'soc' : 'api';
          debug(`Charge rate: src=${src} raw=${rawKw.toFixed(1)}kW published=${kw}kW`);
          brokerClient.publish(
            `honstar-mqtt/${vin}/ev_charge_rate/state`,
            String(kw),
            opts
          );
        }
      }
    } else {
      // Not charging — reset session state but track SOC baseline
      if (chargeState.active) {
        debug("Charge session ended");
      }
      chargeState.active = false;
      chargeState.isDcfc = null;
      // Record current SOC as baseline for next charge session
      const soc = parseFloat(dashboard.battery?.stateOfCharge);
      if (!isNaN(soc) && dashboard.timestamp) {
        chargeState.socReadings = [{ soc, timestamp: dashboard.timestamp }];
      } else {
        chargeState.socReadings = [];
      }
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

module.exports = { correctStaleSoc, publishAvailability, publishStates, updateVehicleLocation };
