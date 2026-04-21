# pion-node

Node.js SDK for [pion-ipc](https://github.com/coclaw/pion-ipc) — spawn and manage a Go-based WebRTC process via stdin/stdout binary IPC, exposing a W3C-style PeerConnection/DataChannel API.

## Install

```bash
npm install @coclaw/pion-node
```

The `pion-ipc` Go binary is resolved in this order:

1. **`PION_IPC_BIN` env var** — explicit path to the binary
2. **npm platform package** — `@coclaw/pion-ipc-{platform}-{arch}` installed via `optionalDependencies` (automatic on `npm install`)
3. **System PATH** — `pion-ipc` found on `$PATH`

On supported platforms (linux-x64, linux-arm64, linux-arm, darwin-x64, darwin-arm64, win32-x64), the binary is automatically installed via npm. No manual setup needed.

## Usage

```js
import { PionIpc, RTCPeerConnection } from 'pion-node';

const ipc = new PionIpc();
await ipc.start();

const pc = new RTCPeerConnection({
  _ipc: ipc,
  iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
});

const dc = pc.createDataChannel('chat');
dc.onopen = () => {
  dc.send('hello!');
};
dc.onmessage = (evt) => {
  console.log('received:', evt.data);
};

pc.onicecandidate = (evt) => {
  // send evt.candidate to remote peer via signaling
};

// Diagnostic: log selected candidate pair (host/srflx/relay)
pc.onselectedcandidatepairchange = () => {
  const pair = pc.selectedCandidatePair;
  console.log(`${pair.local.type} ↔ ${pair.remote.type}`);
};

const offer = await pc.createOffer();
// ... exchange SDP with remote peer ...

// Clean up
await pc.close();
await ipc.stop();
```

## IPC Protocol

Binary framing over stdin/stdout:

```
[4B total_length LE] [2B header_length LE] [msgpack header] [raw payload]
```

Message types:
- **req** (request): `{ type, id, method, pcId?, dcLabel?, isBinary? }` + payload
- **res** (response): `{ type, id, ok, error? }` + payload
- **evt** (event): `{ type, event, pcId?, dcLabel?, isBinary? }` + payload

Max frame size: 16 MiB.

## API

### `PionIpc`

- `new PionIpc({ binPath?, logger?, timeout? })` -- create instance
- `start()` -- spawn process, verify with ping
- `stop(timeout?)` -- graceful shutdown
- `request(method, opts?, payload?)` -- send RPC request, returns `{ header, payload }`
- Events: `'error'`, `'exit'`, and all Go-side events

### `RTCPeerConnection`

- `new RTCPeerConnection({ _ipc, iceServers?, settings?, _pcId? })` -- create (pcId defaults to UUID)
- `createOffer()` / `createAnswer()` -- SDP negotiation
- `setRemoteDescription(desc)` / `setLocalDescription(desc)`
- `addIceCandidate(candidate)`
- `restartIce()` -- ICE restart, returns new offer
- `createDataChannel(label, opts?)` -- create DataChannel (synchronous, W3C-compatible)
- `getSctpStats()` -- snapshot of the underlying SCTP association (see below)
- `close()`
- Getters: `connectionState`, `iceConnectionState`, `iceGatheringState`, `signalingState`, `selectedCandidatePair`
- Events: `'icecandidate'`, `'connectionstatechange'`, `'iceconnectionstatechange'`, `'selectedcandidatepairchange'`, `'icegatheringstatechange'`, `'signalingstatechange'`, `'datachannel'`
- `on*` property handlers for all events

### `RTCDataChannel`

- `send(data)` -- send string or Buffer (synchronous, W3C-compatible)
- `close()`
- Getters: `label`, `ordered`, `readyState`, `bufferedAmount`
- `bufferedAmountLowThreshold` getter/setter
- Events: `'open'`, `'close'`, `'message'`, `'error'`, `'bufferedamountlow'`
- `on*` property handlers for all events

**Note on `bufferedAmount`**: Returns the sum of JS-side send queue size and Go-side SCTP buffer (dual-source tracking). The Go-side value is updated from each `dc.send` ack and refreshed on `bufferedamountlow` events, providing accurate flow control without manual queries.

### `settings` — pion SettingEngine knobs

Optional per-PeerConnection configuration, forwarded to the Go side at `pc.create` time. Every field is independently optional; omitted fields use pion defaults. Duration fields are in **milliseconds** (numbers). Values above 300000 ms (5 minutes) are rejected with an error — no PeerConnection is created.

| Field | Type | Pion method | Pion default |
|---|---|---|---|
| `sctpRtoMax` | number (ms) | `SetSCTPRTOMax` | 60000 |
| `sctpMaxReceiveBufferSize` | number (bytes) | `SetSCTPMaxReceiveBufferSize` | (pion sctp package default) |
| `iceDisconnectedTimeout` | number (ms) | `SetICETimeouts` (arg 1) | 5000 |
| `iceFailedTimeout` | number (ms) | `SetICETimeouts` (arg 2) | 25000 |
| `iceKeepAliveInterval` | number (ms) | `SetICETimeouts` (arg 3) | 2000 |
| `stunGatherTimeout` | number (ms) | `SetSTUNGatherTimeout` | 5000 |

The three ICE timeout fields share a single pion setter. If the caller specifies any of them, the unspecified fields fall back to the pion defaults listed above.

```js
const pc = new RTCPeerConnection({
  _ipc: ipc,
  iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
  settings: {
    sctpRtoMax: 10000,   // shorten worst-case SCTP backoff after long idle
    iceFailedTimeout: 15000,
  },
});
```

### `getSctpStats()` — SCTP association snapshot

Returns a snapshot of the underlying SCTP association. Useful for diagnosing stalls after long idle periods — correlating `congestionWindow` and `bytesSent` deltas over time reveals whether the sender is stuck in loss recovery (cwnd collapsed back to ~1 MTU with bytesSent flat across samples).

Return values:

- An object with the fields below, once the SCTP association is up.
- `null` when the association has not yet been established (before DTLS handshake completes).
- After `close()` the call **rejects** with the underlying IPC error — the PeerConnection no longer exists on the Go side.

| Field | Type | Unit | Description |
|---|---|---|---|
| `bytesSent` | number | bytes | Cumulative bytes sent on the SCTP association |
| `bytesReceived` | number | bytes | Cumulative bytes received on the SCTP association |
| `srttMs` | number | ms | Smoothed round-trip time; `0` before first RTT measurement |
| `congestionWindow` | number | bytes | Current congestion window (cwnd) |
| `receiverWindow` | number | bytes | Peer's receiver window (rwnd) |
| `mtu` | number | bytes | Current MTU |

```js
const stats = await pc.getSctpStats();
if (stats === null) {
  console.log('SCTP association not yet established');
} else {
  console.log(`cwnd=${stats.congestionWindow} srtt=${stats.srttMs}ms sent=${stats.bytesSent}`);
}
```

**Not exposed** (no public pion API in v1.8.36): current RTO value, t3RTX backoff level (`nRtos`), inflight chunk count. These would require upstream pion changes.

**Do not call at high frequency**. The call internally walks the PeerConnection's transceivers, candidates, and data channels. A 5-10 s sampling cadence is fine; tighter than 1 s across many PeerConnections is wasteful.

## License

Apache-2.0
