import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { encode } from '@msgpack/msgpack';
import { RTCPeerConnection } from '../src/peer-connection.js';

// Mock IPC: records all request calls and returns mock responses
function createMockIpc() {
	const ipc = new EventEmitter();
	ipc.requests = [];
	ipc.request = async (method, opts, payload) => {
		ipc.requests.push({ method, opts, payload });
		if (method === 'pc.createOffer' || method === 'pc.createAnswer' || method === 'pc.restartIce') {
			return { header: {}, payload: Buffer.from(encode({ sdp: 'mock-sdp' })) };
		}
		return { header: {}, payload: Buffer.alloc(0) };
	};
	return ipc;
}

test('constructor sends pc.create with pcId and iceServers', async () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({
		iceServers: [{ urls: 'stun:stun.example.com' }],
		_ipc: ipc,
		_pcId: 'pc-1',
	});

	// Wait for deferred init
	await pc._ready;

	assert.equal(ipc.requests.length, 1);
	assert.equal(ipc.requests[0].method, 'pc.create');
	assert.deepEqual(ipc.requests[0].payload, {
		pcId: 'pc-1',
		iceServers: [{ urls: 'stun:stun.example.com' }],
	});
});

test('pcId defaults to a UUID when not provided', () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc });

	// pcId should be a UUID-like string
	assert.ok(typeof pc._pcId === 'string');
	assert.ok(pc._pcId.length > 0);
});

test('createOffer returns { type: "offer", sdp }', async () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	const offer = await pc.createOffer();
	assert.equal(offer.type, 'offer');
	assert.equal(offer.sdp, 'mock-sdp');
	// requests[0] is pc.create, requests[1] is pc.createOffer
	assert.equal(ipc.requests[1].method, 'pc.createOffer');
});

test('createAnswer returns { type: "answer", sdp }', async () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	const answer = await pc.createAnswer();
	assert.equal(answer.type, 'answer');
	assert.equal(answer.sdp, 'mock-sdp');
	assert.equal(ipc.requests[1].method, 'pc.createAnswer');
});

test('setRemoteDescription sends type and sdp', async () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	await pc.setRemoteDescription({ type: 'offer', sdp: 'remote-sdp' });
	assert.equal(ipc.requests[1].method, 'pc.setRemoteDescription');
	assert.equal(ipc.requests[1].opts.pcId, 'pc-1');
	assert.deepEqual(ipc.requests[1].payload, { type: 'offer', sdp: 'remote-sdp' });
});

test('setLocalDescription sends pc.setLocalDescription', async () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	await pc.setLocalDescription({ type: 'answer', sdp: 'local-sdp' });
	assert.equal(ipc.requests[1].method, 'pc.setLocalDescription');
	assert.deepEqual(ipc.requests[1].payload, { type: 'answer', sdp: 'local-sdp' });
});

test('addIceCandidate sends candidate fields', async () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	await pc.addIceCandidate({
		candidate: 'candidate:123',
		sdpMid: '0',
		sdpMLineIndex: 0,
	});
	assert.equal(ipc.requests[1].method, 'pc.addIceCandidate');
	assert.deepEqual(ipc.requests[1].payload, {
		candidate: 'candidate:123',
		sdpMid: '0',
		sdpMLineIndex: 0,
	});
});

test('restartIce returns offer', async () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	const offer = await pc.restartIce();
	assert.equal(offer.type, 'offer');
	assert.equal(offer.sdp, 'mock-sdp');
	assert.equal(ipc.requests[1].method, 'pc.restartIce');
});

test('createDataChannel returns RTCDataChannel synchronously', async () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	const dc = pc.createDataChannel('rpc', { ordered: false });

	// Should return synchronously (not a promise)
	assert.equal(dc.label, 'rpc');
	assert.equal(dc.ordered, false);
	assert.equal(dc.readyState, 'connecting');

	// Wait for async init to complete
	await new Promise((r) => setTimeout(r, 50));

	// Should have sent pc.create then dc.create
	const dcReq = ipc.requests.find((r) => r.method === 'dc.create');
	assert.ok(dcReq);
	assert.deepEqual(dcReq.payload, { label: 'rpc', ordered: false });
});

test('createDataChannel ordered defaults to true', async () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	const dc = pc.createDataChannel('data');
	assert.equal(dc.ordered, true);

	await new Promise((r) => setTimeout(r, 50));

	const dcReq = ipc.requests.find((r) => r.method === 'dc.create');
	assert.deepEqual(dcReq.payload, { label: 'data', ordered: true });
});

test('icecandidate event wraps candidate in W3C format', () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	const events = [];
	pc.on('icecandidate', (e) => events.push(e));

	ipc.emit('pc.icecandidate', {
		pcId: 'pc-1',
		payload: Buffer.from(encode({
			candidate: 'candidate:1',
			sdpMid: '0',
			sdpMLineIndex: 0,
		})),
	});

	assert.equal(events.length, 1);
	assert.deepEqual(events[0], {
		candidate: {
			candidate: 'candidate:1',
			sdpMid: '0',
			sdpMLineIndex: 0,
		},
	});
});

test('icecandidate event filters by pcId', () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	const events = [];
	pc.on('icecandidate', (e) => events.push(e));

	// Non-matching
	ipc.emit('pc.icecandidate', {
		pcId: 'pc-other',
		payload: Buffer.from(encode({
			candidate: 'candidate:2',
			sdpMid: '0',
			sdpMLineIndex: 0,
		})),
	});

	assert.equal(events.length, 0);
});

