import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RTCDataChannel } from '../src/data-channel.js';

// Mock IPC
function createMockIpc() {
	const ipc = new EventEmitter();
	ipc.requests = [];
	ipc.request = async (method, opts, payload) => {
		ipc.requests.push({ method, opts, payload });
		return { header: {}, payload: Buffer.alloc(0) };
	};
	return ipc;
}

function createOpenDc(ipc, pcId = 'pc-1', label = 'rpc') {
	const dc = new RTCDataChannel({ _ipc: ipc, _pcId: pcId, _label: label });
	// Simulate open
	ipc.emit('dc.open', { pcId, dcLabel: label });
	return dc;
}

test('label getter', () => {
	const ipc = createMockIpc();
	const dc = new RTCDataChannel({ _ipc: ipc, _pcId: 'pc-1', _label: 'my-label' });
	assert.equal(dc.label, 'my-label');
});

test('ordered getter defaults to true', () => {
	const ipc = createMockIpc();
	const dc = new RTCDataChannel({ _ipc: ipc, _pcId: 'pc-1', _label: 'rpc' });
	assert.equal(dc.ordered, true);
});

test('ordered getter reflects config', () => {
	const ipc = createMockIpc();
	const dc = new RTCDataChannel({ _ipc: ipc, _pcId: 'pc-1', _label: 'rpc', _ordered: false });
	assert.equal(dc.ordered, false);
});

test('readyState starts as connecting', () => {
	const ipc = createMockIpc();
	const dc = new RTCDataChannel({ _ipc: ipc, _pcId: 'pc-1', _label: 'rpc' });
	assert.equal(dc.readyState, 'connecting');
});

test('readyState transitions to open on dc.open', () => {
	const ipc = createMockIpc();
	const dc = new RTCDataChannel({ _ipc: ipc, _pcId: 'pc-1', _label: 'rpc' });

	ipc.emit('dc.open', { pcId: 'pc-1', dcLabel: 'rpc' });
	assert.equal(dc.readyState, 'open');
});

test('readyState transitions to closed on dc.close', () => {
	const ipc = createMockIpc();
	const dc = createOpenDc(ipc);

	ipc.emit('dc.close', { pcId: 'pc-1', dcLabel: 'rpc' });
	assert.equal(dc.readyState, 'closed');
});

test('send text: synchronous, queues IPC request', async () => {
	const ipc = createMockIpc();
	const dc = createOpenDc(ipc);

	dc.send('hello');

	// send is synchronous, returns undefined
	assert.equal(dc.bufferedAmount, 5); // 'hello' is 5 bytes

	// Wait for drain
	await new Promise((r) => setTimeout(r, 50));

	const sendReq = ipc.requests.find((r) => r.method === 'dc.send');
	assert.ok(sendReq);
	assert.equal(sendReq.opts.isBinary, false);
	assert.equal(sendReq.opts.pcId, 'pc-1');
	assert.equal(sendReq.opts.dcLabel, 'rpc');
	assert.deepEqual(sendReq.payload, Buffer.from('hello', 'utf8'));
	assert.equal(dc.bufferedAmount, 0);
});

test('send Buffer: isBinary=true', async () => {
	const ipc = createMockIpc();
	const dc = createOpenDc(ipc);

	const buf = Buffer.from([0xDE, 0xAD]);
	dc.send(buf);

	assert.equal(dc.bufferedAmount, 2);

	await new Promise((r) => setTimeout(r, 50));

	const sendReq = ipc.requests.find((r) => r.method === 'dc.send');
	assert.equal(sendReq.opts.isBinary, true);
	assert.deepEqual(sendReq.payload, buf);
	assert.equal(dc.bufferedAmount, 0);
});

test('send Uint8Array: isBinary=true', async () => {
	const ipc = createMockIpc();
	const dc = createOpenDc(ipc);

	const arr = new Uint8Array([0x01, 0x02]);
	dc.send(arr);

	await new Promise((r) => setTimeout(r, 50));

	const sendReq = ipc.requests.find((r) => r.method === 'dc.send');
	assert.equal(sendReq.opts.isBinary, true);
});

test('send throws when readyState is not open', () => {
	const ipc = createMockIpc();
	const dc = new RTCDataChannel({ _ipc: ipc, _pcId: 'pc-1', _label: 'rpc' });

	assert.equal(dc.readyState, 'connecting');
	assert.throws(() => dc.send('hello'), /InvalidStateError/);
});

