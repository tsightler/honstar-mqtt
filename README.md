# Acura EV MQTT Gateway

A Node.js application that bridges Acura EV connected vehicle data to MQTT, with Home Assistant auto-discovery support. Polls vehicle status (battery, range, tire pressures, charging, odometer) and publishes to MQTT topics. Supports setting target charge level and climate preconditioning via MQTT commands.

Built by reverse-engineering the Acura EV Android app's API flow.

## Features

- Battery level, range, and charge status
- Plug state and charge mode
- Odometer
- Tire pressures with warning states
- Set target charge level (50-100%)
- Climate preconditioning start/stop with temperature control
- Home Assistant MQTT discovery (auto-creates entities)
- Configurable poll interval

## Installation

### Home Assistant Addon

1. In Home Assistant, go to **Settings > Add-ons > Add-on Store**
2. Click the **three-dot menu** (top right) and select **Repositories**
3. Add this repository URL:
   ```
   https://github.com/tsightler/acura-ev
   ```
4. Find **Acura EV MQTT** in the add-on store and click **Install**
5. Go to the addon **Configuration** tab and fill in your settings:
   - **acura_email** — Your Acura EV account email
   - **acura_password** — Your Acura EV account password
   - **acura_pin** — Your Acura EV account PIN (required for climate preconditioning)
   - **acura_vin** — Your vehicle's VIN (optional, defaults to first vehicle)
   - **mqtt_url** — MQTT broker URL (leave default to auto-discover from the Mosquitto addon)
   - **poll_interval** — Seconds between vehicle polls (minimum/default: 900)
   - **debug** — Enable debug logging (default: false)
6. Click **Start**

The addon will automatically connect to your MQTT broker and create Home Assistant entities via MQTT discovery.

### Docker

```bash
docker run -d \
  --name acura-ev-mqtt \
  --restart unless-stopped \
  -e ACURA_USERNAME="your@email.com" \
  -e ACURA_PASSWORD="yourpassword" \
  -e ACURA_PIN="1234" \
  -e ACURA_VIN="YOUR_VIN" \
  -e MQTT_URL="mqtt://user:password@mqtt-broker:1883" \
  -e POLL_INTERVAL=900 \
  -e DEBUG=false \
  ghcr.io/tsightler/acura-ev-mqtt-amd64
```

Replace `amd64` with your architecture (`aarch64`, `armv7`, `armhf`) if needed.

#### Docker Compose

```yaml
services:
  acura-ev-mqtt:
    image: ghcr.io/tsightler/acura-ev-mqtt-amd64
    container_name: acura-ev-mqtt
    restart: unless-stopped
    environment:
      - ACURA_USERNAME=your@email.com
      - ACURA_PASSWORD=yourpassword
      - ACURA_PIN=1234
      - ACURA_VIN=YOUR_VIN
      - MQTT_URL=mqtt://user:password@mqtt-broker:1883
      - POLL_INTERVAL=900
      - DEBUG=false
```

### Standalone (Node.js)

```bash
npm install
```

#### Command Line

```bash
node index.js <email> <password> [vin]
```

#### Environment Variables

```bash
export ACURA_USERNAME="your@email.com"
export ACURA_PASSWORD="yourpassword"
export ACURA_PIN="1234"
export ACURA_VIN="YOUR_VIN"
export MQTT_URL="mqtt://user:password@localhost:1883"
export POLL_INTERVAL=900

node index.js
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ACURA_USERNAME` | Yes | Acura EV account email |
| `ACURA_PASSWORD` | Yes | Acura EV account password |
| `ACURA_PIN` | No | Account PIN (required for climate preconditioning) |
| `ACURA_VIN` | No | Vehicle VIN (defaults to first vehicle on account) |
| `MQTT_URL` | Yes | MQTT broker URL (e.g. `mqtt://user:pass@host:1883`) |
| `POLL_INTERVAL` | No | Seconds between polls (minimum/default: 900) |
| `DEBUG` | No | Enable debug logging (default: false) |

## Home Assistant Entities

Once running, the following entities are automatically created via MQTT discovery:

| Entity | Type | Description |
|--------|------|-------------|
| EV Battery Level | Sensor | State of charge (%) |
| EV Range | Sensor | Estimated range (mi) |
| Odometer | Sensor | Total odometer (mi) |
| EV Charge State | Binary Sensor | Charging or not |
| EV Plug State | Binary Sensor | Plugged in or not |
| EV Target Charge Level | Number | Settable charge target (50-100%) |
| Climate Preconditioning | Switch | Start/stop cabin preconditioning |
| Climate Temperature | Number | Preconditioning target temp (60-90°F) |
| Tire Pressure (x4) | Sensor | Individual tire pressures (psi) |

## How It Works

The app follows the same authentication and data flow as the official Acura EV app:

```
1. Register Client       → identity.services.honda.com  → client_reg_key
2. Login (Generate Token) → identity.services.honda.com  → access_token
3. Get Vehicle List      → wsc.hondaweb.com              → VIN, vehicle info
4. Get CIG Token         → wsc.hondaweb.com              → JWT + signature
5. Connect MQTT/WSS      → AWS IoT (us-east-2)           → WebSocket connection
6. Subscribe             → $aws/things/thing_{VIN}/shadow/name/DASHBOARD_ASYNC/update
7. Request Dashboard     → wsc.hondaweb.com              → triggers async response
8. Receive Data          → via MQTT message               → battery, range, tires, etc.
```

Vehicle data is delivered asynchronously — the REST API triggers a request to the vehicle, and the response arrives over MQTT when the vehicle responds. The gateway then publishes the data to your MQTT broker with Home Assistant discovery configs.

## Notes

- The vehicle must have cellular connectivity to respond to dashboard requests.
- Climate preconditioning auto-turns off after 60 minutes (vehicle limitation).
- The BEV3 telematics platform is used by Acura ZDX and similar GM-platform vehicles.
- Access tokens are long-lived (~180 days) but the CIG JWT expires in ~30 minutes.
- Requires Node.js 18+.

## Security Notice

This application requires your Acura account credentials. Keep them secure and never commit them to version control. Use environment variables or the Home Assistant addon configuration (which stores them encrypted).

## License

MIT — for personal/educational use. This is an unofficial client based on reverse engineering.
