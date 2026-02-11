# Acura EV Connect - Node.js Client

A Node.js application that authenticates to Acura's connected vehicle services and retrieves real-time vehicle status (battery level, range, tire pressures, charge status, odometer, etc.) via MQTT over WebSocket.

Built by reverse-engineering the Acura EV Android app's API flow.

## How It Works

The app follows the same flow as the official Acura EV Android app:

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

The vehicle data is delivered asynchronously — the REST API triggers a request to the vehicle via GM's OnStar/BEV3 platform, and the response arrives over MQTT when the vehicle responds.

## Requirements

- Node.js 18+
- An Acura EV account (the same email/password you use in the Acura EV app)
- A vehicle enrolled in Acura connected services (BEV3 platform — ZDX, etc.)

## Installation

```bash
npm install
```

## Usage

### Command Line

```bash
node index.js <email> <password> [vin]
```

### Environment Variables

```bash
export ACURA_USERNAME="your@email.com"
export ACURA_PASSWORD="yourpassword"
export ACURA_VIN="YOUR_VIN"  # optional, defaults to first vehicle

node index.js
```

### Example Output

```
[1/7] Registering client...
  ✓ client_reg_key: c45b249f...

[2/7] Authenticating...
  ✓ access_token: HZ0L3BtZCf...
  ✓ user: Lynette Sightler

[3/7] Fetching vehicles...
  ✓ 2024 Acura ZDX TYPE S (4W5XHPRL2RZ513937)
    Color: Double Apex Blue Pearl
    Platform: BEV3

[4/7] Getting CIG token for MQTT...
  ✓ CIG JWT: eyJhbGciOiJSUzI1NiJ9.eyJVVUlEIjo...
  ✓ Signature: Ye1XJrPTY524TJzXjbCTtDzYXpYF1J3Q...

[5/7] Connecting to MQTT over WebSocket...
  ✓ MQTT connected!
[6/7] Subscribing to: $aws/things/thing_4W5XHPRL2RZ513937/shadow/name/DASHBOARD_ASYNC/update
  ✓ Subscribed!

[7/7] Requesting dashboard data (async)...
  ✓ Request ID: 4W5XHPRL2RZ513937_1770747187014_...

  ⏳ Waiting for dashboard data via MQTT...

════════════════════════════════════════════════════════════
  VEHICLE DASHBOARD STATUS
════════════════════════════════════════════════════════════
  Timestamp:  2026-02-10T18:13:07Z
  Status:     success

  ⚡ BATTERY & CHARGING
     Charge:        66%
     Range:         183.0 miles
     Charge Status: UNCONNECTED
     Plug Status:   unplugged

  🔢 ODOMETER: 16770 Miles

  🛞 TIRE PRESSURES
     front Right      36.5 PSI (252 kPa)  (OFF)
     front Left       36.5 PSI (252 kPa)  (OFF)
     rear Right       42.9 PSI (296 kPa)  (OFF)
     rear Left        41.8 PSI (288 kPa)  (OFF)

  🔌 CHARGE SETTINGS
     Mode:         CHARGE_NOW
     Target Level: 85%
     Cabin Precond: OFF
     Est. Range at Target: 239 Miles
     Charge Complete: Tuesday 14:45

════════════════════════════════════════════════════════════
```

## API Endpoints Reference

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `identity.services.honda.com/hidas/rs/client/register` | POST | Register app client |
| `identity.services.honda.com/hidas/rs/token/generate` | POST | Login / get bearer token |
| `wsc.hondaweb.com/REST/NGT/MyVehicle/1.0` | GET | List enrolled vehicles |
| `wsc.hondaweb.com/REST/CIG/services/1.0/token` | POST | Get CIG JWT for MQTT auth |
| `wsc.hondaweb.com/REST/NGT/CIG/dbd/async` | POST | Request dashboard data |
| `am7ptks1rwalc-ats.iot.us-east-2.amazonaws.com/mqtt` | WSS | AWS IoT MQTT broker |

## MQTT Topics

- **Dashboard**: `$aws/things/thing_{VIN}/shadow/name/DASHBOARD_ASYNC/update`

## Notes

- The vehicle must have cellular connectivity to respond to dashboard requests.
- Data is delivered asynchronously; the app retries every 10 seconds for up to 60 seconds.
- The BEV3 telematics platform is used by Acura ZDX and similar GM-platform vehicles.
- Access tokens are long-lived (~180 days) but the CIG JWT expires in ~30 minutes.
- The MQTT connection uses AWS IoT's custom authorizer (`CPSD-IOT-CustAuthorizer-prod`).

## Security Notice

This application requires your Acura account credentials. Keep them secure and never commit them to version control. Use environment variables in production.

## License

MIT — for personal/educational use. This is an unofficial client based on reverse engineering.