test('send empty string', async () => {
	const ipc = createMockIpc();
	const dc = createOpenDc(ipc);

	dc.send('');

	await new Promise((r) => setTimeout(r, 50));

	const sendReq = ipc.requests.find((r) => r.method === 'dc.send');
	assert.equal(sendReq.opts.isBinary, false);
	assert.deepEqual(sendReq.payload, Buffer.alloc(0));
});

test('multiple synchronous sends queue correctly', async () => {
	const ipc = createMockIpc();
	const dc = createOpenDc(ipc);

	dc.send('aaa');
	dc.send('bbb');
	dc.send('ccc');

	assert.equal(dc.bufferedAmount, 9); // 3+3+3

	await new Promise((r) => setTimeout(r, 50));

	const sends = ipc.requests.filter((r) => r.method === 'dc.send');
	assert.equal(sends.length, 3);
	assert.deepEqual(sends[0].payload, Buffer.from('aaa'));
	assert.deepEqual(sends[1].payload, Buffer.from('bbb'));
	assert.deepEqual(sends[2].payload, Buffer.from('ccc'));
	assert.equal(dc.bufferedAmount, 0);
});

test('bufferedAmountLowThreshold getter/setter', async () => {
	const ipc = createMockIpc();
	const dc = new RTCDataChannel({ _ipc: ipc, _pcId: 'pc-1', _label: 'rpc' });

	assert.equal(dc.bufferedAmountLowThreshold, 0);

	dc.bufferedAmountLowThreshold = 1024;
	assert.equal(dc.bufferedAmountLowThreshold, 1024);

	// Async IPC request
	await new Promise((r) => setTimeout(r, 50));

	const req = ipc.requests.find((r) => r.method === 'dc.setBALT');
	assert.ok(req);
	assert.deepEqual(req.payload, { threshold: 1024 });
});

test('bufferedamountlow fires after drain when below threshold', async () => {
	const ipc = createMockIpc();
	const dc = createOpenDc(ipc);

	const events = [];
	dc.on('bufferedamountlow', () => events.push('bal'));

	dc.send('hi');
	// bufferedAmount = 2, threshold = 0, so it should fire after drain

	await new Promise((r) => setTimeout(r, 50));

	assert.ok(events.length >= 1);
});

test('close calls dc.close and detaches, sets readyState to closed', async () => {
	const ipc = createMockIpc();
	const dc = new RTCDataChannel({ _ipc: ipc, _pcId: 'pc-1', _label: 'rpc' });

	const openBefore = ipc.listenerCount('dc.open');
	const closeBefore = ipc.listenerCount('dc.close');
	const msgBefore = ipc.listenerCount('dc.message');
	const errBefore = ipc.listenerCount('dc.error');
	const balBefore = ipc.listenerCount('dc.bufferedamountlow');

	await dc.close();

	assert.equal(dc.readyState, 'closed');

	const closeReq = ipc.requests.find((r) => r.method === 'dc.close');
	assert.ok(closeReq);
	assert.equal(closeReq.opts.pcId, 'pc-1');
	assert.equal(closeReq.opts.dcLabel, 'rpc');

	assert.equal(ipc.listenerCount('dc.open'), openBefore - 1);
	assert.equal(ipc.listenerCount('dc.close'), closeBefore - 1);
	assert.equal(ipc.listenerCount('dc.message'), msgBefore - 1);
	assert.equal(ipc.listenerCount('dc.error'), errBefore - 1);
	assert.equal(ipc.listenerCount('dc.bufferedamountlow'), balBefore - 1);
});

test('dc.open event filters by pcId+dcLabel', () => {
	const ipc = createMockIpc();
	const dc = new RTCDataChannel({ _ipc: ipc, _pcId: 'pc-1', _label: 'rpc' });

	let opened = false;
	dc.on('open', () => { opened = true; });

	ipc.emit('dc.open', { pcId: 'pc-2', dcLabel: 'rpc' });
	assert.equal(opened, false);

	ipc.emit('dc.open', { pcId: 'pc-1', dcLabel: 'other' });
	assert.equal(opened, false);

	ipc.emit('dc.open', { pcId: 'pc-1', dcLabel: 'rpc' });
	assert.equal(opened, true);
});

