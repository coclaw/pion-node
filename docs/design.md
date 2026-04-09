# pion-node Design

## Goal

pion-node is a Node.js SDK that wraps the [pion-ipc](https://github.com/nicosmd/pion-ipc) Go process, providing a high-level, W3C-flavored API for WebRTC PeerConnections and DataChannels. It aims to be a drop-in replacement for native WebRTC libraries in Node.js with minimal API friction.

## Architecture Overview

```
Application Code
    |
    |  PeerConnection / DataChannel (async API)
    |
pion-node SDK
    |  PionIpc (process + IPC management)
    |
    |  spawn + stdin/stdout framing
    |
pion-ipc (Go binary)
    |
    └── Pion WebRTC
```

The SDK has three layers:

1. **PionIpc**: Spawns the Go process, manages the IPC read/write streams, correlates request/response pairs by ID, and re-emits events via Node.js EventEmitter.
2. **PeerConnection**: W3C-style wrapper that translates high-level method calls into IPC requests and filters events by `pcId`.
3. **DataChannel**: W3C-style wrapper that translates send/close/bufferedAmount operations into IPC requests and filters events by `pcId` + `dcLabel`.

## Key Design Decisions

### Why Not Expose the IPC Layer Directly

The raw IPC protocol requires callers to manage request IDs, encode/decode msgpack payloads, and route events manually. The SDK provides:

- Automatic request ID management and timeout handling.
- Object-oriented PeerConnection/DataChannel instances with event filtering.
- Proper async/await interfaces instead of raw frame callbacks.
- Transparent msgpack encoding/decoding for payloads.

This reduces the typical usage from ~50 lines of IPC frame management to a few lines of familiar WebRTC-like code.

### Event Filtering by pcId and dcLabel

The Go process emits all events on a single stdout stream. The SDK routes them using a two-level filtering scheme:

- PionIpc re-emits every event by its event name (e.g., `pc.statechange`, `dc.message`).
- PeerConnection subscribes to PC-level events and filters by `pcId`, ignoring events from other PeerConnections.
- DataChannel subscribes to DC-level events and filters by both `pcId` and `dcLabel`.

When a PeerConnection or DataChannel is closed, its event listeners are detached from the PionIpc emitter to prevent leaks.

### send() is Async

In the W3C API, `RTCDataChannel.send()` is synchronous and throws if the buffer is full. In pion-node, `send()` is async — it writes a request frame, waits for the Go process to acknowledge the send, and resolves.

This design provides natural backpressure: if the Go-side send buffer is full or the write is slow, the promise takes longer to resolve, and the caller naturally slows down. There is no need for try/catch retry loops around synchronous sends.

The tradeoff is an IPC round-trip per send. For high-throughput scenarios, callers can batch or pipeline sends.

### getBufferedAmount() is Async

Unlike the W3C API where `bufferedAmount` is a synchronous property, `getBufferedAmount()` is an async method that performs an IPC round trip. This is because the buffered amount lives in the Go process memory.

For flow control, the preferred approach is to use `setBufferedAmountLowThreshold()` and listen for `bufferedamountlow` events, which avoids polling.

### Process Lifecycle Management

The PionIpc class manages the Go process lifecycle:

- **start()**: Spawns the process, sets up stream readers, and verifies readiness with a `ping` request. If the ping fails, the process is killed and the error is thrown.
- **stop()**: Closes stdin (signaling the Go process to exit gracefully), waits for the process to exit with a configurable timeout, and sends SIGTERM if the timeout expires.
- **Crash handling**: If the process exits unexpectedly, all pending requests are rejected, and an `exit` event is emitted. The caller can implement restart logic as needed.

### Binary Distribution

The Go binary is resolved at runtime in priority order:

1. `PION_IPC_BIN` environment variable (explicit path).
2. `pion-ipc` on the system PATH.

This keeps the npm package lightweight (no bundled binaries) and allows users to manage the Go binary through their preferred method (system package manager, Docker image, CI artifact, etc.).

## Differences from the W3C WebRTC API

| W3C API | pion-node | Reason |
|---------|-----------|--------|
| `new RTCPeerConnection(config)` | `new PeerConnection(ipc, id, iceServers)` + `await pc.init()` | Explicit initialization — the Go-side PeerConnection is created asynchronously via IPC |
| `pc.createOffer()` returns `RTCSessionDescription` | Returns `{ type, sdp }` | Same structure, no wrapper class |
| `pc.setLocalDescription(desc)` | `await pc.setLocalDescription(desc)` | Async due to IPC round trip |
| `pc.restartIce()` marks ICE restart (void) | `await pc.restartIce()` returns `{ type: 'offer', sdp }` | Combines restart + createOffer + setLocalDescription in one call |
| `dc.send(data)` is synchronous, throws on full buffer | `await dc.send(data)` is async | IPC round trip provides natural backpressure |
| `dc.bufferedAmount` is a property | `await dc.getBufferedAmount()` is a method | Value lives in the Go process |
| Events via `addEventListener` / `onX` callbacks | Events via Node.js EventEmitter (`on`, `once`, `off`) | Idiomatic for Node.js |
| `onicecandidate` receives `RTCPeerConnectionIceEvent` | `icecandidate` event receives `{ candidate, sdpMid, sdpMLineIndex }` | Flat object instead of wrapper |
| `ondatachannel` receives `RTCDataChannelEvent` | `datachannel` event receives `{ channel, ordered }` | `channel` is a pion-node DataChannel instance |
| `onmessage` receives `MessageEvent` | `message` event receives `{ data, isBinary }` | `data` is a string (text) or Buffer (binary) |

## Known Limitations

- **DataChannel only**: Audio/video tracks are not supported (mirrors the pion-ipc limitation).
- **No `RTCSessionDescription` / `RTCIceCandidate` classes**: Plain objects are used throughout. This simplifies serialization but means instanceof checks won't work.
- **Single Go process per PionIpc instance**: Multiple PeerConnections share one process. If the process crashes, all PeerConnections are lost. For isolation, create multiple PionIpc instances.
- **No automatic reconnection**: If the Go process exits, the caller must create a new PionIpc instance and re-establish PeerConnections. The SDK does not attempt automatic recovery.
