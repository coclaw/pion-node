# pion-node

Node.js SDK for [pion-ipc](https://github.com/coclaw/pion-ipc) — spawn and manage a Go-based WebRTC process via stdin/stdout binary IPC, exposing a W3C-style PeerConnection/DataChannel API.

## Install

```bash
npm install @coclaw/pion-node
```

You also need the `pion-ipc` Go binary. Either:
- Set `PION_IPC_BIN` environment variable to the binary path
- Add `pion-ipc` to your system `PATH`

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

- `new RTCPeerConnection({ _ipc, iceServers?, _pcId? })` -- create (pcId defaults to UUID)
- `createOffer()` / `createAnswer()` -- SDP negotiation
- `setRemoteDescription(desc)` / `setLocalDescription(desc)`
- `addIceCandidate(candidate)`
- `restartIce()` -- ICE restart, returns new offer
- `createDataChannel(label, opts?)` -- create DataChannel (synchronous, W3C-compatible)
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

## License

Apache-2.0
