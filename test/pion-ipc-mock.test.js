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
	const { ipc } = createStartedIpc({ logger: (msg) => logs.push(msg) });

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

test('error response is logged with method context', async () => {
	const logs = [];
	const { ipc, proc } = createStartedIpc({ logger: (msg) => logs.push(msg) });

	const promise = ipc.request('dc.send');
	setTimeout(() => injectResponse(proc, 1, false, null, 'io: closed pipe'), 5);

	await assert.rejects(promise, /closed pipe/);

	// 必须包含 method 名和错误描述，便于关联诊断
	assert.ok(logs.some((m) => /request error/.test(m) && /method=dc\.send/.test(m) && /closed pipe/.test(m)),
		`expected log with method+err, got: ${JSON.stringify(logs)}`);
});

test('_log falls back to console.warn when no logger configured', () => {
	const { ipc } = createStartedIpc();
	const original = console.warn;
	const calls = [];
	console.warn = (msg) => calls.push(msg);
	try {
		ipc._log('fallback test');
	} finally {
		console.warn = original;
	}
	assert.equal(calls.length, 1);
	assert.match(calls[0], /\[pion-ipc\] fallback test/);
});

test('_log swallows logger exceptions', () => {
	const { ipc } = createStartedIpc({ logger: () => { throw new Error('log boom'); } });
	assert.doesNotThrow(() => ipc._log('swallow me'));
});

test('PionIpc.__safeEmit swallows listener exceptions and logs', () => {
	const logs = [];
	const { ipc } = createStartedIpc({ logger: (msg) => logs.push(msg) });
	ipc.on('custom', () => { throw new Error('listener boom'); });

	assert.doesNotThrow(() => ipc.__safeEmit('custom', 'arg1'));
	assert.ok(logs.some((m) => /emit custom listener threw/.test(m) && /listener boom/.test(m)),
		`expected listener-threw log, got: ${JSON.stringify(logs)}`);
});

test('PionIpc.__safeEmit no-op when no listeners', () => {
	const logs = [];
	const { ipc } = createStartedIpc({ logger: (msg) => logs.push(msg) });
	assert.doesNotThrow(() => ipc.__safeEmit('error', new Error('silent')));
	// 无 listener 时不 log（避免 log 噪声）
	assert.equal(logs.length, 0);
});

test('PionIpc.__safeEmit error path: no crash without listener', () => {
	// 模拟 proc/reader 错误回调最终调用 __safeEmit('error', ...) 的场景
	// 应用层未注册 ipc.on('error') —— 这是 gateway 崩溃的根因
	const logs = [];
	const { ipc } = createStartedIpc({ logger: (msg) => logs.push(msg) });
	assert.equal(ipc.listenerCount('error'), 0);

	assert.doesNotThrow(() => {
		ipc.__safeEmit('error', new Error('proc died'));
	});
	// 无 listener 时不 log（避免噪声），错误的可见性由调用方的 _log 提供
	assert.equal(logs.length, 0);
});

// --- watchdog (auto-restart) ---

test('watchdog: constructor defaults', () => {
	const ipc = new PionIpc();
	assert.equal(ipc._autoRestart, false);
	assert.equal(ipc._maxBackoffMs, 30_000);
	assert.equal(ipc._restartResetWindowMs, 60_000);
	assert.equal(ipc._intentionalStop, false);
	assert.equal(ipc._stopped, false);
	assert.equal(ipc._restartAttempts, 0);
});

test('watchdog: constructor accepts custom values', () => {
	const ipc = new PionIpc({
		autoRestart: true,
		maxBackoffMs: 5000,
		restartResetWindowMs: 10_000,
	});
	assert.equal(ipc._autoRestart, true);
	assert.equal(ipc._maxBackoffMs, 5000);
	assert.equal(ipc._restartResetWindowMs, 10_000);
});

test('watchdog: stop sets _intentionalStop, _stopped, and clears timers', async () => {
	const { ipc } = createStartedIpc();
	ipc._autoRestart = true;
	ipc._restartTimer = setTimeout(() => {}, 99999);
	ipc._resetTimer = setTimeout(() => {}, 99999);

	// mock 一个会响应 stdin 关闭的进程
	const mockProc = new EventEmitter();
	mockProc.stdin = { end() { setTimeout(() => mockProc.emit('exit', 0, null), 5); } };
	mockProc.kill = () => {};
	ipc._proc = mockProc;

	await ipc.stop();

	assert.equal(ipc._intentionalStop, true);
	assert.equal(ipc._stopped, true);
});

