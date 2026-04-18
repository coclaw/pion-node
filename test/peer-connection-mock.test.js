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
		iceServers: [{ urls: ['stun:stun.example.com'] }],
	});
});

test('constructor normalizes iceServers urls to arrays', async () => {
	const ipc = createMockIpc();

	// string → [string]
	const pc1 = new RTCPeerConnection({
		iceServers: [{ urls: 'turn:turn.example.com', username: 'u', credential: 'c' }],
		_ipc: ipc, _pcId: 'pc-norm-1',
	});
	await pc1._ready;
	assert.deepEqual(pc1._iceServers[0].urls, ['turn:turn.example.com']);
	assert.equal(pc1._iceServers[0].username, 'u');

	// already array → unchanged
	const pc2 = new RTCPeerConnection({
		iceServers: [{ urls: ['stun:a', 'stun:b'] }],
		_ipc: ipc, _pcId: 'pc-norm-2',
	});
	await pc2._ready;
	assert.deepEqual(pc2._iceServers[0].urls, ['stun:a', 'stun:b']);

	// missing urls → []
	const pc3 = new RTCPeerConnection({
		iceServers: [{}],
		_ipc: ipc, _pcId: 'pc-norm-3',
	});
	await pc3._ready;
	assert.deepEqual(pc3._iceServers[0].urls, []);

	// no iceServers → []
	const pc4 = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-norm-4' });
	await pc4._ready;
	assert.deepEqual(pc4._iceServers, []);
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

test('pc.close graceful: waits for child DC sendQueue to drain before closing', async () => {
	const sentPayloads = [];
	const ipc = createMockIpc();
	ipc.request = async (method, opts, payload) => {
		if (method === 'dc.send') {
			sentPayloads.push(payload?.toString?.('utf8') ?? String(payload));
			await new Promise((r) => setTimeout(r, 20));
		}
		return { header: {}, payload: Buffer.alloc(0) };
	};
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-graceful' });
	const dc = pc.createDataChannel('rpc');
	// 等 _init 完成
	await new Promise((r) => setTimeout(r, 30));
	// 模拟 open
	ipc.emit('dc.open', { pcId: 'pc-graceful', dcLabel: 'rpc' });

	dc.send('msg-A');
	dc.send('msg-B');
	dc.send('LAST'); // 入队，未 drain
	// pc.close 必须先排空 dc 的队列
	await pc.close();

	assert.equal(sentPayloads.length, 3, 'pc.close should drain DC queue before closing');
	assert.deepEqual(sentPayloads, ['msg-A', 'msg-B', 'LAST']);
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

test('selectedcandidatepairchange event updates getter and emits', () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	assert.equal(pc.selectedCandidatePair, null);

	const events = [];
	pc.on('selectedcandidatepairchange', () => events.push(pc.selectedCandidatePair));

	const pair = {
		local: { type: 'host', address: '192.168.1.1', port: 12345, protocol: 'udp' },
		remote: { type: 'srflx', address: '203.0.113.1', port: 54321, protocol: 'udp' },
	};
	ipc.emit('pc.selectedcandidatepairchange', {
		pcId: 'pc-1',
		payload: Buffer.from(encode(pair)),
	});

	assert.equal(events.length, 1);
	assert.deepEqual(pc.selectedCandidatePair, pair);
	assert.deepEqual(events[0], pair);
});

test('selectedcandidatepairchange passes through local.relayProtocol (relay candidate)', () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-relay' });

	const pair = {
		local: { type: 'relay', address: '198.51.100.1', port: 49152, protocol: 'udp', relayProtocol: 'tcp' },
		remote: { type: 'host', address: '192.0.2.5', port: 22222, protocol: 'udp' },
	};
	ipc.emit('pc.selectedcandidatepairchange', {
		pcId: 'pc-relay',
		payload: Buffer.from(encode(pair)),
	});

	assert.equal(pc.selectedCandidatePair.local.relayProtocol, 'tcp');
	assert.equal(pc.selectedCandidatePair.remote.relayProtocol, undefined);
});

test('selectedcandidatepairchange filters by pcId', () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	const events = [];
	pc.on('selectedcandidatepairchange', () => events.push(true));

	ipc.emit('pc.selectedcandidatepairchange', {
		pcId: 'pc-other',
		payload: Buffer.from(encode({
			local: { type: 'host', address: '1.2.3.4', port: 1, protocol: 'udp' },
			remote: { type: 'host', address: '5.6.7.8', port: 2, protocol: 'udp' },
		})),
	});

	assert.equal(events.length, 0);
	assert.equal(pc.selectedCandidatePair, null);
});

test('icegatheringstatechange event updates getter and emits', () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	assert.equal(pc.iceGatheringState, 'new');

	const events = [];
	pc.on('icegatheringstatechange', () => events.push(pc.iceGatheringState));

	ipc.emit('pc.icegatheringstatechange', {
		pcId: 'pc-1',
		payload: Buffer.from(encode({ state: 'gathering' })),
	});

	assert.equal(events.length, 1);
	assert.equal(pc.iceGatheringState, 'gathering');

	ipc.emit('pc.icegatheringstatechange', {
		pcId: 'pc-1',
		payload: Buffer.from(encode({ state: 'complete' })),
	});

	assert.equal(events.length, 2);
	assert.equal(pc.iceGatheringState, 'complete');
});

