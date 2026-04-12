# pion-node Design

## Goal

pion-node is a Node.js SDK that wraps the [pion-ipc](https://github.com/coclaw/pion-ipc) Go process, providing a W3C WebRTC-compatible API for PeerConnections and DataChannels. It aims to be API-compatible with the node-datachannel polyfill, enabling drop-in replacement in Node.js applications.

## Architecture Overview

```
Application Code
    |
    |  RTCPeerConnection / RTCDataChannel (W3C-compatible API)
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
2. **RTCPeerConnection**: W3C-compatible wrapper that translates high-level method calls into IPC requests and filters events by `pcId`. Supports `on*` property setters and standard state getters.
3. **RTCDataChannel**: W3C-compatible wrapper with synchronous `send()`, `bufferedAmount` property, `readyState` state machine, and `on*` property setters.

## Key Design Decisions

### Single-Step Construction with Deferred Init

W3C's `new RTCPeerConnection(config)` is a single synchronous call. pion-node follows this pattern:

```javascript
const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.example.com' }],
    _ipc: ipcInstance,      // pion-node extension
    _pcId: 'conn-1',        // pion-node extension (optional, defaults to UUID)
});
```

The constructor synchronously returns and starts an internal `_ready` Promise that sends the `pc.create` IPC request. All async methods (createOffer, setRemoteDescription, etc.) internally `await this._ready` before proceeding.

The `_ipc` and `_pcId` fields use underscore prefix to signal they are pion-node extensions, not part of the W3C spec.

### Synchronous createDataChannel

W3C's `createDataChannel()` returns synchronously. pion-node matches this:

```javascript
const dc = pc.createDataChannel('rpc', { ordered: true });
// dc is immediately usable (RTCDataChannel instance)
// Internal IPC dc.create request runs asynchronously
```

The DataChannel's `_init()` IPC call is chained after the PeerConnection's `_ready` promise. Errors during init are emitted as `'error'` events on the DataChannel.

### Synchronous send() with Internal Queue

W3C's `RTCDataChannel.send()` is synchronous. pion-node implements this with an internal send queue:

1. `send(data)` synchronously validates state, computes payload size, updates `bufferedAmount`, and enqueues the message.
2. An internal `_drainQueue()` method asynchronously processes the queue, sending each message via IPC.
3. After each successful IPC send, `bufferedAmount` is decremented.
4. When the queue is drained and `bufferedAmount <= bufferedAmountLowThreshold`, a `bufferedamountlow` event is emitted.

This provides W3C-compatible synchronous `send()` semantics while maintaining IPC backpressure through the queue.

### bufferedAmount: Dual-Source Tracking (R-Mode)

`bufferedAmount` is a synchronous property returning `_bufferedAmount + _goBufferedBytes`:

- **`_bufferedAmount`**: JS-side estimate — incremented synchronously by `send()`, decremented by the drain loop after each IPC ack.
- **`_goBufferedBytes`**: Go-side SCTP BufferedAmount cache, updated from two sources:
  1. **Drain loop** (primary): Each `dc.send` IPC ack carries the post-send `bufferedAmount` in its payload. The drain loop parses and caches it immediately.
  2. **`_refreshGoBA`** (supplementary): When Go fires a `dc.bufferedamountlow` IPC event, JS issues a `dc.getBA` IPC request to get the current Go-side BA. This prevents stale-cache deadlock — without it, a long-idle DC's `_goBufferedBytes` stays at the last ack value, potentially causing the sender to overestimate BA and refuse to send.

The `_refreshGoBA` path emits `bufferedamountlow` unconditionally after the refresh. This may cause occasional double emission (alongside the drain loop's threshold-cross check), but consumers are idempotent (e.g., `stream.resume()` is a no-op if already flowing). The trade-off favors robustness over strict W3C edge-trigger semantics.

Three layers of close guards in `_refreshGoBA` prevent post-close cache resurrection: sync entry check (`_closed`), async `.then()` check (`_closed || readyState !== 'open'`), and async `.catch()` check.

### on* Property Setters

Both RTCPeerConnection and RTCDataChannel support W3C-style `on*` property setters:

```javascript
pc.onicecandidate = (event) => { ... };
dc.onmessage = (event) => { ... };
```

These are implemented via `Object.defineProperty` on top of EventEmitter, automatically managing listener registration/deregistration when the property is set, replaced, or cleared.

### Event Format Alignment

Events follow W3C conventions:

- **icecandidate**: `{ candidate: { candidate, sdpMid, sdpMLineIndex } | null }` — candidate wrapped in an object.
- **connectionstatechange / iceconnectionstatechange**: No arguments passed to the callback. State is read via `pc.connectionState` / `pc.iceConnectionState` getters.
- **datachannel**: `{ channel: RTCDataChannel }` — no extra fields.
- **message**: `{ data: string | Buffer }` — type determined by `typeof event.data`.

### readyState State Machine

RTCDataChannel tracks `readyState` locally:

- Starts as `'connecting'`
- Transitions to `'open'` on `dc.open` IPC event
- Transitions to `'closed'` on `dc.close` IPC event or explicit `close()` call
- `send()` throws `InvalidStateError` if not `'open'`

### Why Not Expose the IPC Layer Directly

The raw IPC protocol requires callers to manage request IDs, encode/decode msgpack payloads, and route events manually. The SDK provides:

- Automatic request ID management and timeout handling.
- Object-oriented PeerConnection/DataChannel instances with event filtering.
- W3C-compatible interfaces with synchronous send and property-based state access.
- Transparent msgpack encoding/decoding for payloads.

### Event Filtering by pcId and dcLabel

The Go process emits all events on a single stdout stream. The SDK routes them using a two-level filtering scheme:

- PionIpc re-emits every event by its event name (e.g., `pc.statechange`, `dc.message`).
- RTCPeerConnection subscribes to PC-level events and filters by `pcId`, ignoring events from other PeerConnections.
- RTCDataChannel subscribes to DC-level events and filters by both `pcId` and `dcLabel`.

When a PeerConnection or DataChannel is closed, its event listeners are detached from the PionIpc emitter to prevent leaks.

### Process Lifecycle Management

The PionIpc class manages the Go process lifecycle:

- **start()**: Spawns the process, sets up stream readers, and verifies readiness with a `ping` request. If the ping fails, the process is killed and the error is thrown.
- **stop()**: Closes stdin (signaling the Go process to exit gracefully), waits for the process to exit with a configurable timeout, and sends SIGTERM if the timeout expires.
- **Crash handling**: If the process exits unexpectedly, all pending requests are rejected, and an `exit` event is emitted. RTCPeerConnection and RTCDataChannel react to the `exit` event by transitioning to terminal states (see below).

### Crash Recovery: Auto-Restart

When `autoRestart: true` is passed to `PionIpc`, the SDK automatically restarts the Go process after an unexpected exit:

1. **Detection**: The child process `exit` event triggers `_handleProcessExit()`. All pending requests are rejected, `exit` event is emitted (RTCPeerConnection/RTCDataChannel react), and `_proc` is nulled.
2. **Restart**: After an exponential-backoff delay (200ms, 400ms, 800ms, ...), `start()` is called to spawn a new process. On success, a `restart` event is emitted.
3. **Circuit breaker**: If restart fails `maxRestartAttempts` (default 5) times within the `restartResetWindowMs` (default 60s), a `fatal` event is emitted and auto-restart gives up.
4. **Stability reset**: If the process runs stably for `restartResetWindowMs`, the attempt counter resets to zero.
5. **Intentional stop**: `stop()` sets an internal `_intentionalStop` flag and clears any pending restart timer. This prevents auto-restart after deliberate shutdown.

After restart, old PeerConnections/DataChannels are dead (they already transitioned to `failed`/`closed`). New PeerConnections created after restart automatically use the restarted process through the same PionIpc instance. This makes crash recovery transparent to callers — they only observe the standard W3C state transitions.

### Process Crash: State Transitions

When the Go process exits, RTCPeerConnection and RTCDataChannel transition to terminal states immediately, without waiting for or sending any IPC messages:

**RTCPeerConnection** on `ipc.emit('exit')`:
- Force-closes all associated DataChannels via `_forceClose()`
- Sets `connectionState` to `'failed'` and `iceConnectionState` to `'failed'`
- Emits `connectionstatechange` and `iceconnectionstatechange`
- Detaches all IPC event listeners (including the exit listener itself)
- Guard: already `closed` or `failed` PCs are skipped (no double-transition)

**RTCDataChannel** `_forceClose()`:
- Synchronously sets `readyState` to `'closed'`, clears send queue and buffered amount counters
- Emits `close`
- Detaches all IPC event listeners
- Does NOT send `dc.close` IPC (process is dead)
- Guard: already closed channels are skipped

### Binary Distribution

The Go binary is resolved at runtime in priority order:

1. `PION_IPC_BIN` environment variable (explicit path).
2. `pion-ipc` on the system PATH.

This keeps the npm package lightweight (no bundled binaries) and allows users to manage the Go binary through their preferred method (system package manager, Docker image, CI artifact, etc.).

## API Compatibility with W3C / node-datachannel

| W3C API | pion-node | Notes |
|---------|-----------|-------|
| `new RTCPeerConnection(config)` | `new RTCPeerConnection({ iceServers, _ipc, _pcId })` | `_ipc` and `_pcId` are pion-node extensions |
| `pc.createOffer()` | `await pc.createOffer()` | Returns `{ type, sdp }` |
| `pc.createDataChannel(label, opts)` sync | `pc.createDataChannel(label, opts)` sync | Returns RTCDataChannel immediately |
| `pc.connectionState` | `pc.connectionState` | Synchronous getter |
| `pc.iceConnectionState` | `pc.iceConnectionState` | Synchronous getter |
| `pc.onicecandidate = fn` | `pc.onicecandidate = fn` | Supported |
| `dc.send(data)` sync | `dc.send(data)` sync | Queues internally, drains via IPC |
| `dc.bufferedAmount` | `dc.bufferedAmount` | Synchronous getter (local queue tracking) |
| `dc.bufferedAmountLowThreshold` | `dc.bufferedAmountLowThreshold` | Getter/setter, async IPC notify on set |
| `dc.readyState` | `dc.readyState` | `'connecting'` / `'open'` / `'closed'` |
| `dc.ordered` | `dc.ordered` | Synchronous getter |
| `dc.onmessage = fn` | `dc.onmessage = fn` | Supported |
| Events via `addEventListener` | Events via EventEmitter (`on`/`off`) | Node.js idiomatic |

### Remaining Differences

| W3C API | pion-node | Reason |
|---------|-----------|--------|
| `pc.close()` void | `await pc.close()` async | IPC round trip needed to close Go-side resources |
| `dc.close()` void | `await dc.close()` async | Same reason |
| `pc.restartIce()` void | `await pc.restartIce()` returns offer | Combines restart + createOffer + setLocalDescription |
| Events via `addEventListener` | Events via Node.js EventEmitter | Idiomatic for Node.js; `on*` setters bridge the gap |

## Known Limitations

- **DataChannel only**: Audio/video tracks are not supported (mirrors the pion-ipc limitation).
- **No `RTCSessionDescription` / `RTCIceCandidate` classes**: Plain objects are used throughout. This simplifies serialization but means instanceof checks won't work.
- **Single Go process per PionIpc instance**: Multiple PeerConnections share one process. If the process crashes, all PeerConnections are lost (transitioned to `failed`). With `autoRestart: true`, the process is automatically restarted, but old PeerConnections must be recreated.
- **Restart window**: During the brief restart period (~200ms), creating new PeerConnections will fail with "not started". Callers should handle this as a transient error and retry.