test('connectionstatechange does not pass arguments (W3C)', () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	assert.equal(pc.connectionState, 'new');
	assert.equal(pc.iceConnectionState, 'new');

	const callArgs = [];
	pc.on('connectionstatechange', (...args) => callArgs.push(args));

	ipc.emit('pc.statechange', {
		pcId: 'pc-1',
		payload: Buffer.from(encode({ connState: 'connected', iceState: 'connected' })),
	});

	assert.equal(pc.connectionState, 'connected');
	assert.equal(pc.iceConnectionState, 'connected');
	assert.equal(callArgs.length, 1);
	assert.equal(callArgs[0].length, 0); // no arguments passed
});

test('iceconnectionstatechange event fires separately', () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	const iceEvents = [];
	pc.on('iceconnectionstatechange', () => iceEvents.push(pc.iceConnectionState));

	ipc.emit('pc.statechange', {
		pcId: 'pc-1',
		payload: Buffer.from(encode({ connState: 'connected', iceState: 'checking' })),
	});

	assert.equal(iceEvents.length, 1);
	assert.equal(iceEvents[0], 'checking');
});

test('datachannel event wraps channel in W3C format', () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	const channels = [];
	pc.on('datachannel', (e) => channels.push(e));

	ipc.emit('pc.datachannel', {
		pcId: 'pc-1',
		dcLabel: 'remote-dc',
		payload: Buffer.from(encode({ ordered: true })),
	});

	assert.equal(channels.length, 1);
	assert.equal(channels[0].channel.label, 'remote-dc');
	// W3C format: { channel }, no extra 'ordered' at top level
	assert.ok(!('ordered' in channels[0]));
});

test('on* property setters work', () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	// Initially null
	assert.equal(pc.onicecandidate, null);
	assert.equal(pc.onconnectionstatechange, null);
	assert.equal(pc.oniceconnectionstatechange, null);
	assert.equal(pc.ondatachannel, null);

	// Set handler
	const calls = [];
	pc.onconnectionstatechange = () => calls.push('a');

	ipc.emit('pc.statechange', {
		pcId: 'pc-1',
		payload: Buffer.from(encode({ connState: 'connected', iceState: 'connected' })),
	});
	assert.equal(calls.length, 1);

	// Replace handler
	pc.onconnectionstatechange = () => calls.push('b');

	ipc.emit('pc.statechange', {
		pcId: 'pc-1',
		payload: Buffer.from(encode({ connState: 'failed', iceState: 'connected' })),
	});
	assert.equal(calls.length, 2);
	assert.equal(calls[1], 'b');

	// Clear handler
	pc.onconnectionstatechange = null;

	ipc.emit('pc.statechange', {
		pcId: 'pc-1',
		payload: Buffer.from(encode({ connState: 'closed', iceState: 'connected' })),
	});
	assert.equal(calls.length, 2); // no new calls
});

test('close detaches all listeners', async () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	// Create a DataChannel
	pc.createDataChannel('test-dc');
	await new Promise((r) => setTimeout(r, 50));

	const iceBefore = ipc.listenerCount('pc.icecandidate');
	const stateBefore = ipc.listenerCount('pc.statechange');
	const dcBefore = ipc.listenerCount('pc.datachannel');

	await pc.close();

	assert.equal(ipc.listenerCount('pc.icecandidate'), iceBefore - 1);
	assert.equal(ipc.listenerCount('pc.statechange'), stateBefore - 1);
	assert.equal(ipc.listenerCount('pc.datachannel'), dcBefore - 1);
});

test('initial connectionState is new, iceConnectionState is new', () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	assert.equal(pc.connectionState, 'new');
	assert.equal(pc.iceConnectionState, 'new');
});

test('statechange with same connState does not emit connectionstatechange', () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	const connEvents = [];
	const iceEvents = [];
	pc.on('connectionstatechange', () => connEvents.push(pc.connectionState));
	pc.on('iceconnectionstatechange', () => iceEvents.push(pc.iceConnectionState));

	// First: both change
	ipc.emit('pc.statechange', {
		pcId: 'pc-1',
		payload: Buffer.from(encode({ connState: 'connected', iceState: 'connected' })),
	});
	assert.equal(connEvents.length, 1);
	assert.equal(iceEvents.length, 1);

	// Same connState, different iceState: only iceconnectionstatechange
	ipc.emit('pc.statechange', {
		pcId: 'pc-1',
		payload: Buffer.from(encode({ connState: 'connected', iceState: 'disconnected' })),
	});
	assert.equal(connEvents.length, 1); // no change
	assert.equal(iceEvents.length, 2);
});

test('_ready reject after pc.create failure propagates to methods', async () => {
	const ipc = createMockIpc();
	ipc.request = async (method) => {
		if (method === 'pc.create') throw new Error('create failed');
		return { header: {}, payload: Buffer.alloc(0) };
	};
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-fail' });

	await assert.rejects(
		() => pc.createOffer(),
		{ message: 'create failed' },
	);
});

test('close is safe when _ipc is not provided', async () => {
	const pc = new RTCPeerConnection({ _pcId: 'no-ipc' });
	// Should not throw
	await pc.close();
	assert.equal(pc.connectionState, 'closed');
});

test('close is safe when pc.create failed', async () => {
	const ipc = createMockIpc();
	ipc.request = async (method) => {
		if (method === 'pc.create') throw new Error('create failed');
		return { header: {}, payload: Buffer.alloc(0) };
	};
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-fail' });

	// Wait for init to fail
	await new Promise((r) => setTimeout(r, 50));

	// close should not throw and should not call pc.close IPC
	await pc.close();
	assert.equal(pc.connectionState, 'closed');
});
