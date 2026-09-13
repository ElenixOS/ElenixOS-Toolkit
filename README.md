<p align="center">
  <img src="media/ElenixOSToolkitLogo.png" alt="ElenixOS Toolkit" width="180">
</p>
<h1 align="center">ElenixOS Toolkit</h1>

ElenixOS Toolkit is a VS Code extension for ElenixOS and embedded-device
development. The current implementation focuses on the Native headless
Simulator workflow.

The Simulator remains a normal desktop process while its LVGL output is
displayed in a VS Code Webview.

## Current capabilities

- Native ElenixOS Simulator in headless mode
- LVGL framebuffer display in a VS Code Webview
- Direct WebSocket framebuffer streaming with latest-frame replacement
- Pointer and hardware-button input forwarding
- Automatic Webview connection during Native debugging
- Webview reuse and reconnection after Simulator restart
- YMODEM sending of files and folders over UART
- An ESH-specific interactive terminal over UART
- macOS, Linux, and Windows support for the current Simulator workflow

## Native Simulator Webview

Install/build this extension in VS Code, then open the tracked
`simulator.code-workspace` from `ElenixOS-Simulator`. The Native debug
configurations pass `--headless` and the Toolkit extension listens to VS Code's
debug-session events. Pressing F5 therefore opens the Simulator Webview and
waits for the Simulator's atomic `.ready` handshake; no manual command or
fixed startup delay is needed.

`ElenixOS: Open Simulator` remains available for non-debug sessions. It starts
the configured Native executable with a temporary IPC endpoint. Set
`elenixosToolkit.simulatorPath` when the executable is outside the workspace.

The frame path is a direct connection:

```text
Native Simulator WebSocket server -> Webview Canvas
```

The Simulator owns a loopback WebSocket server and advertises its ephemeral
endpoint in the atomic `.ready` marker. Toolkit only manages the process/debug
session and passes that tokenized URL to the Webview; framebuffer bytes do not
pass through the Extension Host or `Webview.postMessage()`. The URL is bound
to `127.0.0.1` and contains a per-session random token. The existing Native
IPC endpoint remains available for compatibility and control, but is not used
for Webview frame transport. This works on macOS, Linux, and Windows.

The first-version WebSocket frame packet is one binary message containing
only the complete raw RGB565 framebuffer. The Webview dimensions are fixed by
the document bootstrap:

```text
width  = 390
height = 450
stride = width * 2
format = RGB565 little-endian
payload = stride * height raw bytes
```

This deliberately avoids copying the framebuffer just to prepend per-frame
metadata.

The Webview sends `presented` only after the frame has been drawn. The Native
server allows at most one frame in flight and replaces its pending frame with
the newest one, so a slow Webview cannot create a latency queue. Pointer input
is sent as small JSON control messages on the same WebSocket and is injected
directly into the Simulator's existing LVGL input path.

## YMODEM file transfer

Connect the target device's UART and run `ElenixOS: Send File or Folder with
YMODEM (UART)` from the Command Palette. Toolkit asks for the device receive
path, clears the current ESH command line, and automatically sends the command
`ymodem recv <path>` before starting the transfer.

Toolkit selects the UART port and baud rate, then sends a CRC-16 YMODEM batch.
For a folder or multiple files, use an existing directory as the ESH receive
destination; the YMODEM header preserves each folder's relative path. The
Previously selected files and folders are available from the YMODEM history
list, where each entry shows its file name and full path. The Simulator is not
used as the transport for this feature.

The default UART is 921600 baud, 8N1. YMODEM data packets use the standard 1K
STX format. The host writes each complete packet without artificial chunk
pacing and waits for the serial driver's drain completion before waiting for
the receiver's ACK. Adjust
`elenixosToolkit.ymodemWriteChunkSize` and
`elenixosToolkit.ymodemWriteChunkDelayMs`; set both to `0` when the receiver
has adequate buffering or hardware flow control.

The device UART must use the same 921600 8N1 settings. Toolkit cannot change a
target firmware UART configured at another rate; keep the setting synchronized
before starting a transfer.

The YMODEM progress notification shows the cumulative transfer rate and
automatically formats it as `B/s` or `KB/s`.

On completion, Toolkit reports the file size, elapsed time, effective rate,
data-block count, retransmissions, data-block NAKs, and timeouts. A standard
YMODEM NAK has no reason code, so a data-block NAK is a CRC/block-validation
rejection counter rather than proof of a CRC-only error.

While a transfer is active, the status bar provides Pause/Resume and
Terminate controls. Pause takes effect at the next packet boundary; Terminate
cancels the YMODEM session and releases the UART.

Toolkit does not query or estimate device filesystem capacity before sending;
the receiver determines whether the destination has enough space.

## ESH Serial Terminal

Connect the target device's debug UART and run `ElenixOS: Open ESH Terminal`
from the Command Palette. Toolkit lists the available UART ports and uses
`elenixosToolkit.uartBaudRate` (921600 by default). The terminal is a native
VS Code pseudoterminal: ESH owns command editing, history, cursor movement,
echo, and command execution, while VS Code handles ANSI/VT terminal rendering,
scrollback, copy/paste, keyboard input, and resizing.

Run `ElenixOS: Switch ESH Terminal Port` to reconnect the existing terminal to
another device. Only one Toolkit feature may hold a given UART at a time, and
closing the terminal or the extension releases the UART handle.

## IPC format

The compatibility IPC stream uses a 16-byte big-endian header:

```text
magic[4] = EOS1
version : u16 = 1
type    : u16 (HELLO=1, FRAME=2, INPUT=3, HELLO_ACK=4)
length  : u32
sequence: u32
```

`FRAME` contains width, height, stride, format (`1 = rgb565-le`) followed by
raw RGB565 bytes. The WebSocket stream intentionally has no per-frame IPC
header: each binary message is exactly one complete framebuffer. The first
version sends the full 390x450 framebuffer. Both transports replace/drop old
frames instead of accumulating latency.

## Development

```bash
npm install
npm run compile
npm run test:ymodem
npm run benchmark:ymodem
```

The extension implementation is split across `src/simulatorManager.ts`,
`src/ipc.ts`, `src/simulatorWebview.ts`, and `src/debugIntegration.ts` rather
than being concentrated in `extension.ts`.