test('icegatheringstatechange filters by pcId', () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	const events = [];
	pc.on('icegatheringstatechange', () => events.push(true));

	ipc.emit('pc.icegatheringstatechange', {
		pcId: 'pc-other',
		payload: Buffer.from(encode({ state: 'gathering' })),
	});

	assert.equal(events.length, 0);
	assert.equal(pc.iceGatheringState, 'new');
});

test('signalingstatechange event updates getter and emits', () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	assert.equal(pc.signalingState, 'stable');

	const events = [];
	pc.on('signalingstatechange', () => events.push(pc.signalingState));

	ipc.emit('pc.signalingstatechange', {
		pcId: 'pc-1',
		payload: Buffer.from(encode({ state: 'have-local-offer' })),
	});

	assert.equal(events.length, 1);
	assert.equal(pc.signalingState, 'have-local-offer');

	ipc.emit('pc.signalingstatechange', {
		pcId: 'pc-1',
		payload: Buffer.from(encode({ state: 'stable' })),
	});

	assert.equal(events.length, 2);
	assert.equal(pc.signalingState, 'stable');
});

test('signalingstatechange filters by pcId', () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	const events = [];
	pc.on('signalingstatechange', () => events.push(true));

	ipc.emit('pc.signalingstatechange', {
		pcId: 'pc-other',
		payload: Buffer.from(encode({ state: 'have-local-offer' })),
	});

	assert.equal(events.length, 0);
	assert.equal(pc.signalingState, 'stable');
});