test('dc.close event filters by pcId+dcLabel', () => {
	const ipc = createMockIpc();
	const dc = new RTCDataChannel({ _ipc: ipc, _pcId: 'pc-1', _label: 'rpc' });

	let closed = false;
	dc.on('close', () => { closed = true; });

	ipc.emit('dc.close', { pcId: 'pc-other', dcLabel: 'rpc' });
	assert.equal(closed, false);

	ipc.emit('dc.close', { pcId: 'pc-1', dcLabel: 'rpc' });
	assert.equal(closed, true);
});

test('dc.message text: event.data is string', () => {
	const ipc = createMockIpc();
	const dc = new RTCDataChannel({ _ipc: ipc, _pcId: 'pc-1', _label: 'rpc' });

	const messages = [];
	dc.on('message', (msg) => messages.push(msg));

	ipc.emit('dc.message', {
		pcId: 'pc-1',
		dcLabel: 'rpc',
		isBinary: false,
		payload: Buffer.from('hello text'),
	});

	assert.equal(messages.length, 1);
	assert.equal(typeof messages[0].data, 'string');
	assert.equal(messages[0].data, 'hello text');
	// W3C: no isBinary field
	assert.ok(!('isBinary' in messages[0]));
});

test('dc.message binary: event.data is Buffer', () => {
	const ipc = createMockIpc();
	const dc = new RTCDataChannel({ _ipc: ipc, _pcId: 'pc-1', _label: 'rpc' });

	const messages = [];
	dc.on('message', (msg) => messages.push(msg));

	const buf = Buffer.from([0x01, 0x02, 0x03]);
	ipc.emit('dc.message', {
		pcId: 'pc-1',
		dcLabel: 'rpc',
		isBinary: true,
		payload: buf,
	});

	assert.equal(messages.length, 1);
	assert.ok(Buffer.isBuffer(messages[0].data));
	assert.deepEqual(messages[0].data, buf);
});

test('dc.error emits Error', () => {
	const ipc = createMockIpc();
	const dc = new RTCDataChannel({ _ipc: ipc, _pcId: 'pc-1', _label: 'rpc' });

	const errors = [];
	dc.on('error', (err) => errors.push(err));

	ipc.emit('dc.error', {
		pcId: 'pc-1',
		dcLabel: 'rpc',
		payload: Buffer.from('something broke'),
	});

	assert.equal(errors.length, 1);
	assert.ok(errors[0] instanceof Error);
	assert.equal(errors[0].message, 'something broke');
});

test('dc.bufferedamountlow event fires', () => {
	const ipc = createMockIpc();
	const dc = new RTCDataChannel({ _ipc: ipc, _pcId: 'pc-1', _label: 'rpc' });

	let fired = false;
	dc.on('bufferedamountlow', () => { fired = true; });

	ipc.emit('dc.bufferedamountlow', { pcId: 'pc-1', dcLabel: 'other' });
	assert.equal(fired, false);

	ipc.emit('dc.bufferedamountlow', { pcId: 'pc-1', dcLabel: 'rpc' });
	assert.equal(fired, true);
});

test('_detach removes all listeners', () => {
	const ipc = createMockIpc();
	const dc = new RTCDataChannel({ _ipc: ipc, _pcId: 'pc-1', _label: 'rpc' });

	assert.equal(ipc.listenerCount('dc.open'), 1);
	assert.equal(ipc.listenerCount('dc.close'), 1);
	assert.equal(ipc.listenerCount('dc.message'), 1);
	assert.equal(ipc.listenerCount('dc.error'), 1);
	assert.equal(ipc.listenerCount('dc.bufferedamountlow'), 1);

	dc._detach();

	assert.equal(ipc.listenerCount('dc.open'), 0);
	assert.equal(ipc.listenerCount('dc.close'), 0);
	assert.equal(ipc.listenerCount('dc.message'), 0);
	assert.equal(ipc.listenerCount('dc.error'), 0);
	assert.equal(ipc.listenerCount('dc.bufferedamountlow'), 0);
});

test('_init sends dc.create IPC', async () => {
	const ipc = createMockIpc();
	const dc = new RTCDataChannel({
		_ipc: ipc,
		_pcId: 'pc-1',
		_label: 'test-dc',
		_ordered: false,
	});

	await dc._init();

	const req = ipc.requests.find((r) => r.method === 'dc.create');
	assert.ok(req);
	assert.deepEqual(req.payload, { label: 'test-dc', ordered: false });
});

