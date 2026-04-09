import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { encode } from '@msgpack/msgpack';
import { DataChannel } from '../src/data-channel.js';

// Mock IPC
function createMockIpc() {
	const ipc = new EventEmitter();
	ipc.requests = [];
	ipc.request = async (method, opts, payload) => {
		ipc.requests.push({ method, opts, payload });
		if (method === 'dc.getBA') {
			return { payload: Buffer.from(encode({ bufferedAmount: 4096 })) };
		}
		return { header: {}, payload: Buffer.alloc(0) };
	};
	return ipc;
}

test('label getter', () => {
	const ipc = createMockIpc();
	const dc = new DataChannel(ipc, 'pc-1', 'my-label');
	assert.equal(dc.label, 'my-label');
});

test('send text: isBinary=false, payload=utf8 buffer', async () => {
	const ipc = createMockIpc();
	const dc = new DataChannel(ipc, 'pc-1', 'rpc');

	await dc.send('hello');

	assert.equal(ipc.requests.length, 1);
	assert.equal(ipc.requests[0].method, 'dc.send');
	assert.equal(ipc.requests[0].opts.isBinary, false);
	assert.equal(ipc.requests[0].opts.pcId, 'pc-1');
	assert.equal(ipc.requests[0].opts.dcLabel, 'rpc');
	assert.deepEqual(ipc.requests[0].payload, Buffer.from('hello', 'utf8'));
});

test('send Buffer: isBinary=true', async () => {
	const ipc = createMockIpc();
	const dc = new DataChannel(ipc, 'pc-1', 'data');

	const buf = Buffer.from([0xDE, 0xAD]);
	await dc.send(buf);

	assert.equal(ipc.requests[0].opts.isBinary, true);
	assert.deepEqual(ipc.requests[0].payload, buf);
});

test('send empty string', async () => {
	const ipc = createMockIpc();
	const dc = new DataChannel(ipc, 'pc-1', 'rpc');

	await dc.send('');

	assert.equal(ipc.requests[0].opts.isBinary, false);
	assert.deepEqual(ipc.requests[0].payload, Buffer.alloc(0));
});

test('send empty Buffer', async () => {
	const ipc = createMockIpc();
	const dc = new DataChannel(ipc, 'pc-1', 'rpc');

	await dc.send(Buffer.alloc(0));

	assert.equal(ipc.requests[0].opts.isBinary, true);
	assert.deepEqual(ipc.requests[0].payload, Buffer.alloc(0));
});

test('close calls dc.close and detaches', async () => {
	const ipc = createMockIpc();
	const dc = new DataChannel(ipc, 'pc-1', 'rpc');

	const openBefore = ipc.listenerCount('dc.open');
	const closeBefore = ipc.listenerCount('dc.close');
	const msgBefore = ipc.listenerCount('dc.message');
	const errBefore = ipc.listenerCount('dc.error');
	const balBefore = ipc.listenerCount('dc.bufferedamountlow');

	await dc.close();

	assert.equal(ipc.requests[0].method, 'dc.close');
	assert.equal(ipc.requests[0].opts.pcId, 'pc-1');
	assert.equal(ipc.requests[0].opts.dcLabel, 'rpc');

	// listener 应被移除
	assert.equal(ipc.listenerCount('dc.open'), openBefore - 1);
	assert.equal(ipc.listenerCount('dc.close'), closeBefore - 1);
	assert.equal(ipc.listenerCount('dc.message'), msgBefore - 1);
	assert.equal(ipc.listenerCount('dc.error'), errBefore - 1);
	assert.equal(ipc.listenerCount('dc.bufferedamountlow'), balBefore - 1);
});

test('getBufferedAmount decodes result', async () => {
	const ipc = createMockIpc();
	const dc = new DataChannel(ipc, 'pc-1', 'rpc');

	const amount = await dc.getBufferedAmount();
	assert.equal(amount, 4096);
	assert.equal(ipc.requests[0].method, 'dc.getBA');
});

test('setBufferedAmountLowThreshold sends threshold', async () => {
	const ipc = createMockIpc();
	const dc = new DataChannel(ipc, 'pc-1', 'rpc');

	await dc.setBufferedAmountLowThreshold(1024);
	assert.equal(ipc.requests[0].method, 'dc.setBALT');
	assert.deepEqual(ipc.requests[0].payload, { threshold: 1024 });
});

test('dc.open event filters by pcId+dcLabel', () => {
	const ipc = createMockIpc();
	const dc = new DataChannel(ipc, 'pc-1', 'rpc');

	let opened = false;
	dc.on('open', () => { opened = true; });

	// 不匹配的事件
	ipc.emit('dc.open', { pcId: 'pc-2', dcLabel: 'rpc' });
	assert.equal(opened, false);

	ipc.emit('dc.open', { pcId: 'pc-1', dcLabel: 'other' });
	assert.equal(opened, false);

	// 匹配的事件
	ipc.emit('dc.open', { pcId: 'pc-1', dcLabel: 'rpc' });
	assert.equal(opened, true);
});

test('dc.close event filters by pcId+dcLabel', () => {
	const ipc = createMockIpc();
	const dc = new DataChannel(ipc, 'pc-1', 'rpc');

	let closed = false;
	dc.on('close', () => { closed = true; });

	ipc.emit('dc.close', { pcId: 'pc-other', dcLabel: 'rpc' });
	assert.equal(closed, false);

	ipc.emit('dc.close', { pcId: 'pc-1', dcLabel: 'rpc' });
	assert.equal(closed, true);
});

test('dc.message text: data is string', () => {
	const ipc = createMockIpc();
	const dc = new DataChannel(ipc, 'pc-1', 'rpc');

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
	assert.equal(messages[0].isBinary, false);
});

test('dc.message binary: data is Buffer', () => {
	const ipc = createMockIpc();
	const dc = new DataChannel(ipc, 'pc-1', 'rpc');

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
	assert.equal(messages[0].isBinary, true);
});

test('dc.error emits Error', () => {
	const ipc = createMockIpc();
	const dc = new DataChannel(ipc, 'pc-1', 'rpc');

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
	const dc = new DataChannel(ipc, 'pc-1', 'rpc');

	let fired = false;
	dc.on('bufferedamountlow', () => { fired = true; });

	// 不匹配
	ipc.emit('dc.bufferedamountlow', { pcId: 'pc-1', dcLabel: 'other' });
	assert.equal(fired, false);

	// 匹配
	ipc.emit('dc.bufferedamountlow', { pcId: 'pc-1', dcLabel: 'rpc' });
	assert.equal(fired, true);
});

test('_detach removes all listeners', () => {
	const ipc = createMockIpc();
	const dc = new DataChannel(ipc, 'pc-1', 'rpc');

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
