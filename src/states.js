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

const AC_CHARGE_RATES_KW = [1, 2, 3, 4, 6, 8, 10, 12];

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

    if (charging && dashboard.chargeCompleteTime?.hour != null && dashboard.timestamp) {
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
            const kw = rawKw > 12
              ? Math.round(rawKw)
              : AC_CHARGE_RATES_KW.reduce((a, b) => Math.abs(b - rawKw) < Math.abs(a - rawKw) ? b : a);
            brokerClient.publish(
              `honstar-mqtt/${vin}/ev_charge_rate/state`,
              String(kw),
              opts
            );
          }
        }
      }
    } else {
      brokerClient.publish(`honstar-mqtt/${vin}/ev_charge_complete_time/state`, "", opts);
      brokerClient.publish(`honstar-mqtt/${vin}/ev_charge_rate/state`, "", opts);
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
