# Change Log

## [0.2.0] - 2026-09-13

### Added

- Added `elenixosToolkit.uartMemoryMode` with `window` and `persistent` modes
  for remembering the ESH Terminal's last successfully connected UART port and
  baud rate.
- Added automatic UART configuration restoration with fallback to the normal
  port picker when the remembered device is unavailable.
- Added YMODEM pause, resume, terminate, progress, and transfer statistics
  controls.
- Added YMODEM protocol regression tests and a simulated wire-rate benchmark.

### Changed

- ESH Terminal and YMODEM now share one physical UART session, allowing a
  transfer to run while the terminal remains open.
- Improved UART write scheduling, YMODEM retry handling, cancellation, and
  high-speed transfer behavior.
- Updated the default UART configuration to 921600 baud, 8N1, with standard
  1K YMODEM data blocks and configurable host-side write pacing.

## [0.1.0]

- Initial release
