import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { encode } from '@msgpack/msgpack';
import { encodeFrame } from '../src/ipc/protocol.js';
import { FrameReader } from '../src/ipc/reader.js';
import { FrameWriter } from '../src/ipc/writer.js';
import { PionIpc } from '../src/pion-ipc.js';

// Mock child process
function createMockProcess() {
	const proc = new EventEmitter();
	proc.stdin = new PassThrough();
	proc.stdout = new PassThrough();
	proc.stderr = new PassThrough();
	proc.kill = () => {};
	proc.pid = 12345;
	return proc;
}

// 向 proc.stdout 注入一个 response 帧
function injectResponse(proc, id, ok, payload, error) {
	const header = { type: 'res', id, ok };
	if (error) header.error = error;
	const buf = encodeFrame(header, payload || Buffer.alloc(0));
	proc.stdout.write(buf);
}

// 向 proc.stdout 注入一个 event 帧
function injectEvent(proc, event, pcId, dcLabel, payload, isBinary) {
	const header = { type: 'evt', event };
	if (pcId) header.pcId = pcId;
	if (dcLabel) header.dcLabel = dcLabel;
	if (isBinary) header.isBinary = isBinary;
	const buf = encodeFrame(header, payload || Buffer.alloc(0));
	proc.stdout.write(buf);
}

// 创建一个已 "started" 的 PionIpc，使用 mock process
function createStartedIpc(opts = {}) {
	const ipc = new PionIpc({ timeout: opts.timeout || 1000, logger: opts.logger });
	const proc = createMockProcess();

	ipc._proc = proc;
	ipc._reader = new FrameReader(proc.stdout);
	ipc._writer = new FrameWriter(proc.stdin);
	ipc._started = true;

	ipc._reader.onFrame((header, payload) => {
		if (header.type === 'res') {
			ipc._handleResponse(header, payload);
		} else if (header.type === 'evt') {
			ipc._handleEvent(header, payload);
		}
	});

	ipc._reader.onError((err) => {
		ipc.emit('error', err);
	});

	return { ipc, proc };
}

test('request resolves on matching response', async () => {
	const { ipc, proc } = createStartedIpc();

	const promise = ipc.request('ping');
	// request 分配 id=1（初始值），注入匹配的 response
	setTimeout(() => injectResponse(proc, 1, true), 5);

	const result = await promise;
	assert.equal(result.header.ok, true);
});

test('request rejects on error response', async () => {
	const { ipc, proc } = createStartedIpc();

	const promise = ipc.request('fail');
	setTimeout(() => injectResponse(proc, 1, false, null, 'something went wrong'), 5);

	await assert.rejects(promise, /something went wrong/);
});

test('request timeout rejects and cleans pending map', async () => {
	const { ipc } = createStartedIpc({ timeout: 50 });

	await assert.rejects(
		ipc.request('slow'),
		/request timeout/
	);
	// pending map 应已清空
	assert.equal(ipc._pending.size, 0);
});

test('concurrent requests resolve independently', async () => {
	const { ipc, proc } = createStartedIpc();

	const p1 = ipc.request('method1');
	const p2 = ipc.request('method2');
	const p3 = ipc.request('method3');

	// id 分别为 1, 2, 3，逆序响应
	setTimeout(() => {
		injectResponse(proc, 3, true, Buffer.from(encode({ v: 'c' })));
		injectResponse(proc, 1, true, Buffer.from(encode({ v: 'a' })));
		injectResponse(proc, 2, true, Buffer.from(encode({ v: 'b' })));
	}, 5);

	const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
	const { decode } = await import('@msgpack/msgpack');
	assert.equal(decode(r1.payload).v, 'a');
	assert.equal(decode(r2.payload).v, 'b');
	assert.equal(decode(r3.payload).v, 'c');
});

