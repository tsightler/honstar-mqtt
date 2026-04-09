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

function printDashboard(dashboard, options = {}) {
  const IW = 70;
  const LW = 35;
  const RW = 34;

  const fit = (s, w) =>
    s.length >= w ? s.substring(0, w) : s + " ".repeat(w - s.length);

  const topLine = "\u250c" + "\u2500".repeat(IW) + "\u2510";
  const midLine = "\u251c" + "\u2500".repeat(IW) + "\u2524";
  const botLine = "\u2514" + "\u2500".repeat(IW) + "\u2518";
  const fullRow = (text) => "\u2502  " + fit(text, IW - 2) + "\u2502";
  const colRow = (l, r) =>
    "\u2502  " + fit(l, LW - 2) + "\u2502  " + fit(r, RW - 2) + "\u2502";

  const fmtNum = (n) => Math.round(n).toLocaleString("en-US");

  const fmtMode = (type) =>
    type
      .split(/[_ ]+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");

  const fmtChargeComplete = (ct) => {
    if (!ct?.day || ct.hour == null) return "";
    const day = ct.day.substring(0, 3);
    const h = parseInt(ct.hour);
    const min = String(ct.minute).padStart(2, "0");
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${day} ${h12}:${min} ${ampm}`;
  };

  // Timestamp
  let ts = "";
  if (dashboard.timestamp) {
    const d = new Date(dashboard.timestamp);
    ts = d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  }

  // Battery progress bar
  const soc = dashboard.battery?.stateOfCharge;
  const socPct = soc != null ? Math.round(soc) : null;
  const BAR_LEN = 15;
  const filled =
    socPct != null
      ? Math.min(BAR_LEN, Math.round((socPct / 100) * BAR_LEN))
      : 0;
  const bar =
    socPct != null
      ? "\u2588".repeat(filled) +
        "\u2591".repeat(BAR_LEN - filled) +
        ` ${socPct}%`
      : "";

  // Range
  const range =
    dashboard.battery?.range != null
      ? `Range: ${Math.round(dashboard.battery.range)} mi`
      : "";

  // Plug · Charge status
  let plugCharge = "";
  if (dashboard.battery) {
    const pRaw = dashboard.battery.plugStatus;
    const cRaw = dashboard.battery.chargeStatus;
    const plugged = ["plugged", "CONNECT", "CONNECTED", "connected"].includes(
      pRaw
    );
    const charging = [
      "charging",
      "CHARGING",
      "ACTIVE",
      "connected_charging",
      "CONNECTION_CHARGING",
    ].includes(cRaw);
    plugCharge = `${plugged ? "Plugged" : "Unplugged"} \u00b7 ${charging ? "Charging" : "Not charging"}`;
  }

  // Charge mode
  let mode = "";
  if (dashboard.chargeSettings?.type) {
    mode = `Mode: ${fmtMode(dashboard.chargeSettings.type)}`;
    if (dashboard.chargeSettings.targetLevel != null) {
      mode += ` \u2192 ${dashboard.chargeSettings.targetLevel}%`;
      if (dashboard.projectedRangeAtTarget?.value) {
        mode += ` (\u2248${Math.round(dashboard.projectedRangeAtTarget.value)} mi)`;
      }
    }
  }

  // Charging status flag (used for completion time)
  const isCharging = dashboard.battery
    ? ["charging", "CHARGING", "ACTIVE", "connected_charging", "CONNECTION_CHARGING"]
        .includes(dashboard.battery.chargeStatus)
    : false;

  // Charge complete time
  const ctStr = fmtChargeComplete(dashboard.chargeCompleteTime);
  const complete = isCharging && ctStr ? `Complete: ${ctStr}` : "Complete: N/A";

  // Odometer
  const odo =
    dashboard.odometer?.value != null
      ? `Odometer: ${fmtNum(dashboard.odometer.value)} ${dashboard.odometer.unit === "kilometers" ? "km" : "mi"}`
      : "";

  // Preconditioning
  let precond = "";
  if (dashboard.chargeSettings?.cabinPreconditioning != null) {
    const raw = dashboard.chargeSettings.cabinPreconditioning;
    precond = `Precondition: ${raw === "ON" || raw === "on" ? "On" : "Off"}`;
  }

  // Precondition temperature
  let precondTemp = "";
  if (options.climateTemp != null) {
    precondTemp = `Precondition Temp: ${options.climateTemp}\u00b0F`;
  }

  // Build output
  const lines = [];
  lines.push(topLine);
  lines.push(fullRow("VEHICLE DASHBOARD"));
  lines.push(fullRow(ts));
  lines.push(midLine);

  // Two-column rows: [left, right]
  const rows = [
    ["BATTERY", "STATUS"],
    [bar, odo],
    [range, precond],
    [mode, precondTemp],
    [plugCharge, ""],
    [complete, ""],
  ];

  // Trim trailing rows where both columns are empty
  while (rows.length > 1 && !rows[rows.length - 1][0] && !rows[rows.length - 1][1]) {
    rows.pop();
  }

  for (const [l, r] of rows) {
    lines.push(colRow(l, r));
  }

  // Tires section
  if (dashboard.tires) {
    const t = dashboard.tires;
    const pf = t.placardFront;
    const pr = t.placardRear;

    lines.push(midLine);
    lines.push(fullRow("TIRE PRESSURE PSI (kPa)"));

    const LBL = 10;
    const COL = 17;
    const warn = (d) =>
      d.warning && d.warning !== "OFF" && d.warning !== "unknown";
    const fmtTire = (d) =>
      d ? `${d.pressurePsi} (${d.pressureKpa})${warn(d) ? " LOW" : ""}` : "";

    const hdr =
      fit("", LBL) + fit("Left", COL) + fit("Right", COL) + "Recommended";
    lines.push(fullRow(hdr));

    if (t.frontLeft || t.frontRight) {
      const r =
        fit("Front", LBL) +
        fit(fmtTire(t.frontLeft), COL) +
        fit(fmtTire(t.frontRight), COL) +
        fmtTire(pf);
      lines.push(fullRow(r));
    }

    if (t.rearLeft || t.rearRight) {
      const r =
        fit("Rear", LBL) +
        fit(fmtTire(t.rearLeft), COL) +
        fit(fmtTire(t.rearRight), COL) +
        fmtTire(pr);
      lines.push(fullRow(r));
    }
  }

  lines.push(botLine);
  console.log("\n" + lines.join("\n"));
}

module.exports = { parseDashboard, printDashboard };
