# pion-node

Node.js SDK for [pion-ipc](https://github.com/nicosmd/pion-ipc) -- spawn and manage a Go-based WebRTC process via stdin/stdout binary IPC, exposing a W3C-style PeerConnection/DataChannel API.

## Install

```bash
npm install pion-node
```

You also need the `pion-ipc` Go binary. Either:
- Set `PION_IPC_BIN` environment variable to the binary path
- Add `pion-ipc` to your system `PATH`

## Usage

```js
import { PionIpc, PeerConnection } from 'pion-node';

const ipc = new PionIpc();
await ipc.start();

const pc = new PeerConnection(ipc, 'my-peer', [
  { urls: ['stun:stun.l.google.com:19302'] }
]);
await pc.init();

const dc = await pc.createDataChannel('chat');
dc.on('open', () => {
  dc.send('hello!');
});
dc.on('message', (msg) => {
  console.log('received:', msg.data);
});

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
- Events: `'error'`, `'exit'`, and all Go-side events (`'pc.icecandidate'`, `'dc.message'`, etc.)

### `PeerConnection`

- `new PeerConnection(ipc, pcId, iceServers?)` -- create wrapper
- `init()` -- create peer connection on Go side
- `createOffer()` / `createAnswer()` -- SDP negotiation
- `setRemoteDescription(desc)` / `setLocalDescription(desc)`
- `addIceCandidate(candidate)`
- `restartIce()` -- ICE restart
- `createDataChannel(label, opts?)` -- create DataChannel
- `close()`
- Events: `'icecandidate'`, `'connectionstatechange'`, `'iceconnectionstatechange'`, `'selectedcandidatepairchange'`, `'icegatheringstatechange'`, `'signalingstatechange'`, `'datachannel'`

### `DataChannel`

- `send(data)` -- send string or Buffer
- `close()`
- `getBufferedAmount()` / `setBufferedAmountLowThreshold(n)`
- Events: `'open'`, `'close'`, `'message'`, `'error'`, `'bufferedamountlow'`

## License

Apache-2.0