test('on* property setters work for new events', () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	// Initially null
	assert.equal(pc.onselectedcandidatepairchange, null);
	assert.equal(pc.onicegatheringstatechange, null);
	assert.equal(pc.onsignalingstatechange, null);

	// Set and verify selectedcandidatepairchange
	const calls = [];
	pc.onselectedcandidatepairchange = () => calls.push('pair');
	ipc.emit('pc.selectedcandidatepairchange', {
		pcId: 'pc-1',
		payload: Buffer.from(encode({
			local: { type: 'host', address: '1.2.3.4', port: 1, protocol: 'udp' },
			remote: { type: 'host', address: '5.6.7.8', port: 2, protocol: 'udp' },
		})),
	});
	assert.equal(calls.length, 1);

	// Set and verify icegatheringstatechange
	pc.onicegatheringstatechange = () => calls.push('gather');
	ipc.emit('pc.icegatheringstatechange', {
		pcId: 'pc-1',
		payload: Buffer.from(encode({ state: 'gathering' })),
	});
	assert.equal(calls.length, 2);
	assert.equal(calls[1], 'gather');

	// Set and verify signalingstatechange
	pc.onsignalingstatechange = () => calls.push('signal');
	ipc.emit('pc.signalingstatechange', {
		pcId: 'pc-1',
		payload: Buffer.from(encode({ state: 'have-local-offer' })),
	});
	assert.equal(calls.length, 3);
	assert.equal(calls[2], 'signal');

	// Clear all
	pc.onselectedcandidatepairchange = null;
	pc.onicegatheringstatechange = null;
	pc.onsignalingstatechange = null;

	ipc.emit('pc.selectedcandidatepairchange', {
		pcId: 'pc-1',
		payload: Buffer.from(encode({
			local: { type: 'host', address: '1.2.3.4', port: 1, protocol: 'udp' },
			remote: { type: 'host', address: '5.6.7.8', port: 2, protocol: 'udp' },
		})),
	});
	assert.equal(calls.length, 3); // no new calls
});

test('close detaches new event listeners', async () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });
	await pc._ready;

	const pairBefore = ipc.listenerCount('pc.selectedcandidatepairchange');
	const gatherBefore = ipc.listenerCount('pc.icegatheringstatechange');
	const sigBefore = ipc.listenerCount('pc.signalingstatechange');

	await pc.close();

	assert.equal(ipc.listenerCount('pc.selectedcandidatepairchange'), pairBefore - 1);
	assert.equal(ipc.listenerCount('pc.icegatheringstatechange'), gatherBefore - 1);
	assert.equal(ipc.listenerCount('pc.signalingstatechange'), sigBefore - 1);
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

// --- IPC exit handler (进程崩溃 → PC failed) ---

test('ipc exit: connected PC transitions to failed and emits connectionstatechange', () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	// 模拟 connected 状态
	ipc.emit('pc.statechange', {
		pcId: 'pc-1',
		payload: Buffer.from(encode({ connState: 'connected', iceState: 'connected' })),
	});
	assert.equal(pc.connectionState, 'connected');

	const connEvents = [];
	const iceEvents = [];
	pc.on('connectionstatechange', () => connEvents.push(pc.connectionState));
	pc.on('iceconnectionstatechange', () => iceEvents.push(pc.iceConnectionState));

	// IPC 进程退出
	ipc.emit('exit', 1, null);

	assert.equal(pc.connectionState, 'failed');
	assert.equal(pc.iceConnectionState, 'failed');
	assert.equal(connEvents.length, 1);
	assert.equal(connEvents[0], 'failed');
	assert.equal(iceEvents.length, 1);
	assert.equal(iceEvents[0], 'failed');
});

test('ipc exit: force-closes all associated DCs', () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	// 模拟 connected + open DC
	ipc.emit('pc.statechange', {
		pcId: 'pc-1',
		payload: Buffer.from(encode({ connState: 'connected', iceState: 'connected' })),
	});

	const dc = pc.createDataChannel('rpc');
	ipc.emit('dc.open', { pcId: 'pc-1', dcLabel: 'rpc' });
	assert.equal(dc.readyState, 'open');

	const dcCloseEvents = [];
	dc.on('close', () => dcCloseEvents.push(true));

	// IPC 进程退出
	ipc.emit('exit', 1, null);

	assert.equal(dc.readyState, 'closed');
	assert.equal(dc._closed, true);
	assert.equal(dcCloseEvents.length, 1);
	assert.equal(pc._dataChannels.size, 0);
});

test('ipc exit: detaches all IPC event listeners', () => {
	const ipc = createMockIpc();
	// eslint-disable-next-line no-unused-vars
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	const iceBefore = ipc.listenerCount('pc.icecandidate');
	const exitBefore = ipc.listenerCount('exit');

	ipc.emit('exit', 1, null);

	assert.equal(ipc.listenerCount('pc.icecandidate'), iceBefore - 1);
	assert.equal(ipc.listenerCount('exit'), exitBefore - 1);
});

