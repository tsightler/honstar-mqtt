# Changelog

## [1.7.3] - 2026-04-17

### Changed
- Use cumulative average for all charge rate inputs

## [1.7.2] - 2026-04-16

### Added
- Add range based charging rate estimation

## [1.7.1] - 2026-04-14

### Changed
- Poll on fixed interval at random offset

## [1.7.0] - 2026-04-13

### Changed
- Use combined average charge rate estimator
- Replace common headers with single function
- Implement new dashboard

## [1.6.4] - 2026-04-09

### Changed
- Rewrite async API/MQTT request handler

## [1.6.3] - 2026-04-08

### Fixed
- Fix calculated SOC rounding

## [1.6.2] - 2026-04-08

### Changed
- Publish calcualted SOC in dashboard when using fallback
- Improve tire pressure console output formatting

## [1.6.1] - 2026-04-08

### Changed
- Allow parallel commands
- Subscribe to MQTT topic with single wildcard

### Fixed
- Fix crash when all dashboard requests fail

## [1.6.0] - 2026-04-08

### Changed
- Use common AWS MQTT connection for all commands

## [1.5.9] - 2026-04-07

### Changed
- Timezone detection fixes

## [1.5.8] - 2026-04-07

### Changed
- Fallback to calculated value when stale SOC data is detected

## [1.5.7] - 2026-04-07

### Changed
- Detect timezone via vehicle location
- Updated logos

## [1.5.6] - 2026-04-05

### Changed
- New charge rate estimator
- More robust recovery from API failures
- Update README.md

## [1.5.5] - 2026-04-04

### Changed
- More charge rate estimate tweaks
- Retry location updates on next poll if API fails

## [1.5.4] - 2026-04-03

### Fixed
- Fix polling loop hang...again!

## [1.5.3] - 2026-04-03

### Changed
- Use timeout on HTTP requests

## [1.5.2] - 2026-04-03

### Added
- Add version to log banner

### Fixed
- Fix location not updating on odometer change

## [1.5.1] - 2026-04-03

### Changed
- Trigger location update on odometer change



## [1.5.0] - 2026-04-02

### Changed
- Implement location device tracker entity

## [1.4.9] - 2026-04-02

### Changed
- More estimated charge rate tweaks

## [1.4.8] - 2026-04-01

### Changed
- Charge rate estimation tweaks
- Lock/Unlock to Unknown after 2 minutes

## [1.4.7] - 2026-03-29

### Changed
- Improve charge rate estimate

## [1.4.1-1.4.6] - 2026-03-29

### Fixed
- Fix PIN not working
- Fix charge rate estimate

### Added
- Add charge completion and estimated  kW
- Add locking./unlocking state

### Changed
- Use MQTT Device Tracker for location
- Rmoved EV prefix from charging and battery entities

## [1.4.0] - 2026-03-29

### Added
- Add lock/unlock/locate
- Add logo

### Changed
- Fox image cleanup action


## [1.3.1] - 2026-03-24

### Fixed
- Fixed incorrect environment variables
- Updated Docker actions to new versions

## [1.3.0] - 2026-03-24

### Changed
- Rebranded project to honstar-mqtt
- Updated icons/logos
- Updated release scripts and repository configuration

## [1.2.3-1.2.6] - 2026-02-12

### Fixed
- Fixed various rounding/precision issues

### Changed
- Minor tweaks and cleanups
- Updated README

## [1.2.2] - 2026-02-12

### Fixed
- Fixed target charge level race condition

### Changed
- Improved charge target/climate command queue functions

## [1.2.1] - 2026-02-12

### Fixed
- Updated climate switch state immediately on command

### Changed
- Reduced tire pressure display precision to single decimal

## [1.2.0] - 2026-02-11

### Added
- Added support for climate start/stop
- Added support for client preconditioning on/off

## [1.1.2] - 2026-02-11

### Changed
- Improved set target charge level failure handling

## [1.1.1] - 2026-02-11

### Changed
- Poll for target charge level multiple times after set command
- Branding updates

## [1.1.0] - 2026-02-11

### Changed
- Refactored codebase into modules
- Optimized set command handling

## [1.0.1] - 2026-02-10

### Fixed
- Fixed Docker build

## [1.0.0] - 2026-02-10

### Added
- Initial release
- MQTT connection support
- MQTT auto-discovery for Home Assistant
- Docker and Home Assistant add-on support
- Target charge level control
