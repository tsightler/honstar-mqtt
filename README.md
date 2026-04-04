# HOnStar MQTT Gateway

HOnStar-MQTT is a small Node.js application that bridges connected vehicle data from Honda/Acura EVs based on the General Motors BEV3 platform (Honda Prolouge/Acura ZDX) to MQTT.  These vehicles use a Honda Web Services (HWS) API layer over the top of more traditional GM Onstar service, thus the "HOnStar" name.  It will use the HWS API to poll for vehicle status (battery, range, tire pressures, charging, odometer) and publish this data to simple MQTT topics while also supporting MQTT commands to set the target charge level and to start/stop climate preconditioning.

The application has full support for Home Assistant MQTT discovery, and can run as a Home Assistant App (previously called addons) making it easy to get this data into Home Assistant and, from there, use automations for schedules or the export the capabilities to other automation platforms such as Amazon Alexa, Google Home, or Apple Homekit.


## Features

- Battery level (SOC)
- Plug state and charge mode
- Set target charge level (50-100%)
- Estimated charge completion time and rate (kW)
- Estimated range
- Climate preconditioning start/stop with temperature control
- Lock/Unlock
- Odometer
- Tire pressures with warning states
- Vehicle Location (updated on startup, on odometer change, or on-demand via button entity)
- Home Assistant MQTT discovery (automatic entity creation)
- Configurable poll interval (900 seconds minimum)

## Notes

### Estimate charge complete time and rate
The time is estimated by the vehicle and returned via the API, it should match the time shown in the official app.

The estimated charge rate is not provided by the API but is calculated based on current SOC, target SOC, and estimated charge completion time.  Since polling only happens every 15 minutes, and completion time is also accurate to only 15 minutes, this number will never be 100% accurate, but it attempts to use varous hueristics to improve the accuracy.

### Locks
The API does not return real-time lock state, if you lock the vehicle with the API and someone unlocks it with the keyfob, the unlock state will not be reflected in the app.  Because of this, the Home Assistant lock will only show the lock/unlock state for a few minutes immediately after sending the command, it will then revert to unknown state.  This makes it work easier with voice assistants since you can always tell it to lock/unlock as some devices will not resend the lock/unlock command if it thinks the device is already locked/unlocked.

### Location
Vehicle location is automatically updated on startup and whenever the polling loop detects an odometer change, meaning the vehicle has moved.  There is also a button entity available to trigger a location update on demand.  The location API is limited to one call every 10 minutes.

## Installation

### Home Assistant Addon

1. In Home Assistant, go to **Settings > Apps > Install App**
2. Click the **three-dot menu** (top right) and select **Repositories**
3. Add this repository URL:
   ```
   https://github.com/tsightler/honstar-mqtt
   ```
4. Find **HOnStar MQTT** in the add-on store and click **Install**
5. Go to the addon **Configuration** tab and fill in your settings:
   - **hws_email** — Your Honda/Acura account email
   - **hws_password** — Your Honda/Acura account password
   - **hws_pin** — Your account PIN (required for climate preconditioning)
   - **vin** — Your vehicle's VIN (optional, defaults to first vehicle)
   - **mqtt_url** — MQTT broker URL (leave default to auto-discover from the Mosquitto addon)
   - **poll_interval** — Seconds between vehicle polls (minimum/default: 900)
   - **debug** — Enable debug logging (default: false)
6. Click **Start**

The addon will automatically connect to your MQTT broker and create Home Assistant entities via MQTT discovery.

### Docker

```bash
docker run -d \
  --name honstar-mqtt \
  --restart unless-stopped \
  -e HWS_USERNAME="your@email.com" \
  -e HWS_PASSWORD="yourpassword" \
  -e HWS_PIN="1234" \
  -e VIN="YOUR_VIN" \
  -e MQTT_URL="mqtt://user:password@mqtt-broker:1883" \
  -e POLL_INTERVAL=900 \
  -e DEBUG=false \
  ghcr.io/tsightler/honstar-mqtt-amd64
```

Replace `amd64` with your architecture (`aarch64`, `armv7`, `armhf`) if needed.

#### Docker Compose

```yaml
services:
  honstar-mqtt:
    image: ghcr.io/tsightler/honstar-mqtt-amd64
    container_name: honstar-mqtt
    restart: unless-stopped
    environment:
      - USERNAME=your@email.com
      - PASSWORD=yourpassword
      - PIN=1234
      - VIN=YOUR_VIN
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
export HWS_USERNAME="your@email.com"
export HWS_PASSWORD="yourpassword"
export HWS_PIN="1234"
export VIN="YOUR_VIN"
export MQTT_URL="mqtt://user:password@localhost:1883"
export POLL_INTERVAL=900

node index.js
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HWS_USERNAME` | Yes | Honda/Acura account email |
| `HWS_PASSWORD` | Yes | Honda/Acura account password |
| `HWS_PIN` | No | Account PIN (required for climate preconditioning) |
| `VIN` | No | Vehicle VIN (defaults to first vehicle on account) |
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
| EV Charge Complete | Sensor | Estimated time until charge complete |
| EV Charge Rate | Sensor | Estimated charging rate (kW) |
| Lock | Lock | Lock/unlock vehicle (shows unknown after a few minutes) |
| Location | Device Tracker | Vehicle GPS location |
| Update Location | Button | Trigger on-demand location update |
| Climate Preconditioning | Switch | Start/stop cabin preconditioning |
| Climate Temperature | Number | Preconditioning target temp (60-90°F) |
| Tire Pressure (x4) | Sensor | Individual tire pressures (psi) |

## How It Works

The app follows the same authentication and data flow as the official Honda/Acura EV app:

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

## Technical Notes

- The vehicle must have cellular connectivity to respond to dashboard requests.
- Climate preconditioning auto-turns off after 60 minutes (vehicle limitation).
- The BEV3 telematics platform is used by Acura ZDX, Honda Prologue, and similar GM-platform vehicles.
- Access tokens are long-lived (~180 days) but the CIG JWT expires in ~30 minutes.
- Requires Node.js 18+.

## Security Notice

This application requires your Honda/Acura account credentials. Keep them secure and never commit them to version control. Use environment variables or the Home Assistant addon configuration (which stores them encrypted).

## License

MIT — for personal/educational use. This is an unofficial client based on reverse engineering.