test('ipc exit: already closed PC does not re-trigger', () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	// 先 close
	pc._connState = 'closed';

	const connEvents = [];
	pc.on('connectionstatechange', () => connEvents.push(pc.connectionState));

	ipc.emit('exit', 1, null);

	assert.equal(connEvents.length, 0); // 不触发
});

test('ipc exit: already failed PC does not re-trigger', () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	pc._connState = 'failed';

	const connEvents = [];
	pc.on('connectionstatechange', () => connEvents.push(pc.connectionState));

	ipc.emit('exit', 1, null);

	assert.equal(connEvents.length, 0);
});

test('ipc exit: PC in new state correctly transitions to failed', () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });
	assert.equal(pc.connectionState, 'new');

	const connEvents = [];
	pc.on('connectionstatechange', () => connEvents.push(pc.connectionState));

	ipc.emit('exit', 1, null);

	assert.equal(pc.connectionState, 'failed');
	assert.equal(connEvents.length, 1);
});

test('close detaches exit listener', async () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	const exitBefore = ipc.listenerCount('exit');
	await pc.close();
	assert.equal(ipc.listenerCount('exit'), exitBefore - 1);
});

test('ipc exit: multiple DCs (open + connecting) all force-closed', () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	ipc.emit('pc.statechange', {
		pcId: 'pc-1',
		payload: Buffer.from(encode({ connState: 'connected', iceState: 'connected' })),
	});

	const dc1 = pc.createDataChannel('rpc');
	const dc2 = pc.createDataChannel('file');
	ipc.emit('dc.open', { pcId: 'pc-1', dcLabel: 'rpc' });
	// dc2 保持 connecting 状态

	const closeEvents = [];
	dc1.on('close', () => closeEvents.push('dc1'));
	dc2.on('close', () => closeEvents.push('dc2'));

	ipc.emit('exit', 1, null);

	assert.equal(dc1.readyState, 'closed');
	assert.equal(dc2.readyState, 'closed');
	assert.deepEqual(closeEvents, ['dc1', 'dc2']);
	assert.equal(pc._dataChannels.size, 0);
});

test('ipc exit: DC close listener exception does not block other DC cleanup', () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	ipc.emit('pc.statechange', {
		pcId: 'pc-1',
		payload: Buffer.from(encode({ connState: 'connected', iceState: 'connected' })),
	});

	const dc1 = pc.createDataChannel('throws');
	const dc2 = pc.createDataChannel('normal');
	ipc.emit('dc.open', { pcId: 'pc-1', dcLabel: 'throws' });
	ipc.emit('dc.open', { pcId: 'pc-1', dcLabel: 'normal' });

	// dc1 的 close listener 抛异常
	dc1.on('close', () => { throw new Error('listener boom'); });

	// 不应崩溃，dc2 应仍被关闭
	ipc.emit('exit', 1, null);

	assert.equal(dc2.readyState, 'closed');
	assert.equal(pc.connectionState, 'failed');
});

test('pc.close() completes silently when IPC is dead (no not-started throw)', async () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });
	await pc._ready;

	// 模拟 IPC 已死
	ipc._started = false;

	// close 不应 throw
	await pc.close();
	assert.equal(pc.connectionState, 'closed');
});

// --- additional scenario tests ---

test('maxMessageSize returns 65536', () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });
	assert.equal(pc.maxMessageSize, 65536);
});

