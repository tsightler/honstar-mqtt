const { log } = require("./config");

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

module.exports = { parseDashboard, printDashboard };
