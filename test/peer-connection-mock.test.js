import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { encode } from '@msgpack/msgpack';
import { PeerConnection } from '../src/peer-connection.js';

// Mock IPC：记录所有 request 调用，并根据 method 返回 mock 响应
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

test('init calls pc.create with pcId and iceServers', async () => {
	const ipc = createMockIpc();
	const pc = new PeerConnection(ipc, 'pc-1', [{ urls: 'stun:stun.example.com' }]);

	await pc.init();

	assert.equal(ipc.requests.length, 1);
	assert.equal(ipc.requests[0].method, 'pc.create');
	assert.deepEqual(ipc.requests[0].payload, {
		pcId: 'pc-1',
		iceServers: [{ urls: 'stun:stun.example.com' }],
	});
});

test('createOffer returns { type: "offer", sdp }', async () => {
	const ipc = createMockIpc();
	const pc = new PeerConnection(ipc, 'pc-1');

	const offer = await pc.createOffer();
	assert.equal(offer.type, 'offer');
	assert.equal(offer.sdp, 'mock-sdp');
	assert.equal(ipc.requests[0].method, 'pc.createOffer');
});

test('createAnswer returns { type: "answer", sdp }', async () => {
	const ipc = createMockIpc();
	const pc = new PeerConnection(ipc, 'pc-1');

	const answer = await pc.createAnswer();
	assert.equal(answer.type, 'answer');
	assert.equal(answer.sdp, 'mock-sdp');
	assert.equal(ipc.requests[0].method, 'pc.createAnswer');
});

test('setRemoteDescription sends type and sdp', async () => {
	const ipc = createMockIpc();
	const pc = new PeerConnection(ipc, 'pc-1');

	await pc.setRemoteDescription({ type: 'offer', sdp: 'remote-sdp' });
	assert.equal(ipc.requests[0].method, 'pc.setRemoteDescription');
	assert.equal(ipc.requests[0].opts.pcId, 'pc-1');
	assert.deepEqual(ipc.requests[0].payload, { type: 'offer', sdp: 'remote-sdp' });
});

test('setLocalDescription sends pc.setLocalDescription', async () => {
	const ipc = createMockIpc();
	const pc = new PeerConnection(ipc, 'pc-1');

	await pc.setLocalDescription({ type: 'answer', sdp: 'local-sdp' });
	assert.equal(ipc.requests[0].method, 'pc.setLocalDescription');
	assert.deepEqual(ipc.requests[0].payload, { type: 'answer', sdp: 'local-sdp' });
});

test('addIceCandidate sends candidate fields', async () => {
	const ipc = createMockIpc();
	const pc = new PeerConnection(ipc, 'pc-1');

	await pc.addIceCandidate({
		candidate: 'candidate:123',
		sdpMid: '0',
		sdpMLineIndex: 0,
	});
	assert.equal(ipc.requests[0].method, 'pc.addIceCandidate');
	assert.deepEqual(ipc.requests[0].payload, {
		candidate: 'candidate:123',
		sdpMid: '0',
		sdpMLineIndex: 0,
	});
});

test('restartIce returns offer', async () => {
	const ipc = createMockIpc();
	const pc = new PeerConnection(ipc, 'pc-1');

	const offer = await pc.restartIce();
	assert.equal(offer.type, 'offer');
	assert.equal(offer.sdp, 'mock-sdp');
	assert.equal(ipc.requests[0].method, 'pc.restartIce');
});

test('createDataChannel sends dc.create with label and ordered', async () => {
	const ipc = createMockIpc();
	const pc = new PeerConnection(ipc, 'pc-1');

	const dc = await pc.createDataChannel('rpc', { ordered: false });
	assert.equal(ipc.requests[0].method, 'dc.create');
	assert.deepEqual(ipc.requests[0].payload, { label: 'rpc', ordered: false });
	assert.equal(dc.label, 'rpc');
});

test('createDataChannel ordered defaults to true', async () => {
	const ipc = createMockIpc();
	const pc = new PeerConnection(ipc, 'pc-1');

	await pc.createDataChannel('data');
	assert.deepEqual(ipc.requests[0].payload, { label: 'data', ordered: true });
});

test('icecandidate event filters by pcId', async () => {
	const ipc = createMockIpc();
	const pc = new PeerConnection(ipc, 'pc-1');

	const candidates = [];
	pc.on('icecandidate', (c) => candidates.push(c));

	// 匹配的事件
	ipc.emit('pc.icecandidate', {
		pcId: 'pc-1',
		payload: Buffer.from(encode({
			candidate: 'candidate:1',
			sdpMid: '0',
			sdpMLineIndex: 0,
		})),
	});

	// 不匹配的事件（不同 pcId）
	ipc.emit('pc.icecandidate', {
		pcId: 'pc-other',
		payload: Buffer.from(encode({
			candidate: 'candidate:2',
			sdpMid: '0',
			sdpMLineIndex: 0,
		})),
	});

	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].candidate, 'candidate:1');
});

test('connectionstatechange updates getters', () => {
	const ipc = createMockIpc();
	const pc = new PeerConnection(ipc, 'pc-1');

	assert.equal(pc.connectionState, 'new');
	assert.equal(pc.iceConnectionState, '');

	const events = [];
	pc.on('connectionstatechange', (e) => events.push(e));

	ipc.emit('pc.statechange', {
		pcId: 'pc-1',
		payload: Buffer.from(encode({ connState: 'connected', iceState: 'connected' })),
	});

	assert.equal(pc.connectionState, 'connected');
	assert.equal(pc.iceConnectionState, 'connected');
	assert.equal(events.length, 1);
	assert.equal(events[0].connectionState, 'connected');
});

test('datachannel event creates DataChannel', () => {
	const ipc = createMockIpc();
	const pc = new PeerConnection(ipc, 'pc-1');

	const channels = [];
	pc.on('datachannel', (e) => channels.push(e));

	ipc.emit('pc.datachannel', {
		pcId: 'pc-1',
		dcLabel: 'remote-dc',
		payload: Buffer.from(encode({ ordered: true })),
	});

	assert.equal(channels.length, 1);
	assert.equal(channels[0].channel.label, 'remote-dc');
	assert.equal(channels[0].ordered, true);
});

test('close detaches all listeners', async () => {
	const ipc = createMockIpc();
	const pc = new PeerConnection(ipc, 'pc-1');

	// 先创建一个 DataChannel
	await pc.createDataChannel('test-dc');

	const iceBefore = ipc.listenerCount('pc.icecandidate');
	const stateBefore = ipc.listenerCount('pc.statechange');
	const dcBefore = ipc.listenerCount('pc.datachannel');

	await pc.close();

	assert.equal(ipc.listenerCount('pc.icecandidate'), iceBefore - 1);
	assert.equal(ipc.listenerCount('pc.statechange'), stateBefore - 1);
	assert.equal(ipc.listenerCount('pc.datachannel'), dcBefore - 1);
});

test('initial connectionState is new', () => {
	const ipc = createMockIpc();
	const pc = new PeerConnection(ipc, 'pc-1');

	assert.equal(pc.connectionState, 'new');
	assert.equal(pc.iceConnectionState, '');
});
