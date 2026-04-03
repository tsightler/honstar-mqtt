# Changelog

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