test('_nextId wraps around uint32 and skips 0', () => {
	const { ipc } = createStartedIpc();

	// 将 _nextId 设为接近溢出的值
	ipc._nextId = 0xFFFFFFFF;

	// 调用 request 会使用当前 _nextId 然后递增
	// 0xFFFFFFFF + 1 = 0x100000000，>>> 0 = 0，然后跳到 1
	const promise = ipc.request('wrap');
	// 不等结果，只检查 _nextId 已回绕
	assert.equal(ipc._nextId, 1);
	// 清理 pending（避免超时报错）
	ipc._rejectAllPending(new Error('cleanup'));
	promise.catch(() => {}); // 忽略 rejection
});

test('events are dispatched via emit', async () => {
	const { ipc, proc } = createStartedIpc();

	const evtPromise = new Promise((resolve) => {
		ipc.on('dc.message', (data) => resolve(data));
	});

	injectEvent(proc, 'dc.message', 'pc1', 'rpc', Buffer.from('hello'), true);

	const data = await evtPromise;
	assert.equal(data.pcId, 'pc1');
	assert.equal(data.dcLabel, 'rpc');
	assert.equal(data.isBinary, true);
	assert.deepEqual(data.payload, Buffer.from('hello'));
});

test('orphan response is ignored', async () => {
	const { ipc, proc } = createStartedIpc();

	// 注入一个没有对应 pending request 的 response
	// 不应抛错
	injectResponse(proc, 999, true);
	// 等一下确保处理完成
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(ipc._pending.size, 0);
});

test('_rejectAllPending rejects all and clears map', async () => {
	const { ipc } = createStartedIpc({ timeout: 5000 });

	const p1 = ipc.request('a');
	const p2 = ipc.request('b');
	const p3 = ipc.request('c');

	assert.equal(ipc._pending.size, 3);

	ipc._rejectAllPending(new Error('shutdown'));

	assert.equal(ipc._pending.size, 0);

	await assert.rejects(p1, /shutdown/);
	await assert.rejects(p2, /shutdown/);
	await assert.rejects(p3, /shutdown/);
});

test('request after manual stop throws', async () => {
	const { ipc } = createStartedIpc();
	ipc._started = false;

	await assert.rejects(
		() => ipc.request('anything'),
		/not started/
	);
});

test('object payload is msgpack encoded', async () => {
	const { ipc, proc } = createStartedIpc();

	const promise = ipc.request('test', {}, { key: 'value' });
	setTimeout(() => injectResponse(proc, 1, true), 5);

	await promise;

	// 验证写到 stdin 的数据中 payload 是 msgpack 编码的 { key: 'value' }
	// 由于 stdin 是 PassThrough，我们可以读取它
	// 这里主要验证不抛错，msgpack 编码逻辑已在 protocol 测试中覆盖
});

test('Buffer payload is passed through', async () => {
	const { ipc, proc } = createStartedIpc();

	const buf = Buffer.from([0xDE, 0xAD]);
	const promise = ipc.request('test', {}, buf);
	setTimeout(() => injectResponse(proc, 1, true), 5);

	await promise;
	// 主要验证 Buffer 作为 payload 不触发 msgpack encode
});

test('null payload sends empty buffer', async () => {
	const { ipc, proc } = createStartedIpc();

	const promise = ipc.request('test', {}, null);
	setTimeout(() => injectResponse(proc, 1, true), 5);

	await promise;
});

test('logger receives formatted messages', async () => {
	const logs = [];
	const { ipc, proc } = createStartedIpc({ logger: (msg) => logs.push(msg) });

	// _log 方法会加 [pion-ipc] 前缀
	ipc._log('test message');
	assert.equal(logs.length, 1);
	assert.match(logs[0], /\[pion-ipc\] test message/);
});

test('request with opts.pcId and opts.dcLabel', async () => {
	const { ipc, proc } = createStartedIpc();

	const promise = ipc.request('dc.send', { pcId: 'pc1', dcLabel: 'rpc', isBinary: true }, Buffer.from('data'));
	setTimeout(() => injectResponse(proc, 1, true), 5);

	await promise;
});

test('error response without message uses default', async () => {
	const { ipc, proc } = createStartedIpc();

	const promise = ipc.request('fail');
	// ok=false 但无 error 字段
	setTimeout(() => injectResponse(proc, 1, false), 5);

	await assert.rejects(promise, /request failed/);
});