test('on* property setters work', () => {
	const ipc = createMockIpc();
	const dc = new RTCDataChannel({ _ipc: ipc, _pcId: 'pc-1', _label: 'rpc' });

	// Initially null
	assert.equal(dc.onopen, null);
	assert.equal(dc.onclose, null);
	assert.equal(dc.onmessage, null);
	assert.equal(dc.onerror, null);
	assert.equal(dc.onbufferedamountlow, null);

	// Set handler
	const calls = [];
	dc.onopen = () => calls.push('open');

	ipc.emit('dc.open', { pcId: 'pc-1', dcLabel: 'rpc' });
	assert.equal(calls.length, 1);

	// Replace handler
	dc.onopen = () => calls.push('open2');
	ipc.emit('dc.open', { pcId: 'pc-1', dcLabel: 'rpc' });
	assert.equal(calls.length, 2);
	assert.equal(calls[1], 'open2');

	// Clear handler
	dc.onopen = null;
	ipc.emit('dc.open', { pcId: 'pc-1', dcLabel: 'rpc' });
	assert.equal(calls.length, 2); // no new calls
});

test('send error during drain emits error event', async () => {
	const ipc = createMockIpc();
	ipc.request = async (method) => {
		if (method === 'dc.send') throw new Error('send failed');
		return { header: {}, payload: Buffer.alloc(0) };
	};
	const dc = createOpenDc(ipc);

	const errors = [];
	dc.on('error', (err) => errors.push(err));

	dc.send('hello');

	await new Promise((r) => setTimeout(r, 50));

	assert.ok(errors.some((e) => e.message === 'send failed'));
});

test('bufferedamountlow only fires on threshold crossing', async () => {
	const ipc = createMockIpc();
	const dc = createOpenDc(ipc);
	dc.bufferedAmountLowThreshold = 100;

	const balEvents = [];
	dc.on('bufferedamountlow', () => balEvents.push(true));

	// send a small message (5 bytes, below threshold)
	dc.send('hello');
	await new Promise((r) => setTimeout(r, 50));

	// bufferedAmount went 5 -> 0, but both below threshold, so no event
	assert.equal(balEvents.length, 0);

	// send a large message (above threshold)
	dc.send('x'.repeat(200));
	await new Promise((r) => setTimeout(r, 50));

	// bufferedAmount went 200 -> 0, crossed threshold, event fires
	assert.equal(balEvents.length, 1);
});

test('drain picks up messages queued during draining', async () => {
	let sendCount = 0;
	const ipc = createMockIpc();
	// Slow IPC: simulate async delay
	ipc.request = async (method) => {
		if (method === 'dc.send') {
			sendCount++;
			await new Promise((r) => setTimeout(r, 20));
		}
		return { header: {}, payload: Buffer.alloc(0) };
	};
	const dc = createOpenDc(ipc);

	dc.send('msg1');
	// Queue second message after drain starts but before first completes
	setTimeout(() => dc.send('msg2'), 5);

	await new Promise((r) => setTimeout(r, 100));

	assert.equal(sendCount, 2, 'both messages should be sent');
	assert.equal(dc.bufferedAmount, 0);
});

test('createDataChannel init failure sets readyState to closed', async () => {
	const ipc = createMockIpc();
	ipc.request = async (method) => {
		if (method === 'dc.create') throw new Error('init failed');
		return { header: {}, payload: Buffer.alloc(0) };
	};

	const dc = new RTCDataChannel({
		_ipc: ipc, _pcId: 'pc-1', _label: 'fail-dc',
	});

	const errors = [];
	dc.on('error', (err) => errors.push(err));
	const closed = [];
	dc.on('close', () => closed.push(true));

	// Simulate what RTCPeerConnection.createDataChannel does
	dc._init().catch((err) => {
		dc._readyState = 'closed';
		dc.emit('error', err);
		dc.emit('close');
	});

	await new Promise((r) => setTimeout(r, 50));

	assert.equal(dc.readyState, 'closed');
	assert.ok(errors.some((e) => e.message === 'init failed'));
	assert.equal(closed.length, 1);
});
