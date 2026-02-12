const { log, debug } = require("./config");

const TIRE_POSITIONS = {
  frontLeft:  { slug: "tire_pressure_lf", name: "Tire Pressure: Left Front", placard: "placardFront" },
  frontRight: { slug: "tire_pressure_rf", name: "Tire Pressure: Right Front", placard: "placardFront" },
  rearLeft:   { slug: "tire_pressure_lr", name: "Tire Pressure: Left Rear", placard: "placardRear" },
  rearRight:  { slug: "tire_pressure_rr", name: "Tire Pressure: Right Rear", placard: "placardRear" },
};

function buildDeviceInfo(vin, vehicle) {
  return {
    identifiers: [vin],
    manufacturer: vehicle?.DivisionName || "Acura",
    model: [vehicle?.ModelYear, vehicle?.DivisionName, vehicle?.ModelCode]
      .filter(Boolean)
      .join(" "),
    name: [vehicle?.ModelYear, vehicle?.DivisionName, vehicle?.ModelCode]
      .filter(Boolean)
      .join(" "),
  };
}

function publishDiscovery(brokerClient, vin, vehicle) {
  const device = buildDeviceInfo(vin, vehicle);
  const availTopic = `acura-ev/${vin}/available`;
  const opts = { retain: true, qos: 1 };

  function pub(component, slug, config) {
    const topic = `homeassistant/${component}/${vin}/${slug}/config`;
    const payload = JSON.stringify({
      ...config,
      unique_id: `${vin}-${slug}`,
      availability_topic: availTopic,
      payload_available: "true",
      payload_not_available: "false",
      device,
    });
    brokerClient.publish(topic, payload, opts);
    debug(`Discovery: ${topic}`);
  }

  // ── Sensors ──

  pub("sensor", "ev_battery_level", {
    name: "EV Battery Level",
    device_class: "battery",
    state_class: "measurement",
    unit_of_measurement: "%",
    icon: "mdi:battery-high",
    state_topic: `acura-ev/${vin}/ev_battery_level/state`,
  });

  pub("sensor", "ev_range", {
    name: "EV Range",
    device_class: "distance",
    state_class: "measurement",
    unit_of_measurement: "mi",
    icon: "mdi:ev-station",
    state_topic: `acura-ev/${vin}/ev_range/state`,
  });

  pub("sensor", "odometer", {
    name: "Odometer",
    device_class: "distance",
    state_class: "total_increasing",
    unit_of_measurement: "mi",
    icon: "mdi:counter",
    state_topic: `acura-ev/${vin}/odometer/state`,
  });

  // Remove old sensor entity (was changed to number)
  brokerClient.publish(
    `homeassistant/sensor/${vin}/ev_target_charge_level/config`,
    "",
    opts
  );

  // Target Charge Level (settable number entity)
  pub("number", "ev_target_charge_level", {
    name: "EV Target Charge Level",
    icon: "mdi:battery-charging-high",
    state_topic: `acura-ev/${vin}/ev_target_charge_level/state`,
    command_topic: `acura-ev/${vin}/ev_target_charge_level/set`,
    min: 50,
    max: 100,
    step: 5,
    unit_of_measurement: "%",
    mode: "slider",
  });

  // Climate preconditioning switch
  pub("switch", "ev_climate", {
    name: "Climate Preconditioning",
    icon: "mdi:air-conditioner",
    state_topic: `acura-ev/${vin}/ev_climate/state`,
    command_topic: `acura-ev/${vin}/ev_climate/set`,
  });

  // Climate preconditioning temperature
  pub("number", "ev_climate_temperature", {
    name: "Climate Temperature",
    icon: "mdi:thermometer",
    state_topic: `acura-ev/${vin}/ev_climate_temperature/state`,
    command_topic: `acura-ev/${vin}/ev_climate_temperature/set`,
    min: 60,
    max: 90,
    step: 1,
    unit_of_measurement: "°F",
    mode: "slider",
  });

  // Tire pressures (4 sensors)
  for (const [, tp] of Object.entries(TIRE_POSITIONS)) {
    pub("sensor", tp.slug, {
      name: tp.name,
      device_class: "pressure",
      state_class: "measurement",
      unit_of_measurement: "psi",
      icon: "mdi:car-tire-alert",
      state_topic: `acura-ev/${vin}/tire_pressure/state`,
      value_template: `{{ value_json.${tp.slug} }}`,
      json_attributes_topic: `acura-ev/${vin}/tire_pressure/state`,
      json_attributes_template: `{{ {'warning': value_json.${tp.slug}_warning, 'recommendation': value_json.${tp.slug}_placard} | tojson }}`,
    });
  }

  // ── Binary Sensors ──

  pub("binary_sensor", "ev_charge_state", {
    name: "EV Charge State",
    device_class: "battery_charging",
    icon: "mdi:battery-charging",
    payload_on: "ON",
    payload_off: "OFF",
    state_topic: `acura-ev/${vin}/ev_charge_state/state`,
  });

  pub("binary_sensor", "ev_plug_state", {
    name: "EV Plug State",
    device_class: "plug",
    icon: "mdi:ev-plug-type1",
    payload_on: "ON",
    payload_off: "OFF",
    state_topic: `acura-ev/${vin}/ev_plug_state/state`,
  });

  log("Published HA MQTT discovery configs");
}

function publishAvailability(brokerClient, vin, available) {
  brokerClient.publish(
    `acura-ev/${vin}/available`,
    available ? "true" : "false",
    { retain: true, qos: 1 }
  );
}

function publishStates(brokerClient, vin, dashboard) {
  const opts = { retain: true, qos: 1 };

  if (dashboard.battery?.stateOfCharge != null) {
    brokerClient.publish(
      `acura-ev/${vin}/ev_battery_level/state`,
      String(dashboard.battery.stateOfCharge),
      opts
    );
  }

  if (dashboard.battery?.range != null) {
    brokerClient.publish(
      `acura-ev/${vin}/ev_range/state`,
      String(dashboard.battery.range),
      opts
    );
  }

  if (dashboard.odometer?.value != null) {
    brokerClient.publish(
      `acura-ev/${vin}/odometer/state`,
      String(dashboard.odometer.value),
      opts
    );
  }

  if (dashboard.chargeSettings?.targetLevel != null) {
    brokerClient.publish(
      `acura-ev/${vin}/ev_target_charge_level/state`,
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
      `acura-ev/${vin}/ev_charge_state/state`,
      charging ? "ON" : "OFF",
      opts
    );
  }

  if (dashboard.battery?.plugStatus != null) {
    const raw = dashboard.battery.plugStatus;
    const plugged =
      raw === "plugged" ||
      raw === "CONNECT" ||
      raw === "CONNECTED" ||
      raw === "connected";
    brokerClient.publish(
      `acura-ev/${vin}/ev_plug_state/state`,
      plugged ? "ON" : "OFF",
      opts
    );
  }

  if (dashboard.tires) {
    const tireState = {};
    for (const [pos, data] of Object.entries(dashboard.tires)) {
      const tp = TIRE_POSITIONS[pos];
      if (tp) {
        tireState[tp.slug] = data.pressurePsi;
        tireState[`${tp.slug}_warning`] = data.warning;
        const placardData = dashboard.tires[tp.placard];
        if (placardData) {
          tireState[`${tp.slug}_placard`] = placardData.pressurePsi;
        }
      }
    }
    brokerClient.publish(
      `acura-ev/${vin}/tire_pressure/state`,
      JSON.stringify(tireState),
      opts
    );
  }

  log("Published HA entity states");
}

module.exports = { publishDiscovery, publishAvailability, publishStates };