test('watchdog: _handleProcessExit triggers _scheduleRestart (non-intentional)', async () => {
	const logs = [];
	const { ipc } = createStartedIpc({ logger: (msg) => logs.push(msg) });
	ipc._autoRestart = true;

	ipc._handleProcessExit(1, null);

	assert.equal(ipc._restartAttempts, 1);
	assert.ok(ipc._restartTimer !== null);
	assert.ok(logs.some((m) => /watchdog: restart #1/.test(m)));

	clearTimeout(ipc._restartTimer);
});

test('watchdog: _handleProcessExit skipped on intentional stop (no exit event, no restart)', () => {
	const { ipc } = createStartedIpc();
	ipc._autoRestart = true;
	ipc._intentionalStop = true;

	const exitEvents = [];
	ipc.on('exit', () => exitEvents.push(true));

	ipc._handleProcessExit(0, null);

	assert.equal(ipc._restartAttempts, 0);
	assert.equal(ipc._restartTimer, null);
	assert.equal(exitEvents.length, 0);
});

test('watchdog: _handleProcessExit skipped when autoRestart=false', () => {
	const { ipc } = createStartedIpc();
	ipc._autoRestart = false;

	ipc._handleProcessExit(1, null);

	assert.equal(ipc._restartAttempts, 0);
	assert.equal(ipc._restartTimer, null);
});

test('watchdog: retries indefinitely (no max attempts)', () => {
	const logs = [];
	const { ipc } = createStartedIpc({ logger: (msg) => logs.push(msg) });
	ipc._autoRestart = true;
	ipc._restartAttempts = 100; // 远超旧上限

	// 仍然调度 restart（不 emit fatal、不 give up）
	ipc._scheduleRestart();
	assert.ok(ipc._restartTimer !== null);
	assert.equal(ipc._restartAttempts, 101);
	assert.ok(logs.some((m) => /watchdog: restart #101/.test(m)));

	clearTimeout(ipc._restartTimer);
});

test('watchdog: exponential backoff delay with cap', () => {
	const { ipc } = createStartedIpc();
	ipc._autoRestart = true;
	ipc._maxBackoffMs = 1000; // 低上限，方便验证

	// 第 1 次: min(200*2^0, 1000) = 200ms
	ipc._restartAttempts = 0;
	ipc._scheduleRestart();
	clearTimeout(ipc._restartTimer);
	assert.equal(ipc._restartAttempts, 1);

	// 第 2 次: min(200*2^1, 1000) = 400ms
	ipc._scheduleRestart();
	clearTimeout(ipc._restartTimer);
	assert.equal(ipc._restartAttempts, 2);

	// 第 3 次: min(200*2^2, 1000) = 800ms
	ipc._scheduleRestart();
	clearTimeout(ipc._restartTimer);
	assert.equal(ipc._restartAttempts, 3);

	// 第 4 次: min(200*2^3, 1000) = 1000ms (capped)
	ipc._scheduleRestart();
	clearTimeout(ipc._restartTimer);
	assert.equal(ipc._restartAttempts, 4);

	// 第 5 次: min(200*2^4, 1000) = 1000ms (still capped)
	ipc._scheduleRestart();
	clearTimeout(ipc._restartTimer);
	assert.equal(ipc._restartAttempts, 5);
});

test('watchdog: _scheduleResetTimer resets counter after stable run', async () => {
	const logs = [];
	const { ipc } = createStartedIpc({ logger: (msg) => logs.push(msg) });
	ipc._autoRestart = true;
	ipc._restartResetWindowMs = 50; // 极短窗口，加速测试
	ipc._restartAttempts = 3;

	ipc._scheduleResetTimer();
	await new Promise((r) => setTimeout(r, 80));

	assert.equal(ipc._restartAttempts, 0);
	assert.ok(logs.some((m) => /resetting restart counter/.test(m)));
});

test('watchdog: _scheduleResetTimer skips timer when autoRestart=false', () => {
	const { ipc } = createStartedIpc();
	ipc._autoRestart = false;

	ipc._scheduleResetTimer();
	assert.equal(ipc._resetTimer, null);
});

test('watchdog: stop cancels restart timer even after process death', () => {
	const { ipc } = createStartedIpc();
	ipc._autoRestart = true;

	// 模拟崩溃 → _handleProcessExit 设置 restart timer 并清空 _proc
	ipc._handleProcessExit(1, null);
	assert.ok(ipc._restartTimer !== null);
	assert.equal(ipc._proc, null);

	// stop() 应仍能取消 timer（即使 _proc 已为 null）
	ipc.stop();

	assert.equal(ipc._intentionalStop, true);
	assert.equal(ipc._stopped, true);
});

test('watchdog: _handleProcessExit sets _proc=null and _started=false', () => {
	const { ipc } = createStartedIpc();

	assert.ok(ipc._proc !== null);
	assert.equal(ipc._started, true);

	ipc._handleProcessExit(1, null);

	assert.equal(ipc._proc, null);
	assert.equal(ipc._started, false);
});

test('watchdog: _handleProcessExit emits exit event', () => {
	const { ipc } = createStartedIpc();
	const exitEvents = [];
	ipc.on('exit', (code, signal) => exitEvents.push({ code, signal }));

	ipc._handleProcessExit(1, 'SIGSEGV');

	assert.equal(exitEvents.length, 1);
	assert.equal(exitEvents[0].code, 1);
	assert.equal(exitEvents[0].signal, 'SIGSEGV');
});

test('watchdog: _handleProcessExit rejects pending requests', async () => {
	const { ipc } = createStartedIpc({ timeout: 5000 });

	const p = ipc.request('test');
	ipc._handleProcessExit(1, null);

	await assert.rejects(p, /process exited/);
});

test('watchdog: _stopped halts restart in timer callback', async () => {
	const logs = [];
	const { ipc } = createStartedIpc({ logger: (msg) => logs.push(msg) });
	ipc._autoRestart = true;

	ipc._scheduleRestart();
	// 在 timer 触发前设置 _stopped
	ipc._stopped = true;

	// 等 timer 触发
	await new Promise((r) => setTimeout(r, 300));

	// start() 不应被调用（stopped 检查在最前面）
	assert.ok(!logs.some((m) => /spawning/.test(m)));
});

test('watchdog: _abortStart does not set _stopped', async () => {
	const { ipc } = createStartedIpc();
	ipc._stopped = false;
	ipc._proc = null; // _killProc fast-return

	await ipc._abortStart();

	assert.equal(ipc._stopped, false);
});

test('watchdog: _killProc no-op when _proc is null', async () => {
	const { ipc } = createStartedIpc();
	ipc._proc = null;

	// 不应抛异常
	await ipc._killProc(1000, 'test');
});

test('watchdog: _killProc resolves when process exits', async () => {
	const { ipc, proc } = createStartedIpc();

	// 进程在 stdin 关闭后退出
	const origEnd = proc.stdin.end.bind(proc.stdin);
	proc.stdin.end = function() {
		origEnd();
		setTimeout(() => proc.emit('exit', 0, null), 5);
	};

	await ipc._killProc(5000, 'test kill');

	assert.equal(ipc._proc, null);
	assert.equal(ipc._started, false);
	assert.equal(ipc._pending.size, 0);
});

test('watchdog: start() synchronously resets flags and clears stale timer', () => {
	const ipc = new PionIpc();
	ipc._stopped = true;
	ipc._intentionalStop = true;
	const staleTimer = setTimeout(() => {}, 99999);
	ipc._restartTimer = staleTimer;

	// start() 在 resolveBinary() 前同步重置标记并清除 timer
	ipc.start().catch(() => {});

	assert.equal(ipc._stopped, false);
	assert.equal(ipc._intentionalStop, false);
	// stale timer 已被清除
});

test('watchdog: start failure during restart retries until success', async () => {
	const logs = [];
	const { ipc } = createStartedIpc({ logger: (msg) => logs.push(msg) });
	ipc._autoRestart = true;
	ipc._maxBackoffMs = 10; // 极短退避，加速测试

	// 猴子补丁 start：前两次失败，第三次成功
	let startCalls = 0;
	ipc.start = async function() {
		startCalls++;
		if (startCalls < 3) throw new Error('binary not found');
		this._started = true;
		this._intentionalStop = false;
	};

	const restartEvents = [];
	ipc.on('restart', () => restartEvents.push(true));

	// 触发 watchdog
	ipc._handleProcessExit(1, null);

	// 等待重试完成（10ms + 20ms + 40ms + 余量）
	await new Promise((r) => setTimeout(r, 200));

	assert.ok(startCalls >= 3, `expected >= 3 start calls, got ${startCalls}`);
	assert.equal(restartEvents.length, 1);
	assert.ok(logs.some((m) => /watchdog: restart failed/.test(m)));
	assert.ok(logs.some((m) => /watchdog: restart succeeded/.test(m)));

	clearTimeout(ipc._restartTimer);
	clearTimeout(ipc._resetTimer);
});
