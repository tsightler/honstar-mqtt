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
  preChargeSoc: null,          // SOC from last non-charging poll
  lastPoll: null,              // {soc, range, timestamp} from previous charging poll
  socIntervalRates: [],        // Per-interval SOC-based rates (kW)
  rangeIntervalRates: [],      // Per-interval range-based rates (kW)
};

// Vehicle location state for timezone detection
const vehicleState = {
  timezone: null,
  lastLocation: null,
};

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function calculateIntervalRates(currentSoc, currentRange, currentTimestamp, capacity, kWhPerMile) {
  const MIN_INTERVALS = 3;

  // Calculate interval rates from previous charging poll
  if (chargeState.lastPoll) {
    const prev = chargeState.lastPoll;
    const hoursElapsed = (new Date(currentTimestamp) - new Date(prev.timestamp)) / 3600000;

    if (hoursElapsed > 0) {
      const socDelta = currentSoc - prev.soc;
      if (socDelta > 0) {
        chargeState.socIntervalRates.push((socDelta / 100) * capacity / hoursElapsed);
      }

      if (currentRange != null && prev.range != null && kWhPerMile > 0) {
        const rangeDelta = currentRange - prev.range;
        if (rangeDelta > 0) {
          chargeState.rangeIntervalRates.push(rangeDelta * kWhPerMile / hoursElapsed);
        }
      }
    }
  }

  chargeState.lastPoll = { soc: currentSoc, range: currentRange, timestamp: currentTimestamp };

  // Running averages (need >= MIN_INTERVALS before publishing)
  const socRates = chargeState.socIntervalRates;
  const rangeRates = chargeState.rangeIntervalRates;
  const socAvg = socRates.length >= MIN_INTERVALS
    ? socRates.reduce((a, b) => a + b, 0) / socRates.length : null;
  const rangeAvg = rangeRates.length >= MIN_INTERVALS
    ? rangeRates.reduce((a, b) => a + b, 0) / rangeRates.length : null;

  if (socAvg !== null || rangeAvg !== null) {
    const parts = [];
    if (socAvg !== null) parts.push(`soc=${socAvg.toFixed(1)}kW(${socRates.length})`);
    if (rangeAvg !== null) parts.push(`range=${rangeAvg.toFixed(1)}kW(${rangeRates.length})`);
    debug(`Interval rates: ${parts.join(', ')}`);
  }

  return { socAvg, rangeAvg };
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
        if (chargeState.preChargeSoc !== null) {
          debug(`Charge session started (baseline SOC: ${chargeState.preChargeSoc}%)`);
        } else {
          debug("Charge session started (no baseline SOC)");
        }
      }

      const capacity = getBatteryCapacity(vehicle);
      const currentSoc = parseFloat(dashboard.battery?.stateOfCharge);
      const currentRange = dashboard.battery?.range != null ? parseFloat(dashboard.battery.range) : null;
      const targetSoc = parseFloat(dashboard.chargeSettings?.targetLevel);
      debug(`Charge rate calc: model=${vehicle?.ModelCode} capacity=${capacity}kWh soc=${currentSoc} target=${targetSoc}`);

      // Calculate per-interval rates for SOC and range
      let socAvg = null;
      let rangeAvg = null;
      if (capacity && !isNaN(currentSoc) && dashboard.timestamp) {
        const projRange = dashboard.projectedRangeAtTarget?.value;
        const kWhPerMile = (projRange && targetSoc)
          ? (targetSoc / 100 * capacity) / projRange : 0;
        ({ socAvg, rangeAvg } = calculateIntervalRates(
          currentSoc, currentRange, dashboard.timestamp, capacity, kWhPerMile
        ));
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

        // Collect all available rate estimates
        const apiStale = apiHoursRemaining === null || apiHoursRemaining <= 0
          || apiHoursRemaining > 120 || apiHoursRemaining < 0.25;
        const rates = [];
        const rateSources = [];
        const rateCounts = [];

        if (!apiStale) {
          const apiKw = ((targetSoc - currentSoc) / 100) * capacity / apiHoursRemaining;
          rates.push(apiKw);
          rateSources.push(`api=${apiKw.toFixed(1)}`);
          rateCounts.push(1);
        }
        if (socAvg !== null) {
          rates.push(socAvg);
          rateSources.push(`soc=${socAvg.toFixed(1)}`);
          rateCounts.push(chargeState.socIntervalRates.length);
        }
        if (rangeAvg !== null) {
          rates.push(rangeAvg);
          rateSources.push(`range=${rangeAvg.toFixed(1)}`);
          rateCounts.push(chargeState.rangeIntervalRates.length);
        }

        // Filter outliers: exclude rates >25% from median (3+ rates)
        // or drop the one with fewer samples (2 rates)
        if (rates.length >= 3) {
          const sorted = [...rates].sort((a, b) => a - b);
          const median = sorted[Math.floor(sorted.length / 2)];
          for (let i = rates.length - 1; i >= 0; i--) {
            if (Math.abs(rates[i] - median) / median > 0.25) {
              debug(`Outlier excluded: ${rateSources[i]} (median=${median.toFixed(1)}kW)`);
              rates.splice(i, 1);
              rateSources.splice(i, 1);
              rateCounts.splice(i, 1);
            }
          }
        } else if (rates.length === 2) {
          const ratio = Math.abs(rates[0] - rates[1]) / Math.min(rates[0], rates[1]);
          if (ratio > 0.25 && rateCounts[0] !== rateCounts[1]) {
            const drop = rateCounts[0] < rateCounts[1] ? 0 : 1;
            debug(`Outlier excluded: ${rateSources[drop]} (${rateCounts[drop]} vs ${rateCounts[1 - drop]} samples)`);
            rates.splice(drop, 1);
            rateSources.splice(drop, 1);
            rateCounts.splice(drop, 1);
          }
        }

        let rawKw = null;
        let publishedIsoTime = apiIsoTime;

        if (rates.length > 0) {
          rawKw = rates.reduce((a, b) => a + b, 0) / rates.length;
          debug(`Rate sources: ${rateSources.join(', ')} → avg=${rawKw.toFixed(1)}kW`);
        }

        // Calculate completion time from averaged rate if API is stale
        if (apiStale && rawKw && rawKw > 0) {
          const remainingKwh = ((targetSoc - currentSoc) / 100) * capacity;
          const hoursToComplete = remainingKwh / rawKw;
          publishedIsoTime = new Date(new Date(dashboard.timestamp).getTime() + hoursToComplete * 3600000).toISOString();
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
            // Add 5% to account for battery overhead, cap at 10.5kW for L1/L2
            kw = Math.min(rawKw * 1.05, 10.5);
            kw = Math.round(kw * 10) / 10;
          }
          debug(`Charge rate: raw=${rawKw.toFixed(1)}kW published=${kw}kW`);
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
      chargeState.lastPoll = null;
      chargeState.socIntervalRates = [];
      chargeState.rangeIntervalRates = [];
      // Record current SOC as baseline for next charge session
      const soc = parseFloat(dashboard.battery?.stateOfCharge);
      chargeState.preChargeSoc = !isNaN(soc) ? soc : null;
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