test('createDataChannel init failure emits error then close on DC', async () => {
	const ipc = createMockIpc();
	ipc.request = async (method) => {
		if (method === 'pc.create') throw new Error('create failed');
		return { header: {}, payload: Buffer.alloc(0) };
	};
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-fail' });

	const dc = pc.createDataChannel('rpc');

	const errors = [];
	const closes = [];
	dc.on('error', (err) => errors.push(err));
	dc.on('close', () => closes.push(true));

	// Wait for async init failure to propagate
	await new Promise((r) => setTimeout(r, 50));

	assert.equal(dc.readyState, 'closed');
	assert.equal(dc._closed, true);
	assert.equal(errors.length, 1);
	assert.match(errors[0].message, /create failed/);
	assert.equal(closes.length, 1);
});

test('createDataChannel init failure without error listener still emits close', async () => {
	const ipc = createMockIpc();
	ipc.request = async (method) => {
		if (method === 'pc.create') throw new Error('create failed');
		return { header: {}, payload: Buffer.alloc(0) };
	};
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-fail2' });

	const dc = pc.createDataChannel('rpc');
	// No error listener — should not throw

	const closes = [];
	dc.on('close', () => closes.push(true));

	await new Promise((r) => setTimeout(r, 50));

	assert.equal(dc.readyState, 'closed');
	assert.equal(closes.length, 1);
});

test('close() does not re-emit connectionstatechange if already closed', async () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });
	await pc._ready;

	const events = [];
	pc.on('connectionstatechange', () => events.push(pc.connectionState));

	await pc.close();
	assert.equal(events.length, 1);
	assert.equal(events[0], 'closed');

	// Second close should be a no-op
	await pc.close();
	assert.equal(events.length, 1);
});

test('close() sends pc.close IPC when everything is normal', async () => {
	const ipc = createMockIpc();
	ipc.started = true;
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });
	await pc._ready;

	await pc.close();

	const closeReq = ipc.requests.find((r) => r.method === 'pc.close');
	assert.ok(closeReq, 'pc.close IPC should be sent');
	assert.equal(closeReq.opts.pcId, 'pc-1');
});

test('statechange event filters by pcId', () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	const connEvents = [];
	pc.on('connectionstatechange', () => connEvents.push(pc.connectionState));

	// Non-matching pcId
	ipc.emit('pc.statechange', {
		pcId: 'pc-other',
		payload: Buffer.from(encode({ connState: 'connected', iceState: 'connected' })),
	});

	assert.equal(connEvents.length, 0);
	assert.equal(pc.connectionState, 'new');
});

test('datachannel event: remote DC has correct properties', () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	const channels = [];
	pc.on('datachannel', (e) => channels.push(e.channel));

	ipc.emit('pc.datachannel', {
		pcId: 'pc-1',
		dcLabel: 'remote-dc',
		payload: Buffer.from(encode({ ordered: false })),
	});

	assert.equal(channels.length, 1);
	assert.equal(channels[0].label, 'remote-dc');
	assert.equal(channels[0]._remote, true);
	assert.equal(channels[0].ordered, false);
	assert.equal(pc._dataChannels.size, 1);
});

test('datachannel event filters by pcId', () => {
	const ipc = createMockIpc();
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });

	const channels = [];
	pc.on('datachannel', (e) => channels.push(e.channel));

	ipc.emit('pc.datachannel', {
		pcId: 'pc-other',
		dcLabel: 'remote-dc',
		payload: Buffer.from(encode({ ordered: true })),
	});

	assert.equal(channels.length, 0);
});

test('close() handles DC close failure without blocking', async () => {
	const ipc = createMockIpc();
	ipc.request = async (method) => {
		if (method === 'dc.close') throw new Error('dc.close failed');
		return { header: {}, payload: Buffer.alloc(0) };
	};
	const pc = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-1' });
	await pc._ready;

	pc.createDataChannel('rpc');
	await new Promise((r) => setTimeout(r, 30));
	// Simulate open
	ipc.emit('dc.open', { pcId: 'pc-1', dcLabel: 'rpc' });

	// close should not throw even though dc.close IPC fails
	await pc.close();
	assert.equal(pc.connectionState, 'closed');
});
