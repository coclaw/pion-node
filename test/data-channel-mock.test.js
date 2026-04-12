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

// === R 方案：bufferedAmount 由 send ack 推送式更新（非 lazy refresh）===

test('R 方案: drain ack 携带的 Go-side BA 立即刷新缓存', async () => {
	const { encode } = await import('@msgpack/msgpack');
	const ipc = createMockIpc();
	// mock: dc.send 返回带 bufferedAmount 字段的 ack（模拟 pion-go 改造后的行为）
	ipc.request = async (method) => {
		if (method === 'dc.send') {
			return { header: {}, payload: Buffer.from(encode({ bufferedAmount: 1024 * 1024 })) };
		}
		return { header: {}, payload: Buffer.alloc(0) };
	};
	const dc = createOpenDc(ipc);

	// 初始：cache 为 0
	assert.equal(dc.bufferedAmount, 0);

	// send 一帧
	dc.send('hi');
	// 同步：_bufferedAmount = 2，cache 仍为 0，sum = 2
	assert.equal(dc.bufferedAmount, 2);

	// 等 drain ack 处理完
	await new Promise((r) => setTimeout(r, 20));

	// drain 完成：_bufferedAmount = 0，_goBufferedBytes = 1MB（来自 ack），sum = 1MB
	assert.equal(dc.bufferedAmount, 1024 * 1024);
});

test('R 方案: ack payload 缺失或非法时保留旧缓存（不崩溃）', async () => {
	const { encode } = await import('@msgpack/msgpack');
	const ipc = createMockIpc();
	let callCount = 0;
	ipc.request = async (method) => {
		if (method === 'dc.send') {
			callCount++;
			// 第 1 次：合法 ack
			if (callCount === 1) {
				return { header: {}, payload: Buffer.from(encode({ bufferedAmount: 500 })) };
			}
			// 第 2 次：空 payload
			if (callCount === 2) return { header: {}, payload: Buffer.alloc(0) };
			// 第 3 次：垃圾字节（msgpack decode 失败）
			return { header: {}, payload: Buffer.from([0xff, 0xff, 0xff]) };
		}
		return { header: {}, payload: Buffer.alloc(0) };
	};
	const dc = createOpenDc(ipc);

	dc.send('a');
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(dc._goBufferedBytes, 500, '第 1 次 ack 后缓存为 500');

	dc.send('b');
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(dc._goBufferedBytes, 500, '空 payload 应保留旧缓存');

	dc.send('c');
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(dc._goBufferedBytes, 500, '非法 payload 应保留旧缓存');
});

test('R 方案: ack 中负值或非有限数被忽略（防御性）', async () => {
	const { encode } = await import('@msgpack/msgpack');
	const ipc = createMockIpc();
	let callCount = 0;
	ipc.request = async (method) => {
		if (method === 'dc.send') {
			callCount++;
			if (callCount === 1) return { header: {}, payload: Buffer.from(encode({ bufferedAmount: 1000 })) };
			// 协议异常：负数
			if (callCount === 2) return { header: {}, payload: Buffer.from(encode({ bufferedAmount: -1 })) };
			// 协议异常：缺字段
			return { header: {}, payload: Buffer.from(encode({ foo: 'bar' })) };
		}
		return { header: {}, payload: Buffer.alloc(0) };
	};
	const dc = createOpenDc(ipc);

	dc.send('a');
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(dc._goBufferedBytes, 1000);

	dc.send('b');
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(dc._goBufferedBytes, 1000, '负数应被忽略');

	dc.send('c');
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(dc._goBufferedBytes, 1000, '缺字段（NaN）应被忽略');
});

test('R 方案: bufferedAmount getter — connecting 返回 0, closing/open 返回 sum', () => {
	const ipc = createMockIpc();
	const dc = new RTCDataChannel({ _ipc: ipc, _pcId: 'pc-1', _label: 'rpc' });
	// 注入 cache 模拟"曾经发过"的情况
	dc._goBufferedBytes = 99999;
	dc._bufferedAmount = 12345;

	// connecting 状态：还没发任何东西，返回 0
	assert.equal(dc.readyState, 'connecting');
	assert.equal(dc.bufferedAmount, 0, 'connecting 状态返回 0');

	// closing 状态：drain 仍在进行，残余字节真实存在，返回完整 sum（W3C 规范）
	dc._readyState = 'closing';
	assert.equal(dc.bufferedAmount, 99999 + 12345, 'closing 状态返回真实 sum');

	// open 状态返回 sum
	dc._readyState = 'open';
	assert.equal(dc.bufferedAmount, 99999 + 12345);
});

test('R 方案: close() 之后 getter 返回 0 (cache 已清零)', async () => {
	const ipc = createMockIpc();
	const dc = createOpenDc(ipc);
	// 模拟有 cache 残留
	dc._goBufferedBytes = 5000;
	dc._bufferedAmount = 100;

	// graceful close：sendQueue 已空，立即清零
	await dc.close();

	assert.equal(dc.readyState, 'closed');
	assert.equal(dc.bufferedAmount, 0, 'close() 后 getter 返回 0');
	assert.equal(dc._goBufferedBytes, 0);
	assert.equal(dc._bufferedAmount, 0);
});

test('R 方案: bal IPC 后 _refreshGoBA 从 dc.getBA 刷新 _goBufferedBytes', async () => {
	const { encode } = await import('@msgpack/msgpack');
	const ipc = createMockIpc();
	const origReq = ipc.request;
	ipc.request = async (method, opts, payload) => {
		if (method === 'dc.getBA') {
			return { header: {}, payload: Buffer.from(encode({ bufferedAmount: 200 })) };
		}
		return origReq(method, opts, payload);
	};
	const dc = createOpenDc(ipc);
	dc._goBufferedBytes = 5000;

	const events = [];
	dc.on('bufferedamountlow', () => events.push('bal'));
	ipc.emit('dc.bufferedamountlow', { pcId: 'pc-1', dcLabel: 'rpc' });

	await new Promise((r) => setTimeout(r, 20));

	assert.equal(dc._goBufferedBytes, 200, 'dc.getBA 应刷新 _goBufferedBytes');
	assert.equal(events.length, 1, 'event emitted');
});

test('R 方案: _refreshGoBA dc.getBA 失败时仍 emit bufferedamountlow（旧行为回退）', async () => {
	const ipc = createMockIpc();
	const origReq = ipc.request;
	ipc.request = async (method, opts, payload) => {
		if (method === 'dc.getBA') throw new Error('IPC dead');
		return origReq(method, opts, payload);
	};
	const dc = createOpenDc(ipc);
	dc._goBufferedBytes = 5000;

	const events = [];
	dc.on('bufferedamountlow', () => events.push('bal'));
	ipc.emit('dc.bufferedamountlow', { pcId: 'pc-1', dcLabel: 'rpc' });

	await new Promise((r) => setTimeout(r, 20));

	// 缓存不变（IPC 失败保留旧值）
	assert.equal(dc._goBufferedBytes, 5000, '_goBufferedBytes 应保持不变');
	// 仍 emit 事件（旧行为回退，不阻断上层流控）
	assert.equal(events.length, 1, 'event emitted despite IPC failure');
});

test('R 方案: _refreshGoBA 在 close 后不调 dc.getBA', async () => {
	const ipc = createMockIpc();
	const dc = createOpenDc(ipc);
	await dc.close();

	const reqsBefore = ipc.requests.length;
	// 直接调用 _refreshGoBA（模拟 close 后的残余 bal 事件）
	dc._refreshGoBA();
	await new Promise((r) => setTimeout(r, 20));

	const getBAReqs = ipc.requests.slice(reqsBefore).filter((r) => r.method === 'dc.getBA');
	assert.equal(getBAReqs.length, 0, 'close 后不应发 dc.getBA');
});

test('R 方案: _refreshGoBA close 期间 in-flight dc.getBA 不更新缓存也不 emit', async () => {
	const { encode } = await import('@msgpack/msgpack');
	let resolveGetBA;
	const ipc = createMockIpc();
	const origReq = ipc.request;
	ipc.request = async (method, opts, payload) => {
		if (method === 'dc.getBA') {
			return new Promise((r) => { resolveGetBA = r; });
		}
		return origReq(method, opts, payload);
	};
	const dc = createOpenDc(ipc);
	dc._goBufferedBytes = 5000;

	const events = [];
	dc.on('bufferedamountlow', () => events.push('bal'));

	// 触发 _refreshGoBA——dc.getBA 请求 in flight
	ipc.emit('dc.bufferedamountlow', { pcId: 'pc-1', dcLabel: 'rpc' });
	await new Promise((r) => setTimeout(r, 10));

	// 在 dc.getBA pending 期间关闭 DC
	await dc.close();

	// 此时 resolve 之前 pending 的 dc.getBA
	resolveGetBA({ header: {}, payload: Buffer.from(encode({ bufferedAmount: 42 })) });
	await new Promise((r) => setTimeout(r, 20));

	// .then() 异步守卫检测到 _closed，不应更新缓存或 emit
	assert.equal(dc._goBufferedBytes, 0, 'close 已清零，不应被 in-flight 响应覆盖');
	assert.equal(events.length, 0, 'post-close 不应 emit bufferedamountlow');
});

test('R 方案: threshold-cross 检测使用 sum (JS+Go)，避免 JS 队列空但 Go 仍满时虚假早醒', async () => {
	const { encode } = await import('@msgpack/msgpack');
	const ipc = createMockIpc();
	// mock: 每次 send ack 都报告 Go 端有 100KB buffered
	ipc.request = async (method) => {
		if (method === 'dc.send') {
			return { header: {}, payload: Buffer.from(encode({ bufferedAmount: 100 * 1024 })) };
		}
		return { header: {}, payload: Buffer.alloc(0) };
	};
	const dc = createOpenDc(ipc);
	// threshold = 50KB
	dc.bufferedAmountLowThreshold = 50 * 1024;
	await new Promise((r) => setTimeout(r, 20));

	const events = [];
	dc.on('bufferedamountlow', () => events.push('bal'));

	// 发一帧 → 等 drain
	dc.send(Buffer.alloc(10 * 1024));
	await new Promise((r) => setTimeout(r, 30));

	// _bufferedAmount: 10KB → 0，但 _goBufferedBytes = 100KB > 50KB threshold
	// total 始终 > threshold，**不应**触发 bufferedamountlow
	assert.equal(events.length, 0, 'sum 始终高于 threshold，不应虚假早醒');
});

test('R 方案 (regression A4): close 期间 in-flight ack 不会复活 cache 或 emit', async () => {
	// 关键回归：close() 强制清零后，drain loop 内的 await ipc.request 可能还在 pending，
	// 当 ack 回来时，drain 必须重新检查 _closed，否则会用 ack 中的 BA 复活 _goBufferedBytes，
	// 并可能错误 emit bufferedamountlow（post-close 事件不合规）。
	const { encode } = await import('@msgpack/msgpack');
	let resolveSend;
	const ipc = createMockIpc();
	ipc.request = async (method) => {
		if (method === 'dc.send') {
			// 永不立即 resolve，由测试控制
			return new Promise((r) => { resolveSend = r; });
		}
		return { header: {}, payload: Buffer.alloc(0) };
	};
	const dc = new RTCDataChannel({ _ipc: ipc, _pcId: 'pc-1', _label: 'rpc', _closeDrainTimeoutMs: 50 });
	ipc.emit('dc.open', { pcId: 'pc-1', dcLabel: 'rpc' });
	dc.bufferedAmountLowThreshold = 100;

	const events = [];
	dc.on('bufferedamountlow', () => events.push('bal'));

	// 发一个 chunk 并启动 drain，drain 会卡在 await ipc.request
	dc.send(Buffer.alloc(50));

	// 等 drain 进入 await
	await new Promise((r) => setTimeout(r, 10));

	// 关闭 — close() 会等 drain timeout（注入 50ms）然后强制清零
	const closePromise = dc.close();

	// close 等待期间 resolve 那个挂起的 send，让 drain 拿到 ack
	await new Promise((r) => setTimeout(r, 20));
	resolveSend({ header: {}, payload: Buffer.from(encode({ bufferedAmount: 999 })) });

	// 等 close 完成（含 drain timeout）
	await closePromise;

	// 关键断言：close 之后 cache 应保持 0（drain 不应复活它）
	assert.equal(dc._goBufferedBytes, 0, 'cache 应保持 close 时清零的状态');
	assert.equal(dc._bufferedAmount, 0);
	// 也不应触发 bufferedamountlow（post-close 事件违规）
	assert.equal(events.length, 0, 'post-close 不应 emit bufferedamountlow');
});

test('R 方案 (regression A1): Go-side BA 在 ack 中跨过 threshold 时正确 emit bufferedamountlow', async () => {
	// 关键回归：threshold-cross 检测必须使用 ack 之前的 prevTotal，
	// 否则当 ack 携带的新 BA 大幅低于阈值时，会被错误地用作 prev → 不 emit。
	// 场景：cache 200，threshold 100，ack 报告 60（Go 端在 send 期间已 drain），send 1 字节
	// 旧 bug：prevTotal = 0+60 = 60（已经 < 100），newTotal 同理 → 无 cross，不 emit
	// 修复后：prevTotal = 0+200 = 200 > 100，newTotal = 0+60 = 60 ≤ 100 → emit ✓
	const { encode } = await import('@msgpack/msgpack');
	const ipc = createMockIpc();
	ipc.request = async (method) => {
		if (method === 'dc.send') {
			return { header: {}, payload: Buffer.from(encode({ bufferedAmount: 60 })) };
		}
		return { header: {}, payload: Buffer.alloc(0) };
	};
	const dc = createOpenDc(ipc);
	dc._goBufferedBytes = 200; // 注入残留 cache 模拟 Go 端 buffered
	dc.bufferedAmountLowThreshold = 100;
	await new Promise((r) => setTimeout(r, 20));

	const events = [];
	dc.on('bufferedamountlow', () => events.push('bal'));

	dc.send(Buffer.alloc(1));
	await new Promise((r) => setTimeout(r, 30));

	assert.equal(events.length, 1, 'cache 200→60 跨过 threshold 100，必须 emit');
});

test('R 方案: drain 完成且 sum 跨过 threshold 时正常 emit bufferedamountlow', async () => {
	const { encode } = await import('@msgpack/msgpack');
	const ipc = createMockIpc();
	// mock: send ack 报告 Go 端 0 buffered
	ipc.request = async (method) => {
		if (method === 'dc.send') {
			return { header: {}, payload: Buffer.from(encode({ bufferedAmount: 0 })) };
		}
		return { header: {}, payload: Buffer.alloc(0) };
	};
	const dc = createOpenDc(ipc);
	dc.bufferedAmountLowThreshold = 5;
	await new Promise((r) => setTimeout(r, 20));

	const events = [];
	dc.on('bufferedamountlow', () => events.push('bal'));

	dc.send(Buffer.alloc(10)); // 10 bytes > 5 threshold
	await new Promise((r) => setTimeout(r, 30));

	// drain 后 _bufferedAmount = 0, _goBufferedBytes = 0, total = 0 ≤ 5 < prev 10
	assert.equal(events.length, 1, 'sum 跨过 threshold 应触发');
});

test('close graceful: 等待 sendQueue 排空后再关闭（最后一条消息不丢且顺序正确）', async () => {
	const sentPayloads = [];
	const ipc = createMockIpc();
	// 慢 IPC：每次 dc.send 延迟 20ms，模拟 in-flight 消息
	ipc.request = async (method, opts, payload) => {
		if (method === 'dc.send') {
			sentPayloads.push(payload?.toString?.('utf8') ?? String(payload));
			await new Promise((r) => setTimeout(r, 20));
		}
		return { header: {}, payload: Buffer.alloc(0) };
	};
	const dc = createOpenDc(ipc);

	dc.send('chunk1');
	dc.send('chunk2');
	dc.send('FINAL'); // 最后一条
	// 紧接着关闭 — graceful close 应等 3 条全部 IPC 完成
	await dc.close();

	assert.equal(sentPayloads.length, 3, 'all queued messages must be sent before close');
	// 顺序断言：不能因 drain 重排
	assert.deepEqual(sentPayloads, ['chunk1', 'chunk2', 'FINAL'], 'messages must be sent in FIFO order');
	assert.equal(dc.readyState, 'closed');
});

test('close graceful: 超时后丢弃残余消息并强关（注入短超时）', async () => {
	const logs = [];
	const ipc = createMockIpc();
	ipc._log = (msg) => logs.push(msg);
	// IPC dc.send 永远 hang，模拟 drain 卡死
	let resolveSend;
	ipc.request = async (method) => {
		if (method === 'dc.send') {
			return new Promise((r) => { resolveSend = r; }); // 永不 resolve
		}
		return { header: {}, payload: Buffer.alloc(0) };
	};
	// 注入短超时让测试快速完成
	const dc = new RTCDataChannel({ _ipc: ipc, _pcId: 'pc-1', _label: 'rpc', _closeDrainTimeoutMs: 100 });
	ipc.emit('dc.open', { pcId: 'pc-1', dcLabel: 'rpc' });
	dc.send('hangs');

	const closeStarted = Date.now();
	await dc.close();
	const elapsed = Date.now() - closeStarted;

	assert.ok(elapsed >= 90, `close should wait ~100ms before timeout, got ${elapsed}ms`);
	assert.ok(elapsed < 250, `close should not exceed 250ms, got ${elapsed}ms`);
	assert.equal(dc.readyState, 'closed');
	assert.ok(logs.some((m) => /close drain timeout/.test(m)),
		`expected drain timeout log, got: ${JSON.stringify(logs)}`);

	// 释放 hung promise 防止干扰其他测试
	resolveSend?.({ header: {}, payload: Buffer.alloc(0) });
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

test('dc.bufferedamountlow event fires after dc.getBA refresh', async () => {
	const ipc = createMockIpc();
	const dc = createOpenDc(ipc);

	let fired = false;
	dc.on('bufferedamountlow', () => { fired = true; });

	// label 不匹配——不触发
	ipc.emit('dc.bufferedamountlow', { pcId: 'pc-1', dcLabel: 'other' });
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(fired, false);

	// 匹配——通过 dc.getBA roundtrip 后 emit
	ipc.emit('dc.bufferedamountlow', { pcId: 'pc-1', dcLabel: 'rpc' });
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(fired, true);
});

test('R 方案: dc.bufferedamountlow 在 connecting/closed 状态被丢弃', async () => {
	const ipc = createMockIpc();
	const dc = new RTCDataChannel({ _ipc: ipc, _pcId: 'pc-1', _label: 'rpc' });

	const events = [];
	dc.on('bufferedamountlow', () => events.push('bal'));

	// connecting 状态——_onDcBal 直接 return，不调 _refreshGoBA
	assert.equal(dc.readyState, 'connecting');
	ipc.emit('dc.bufferedamountlow', { pcId: 'pc-1', dcLabel: 'rpc' });
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(events.length, 0, 'connecting 状态不应触发');

	// 切到 closed
	dc._readyState = 'closed';
	ipc.emit('dc.bufferedamountlow', { pcId: 'pc-1', dcLabel: 'rpc' });
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(events.length, 0, 'closed 状态不应触发');
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

test('__reportError logs to ipc logger and emits when listener exists', () => {
	const logs = [];
	const ipc = createMockIpc();
	ipc._log = (msg) => logs.push(msg);
	const dc = new RTCDataChannel({ _ipc: ipc, _pcId: 'pc-1', _label: 'rpc' });

	const errors = [];
	dc.on('error', (err) => errors.push(err));

	dc.__reportError(new Error('boom'), 'unit-test');

	assert.equal(logs.length, 1);
	assert.match(logs[0], /pcId=pc-1/);
	assert.match(logs[0], /label=rpc/);
	assert.match(logs[0], /ctx=unit-test/);
	assert.match(logs[0], /err=boom/);
	assert.equal(errors.length, 1);
});

test('__reportError still logs even when no error listener (no throw)', () => {
	const logs = [];
	const ipc = createMockIpc();
	ipc._log = (msg) => logs.push(msg);
	const dc = new RTCDataChannel({ _ipc: ipc, _pcId: 'pc-1', _label: 'rpc' });

	// 故意不注册 error listener — 验证不抛 unhandled
	assert.doesNotThrow(() => {
		dc.__reportError(new Error('silent'), 'no-listener');
	});

	assert.equal(logs.length, 1);
	assert.match(logs[0], /err=silent/);
});

test('send error without listener does not throw or crash (regression)', async () => {
	const logs = [];
	const ipc = createMockIpc();
	ipc._log = (msg) => logs.push(msg);
	ipc.request = async (method) => {
		if (method === 'dc.send') throw new Error('io: read/write on closed pipe');
		return { header: {}, payload: Buffer.alloc(0) };
	};
	const dc = createOpenDc(ipc);

	// 故意不注册 dc.on('error') — 模拟 file handler 的早期实现
	dc.send('payload');

	await new Promise((r) => setTimeout(r, 50));

	// 关键：bufferedAmount 应当被正确清零（drainQueue 完成）
	assert.equal(dc.bufferedAmount, 0);
	// 关键：错误必须被 logger 捕获
	assert.ok(logs.some((m) => /ctx=send/.test(m) && /closed pipe/.test(m)));
});

test('remote dc.error event uses __reportError (no crash without listener)', () => {
	const logs = [];
	const ipc = createMockIpc();
	ipc._log = (msg) => logs.push(msg);
	const dc = new RTCDataChannel({ _ipc: ipc, _pcId: 'pc-1', _label: 'rpc' });
	// 不注册 error listener
	assert.equal(dc.listenerCount('error'), 0);

	assert.doesNotThrow(() => {
		ipc.emit('dc.error', {
			pcId: 'pc-1',
			dcLabel: 'rpc',
			payload: Buffer.from('remote oops'),
		});
	});

	assert.ok(logs.some((m) => /ctx=remote-error/.test(m) && /remote oops/.test(m)));
});

test('__safeEmit swallows listener exceptions and logs', () => {
	const logs = [];
	const ipc = createMockIpc();
	ipc._log = (msg) => logs.push(msg);
	const dc = new RTCDataChannel({ _ipc: ipc, _pcId: 'pc-1', _label: 'rpc' });

	// 注册一个会抛异常的 listener
	dc.on('bufferedamountlow', () => { throw new Error('listener boom'); });

	assert.doesNotThrow(() => dc.__safeEmit('bufferedamountlow'));

	assert.ok(logs.some((m) => /emit bufferedamountlow listener threw/.test(m) && /listener boom/.test(m)),
		`expected listener-threw log, got: ${JSON.stringify(logs)}`);
});

test('__reportError swallows error listener exceptions', () => {
	const logs = [];
	const ipc = createMockIpc();
	ipc._log = (msg) => logs.push(msg);
	const dc = new RTCDataChannel({ _ipc: ipc, _pcId: 'pc-1', _label: 'rpc' });

	dc.on('error', () => { throw new Error('error listener boom'); });

	// 即使 error listener 抛异常，__reportError 也不应抛出
	assert.doesNotThrow(() => dc.__reportError(new Error('orig'), 'unit'));

	// 既有 dc.error log 又有 listener 抛异常的 log
	assert.ok(logs.some((m) => /ctx=unit/.test(m) && /err=orig/.test(m)));
	assert.ok(logs.some((m) => /emit error listener threw/.test(m) && /error listener boom/.test(m)));
});

test('drain emit bufferedamountlow with throwing listener does not crash drain', async () => {
	const logs = [];
	const ipc = createMockIpc();
	ipc._log = (msg) => logs.push(msg);
	const dc = createOpenDc(ipc);
	dc.bufferedAmountLowThreshold = 0;

	// 注册一个会抛异常的 bufferedamountlow listener
	dc.on('bufferedamountlow', () => { throw new Error('balfn boom'); });

	dc.send('payload');
	await new Promise((r) => setTimeout(r, 50));

	// 关键：drain 完成，bufferedAmount 归零
	assert.equal(dc.bufferedAmount, 0);
	// 关键：listener 抛异常被 __safeEmit 吞掉并 log
	assert.ok(logs.some((m) => /emit bufferedamountlow listener threw/.test(m)));
});

test('setBALT failure routes through __reportError (no crash)', async () => {
	const logs = [];
	const ipc = createMockIpc();
	ipc._log = (msg) => logs.push(msg);
	ipc.request = async (method) => {
		if (method === 'dc.setBALT') throw new Error('balt failed');
		return { header: {}, payload: Buffer.alloc(0) };
	};
	const dc = new RTCDataChannel({ _ipc: ipc, _pcId: 'pc-1', _label: 'rpc' });
	// 不注册 error listener

	assert.doesNotThrow(() => {
		dc.bufferedAmountLowThreshold = 4096;
	});

	await new Promise((r) => setTimeout(r, 50));

	assert.ok(logs.some((m) => /ctx=setBALT/.test(m) && /balt failed/.test(m)));
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

// --- _forceClose (IPC 进程崩溃时的强制关闭) ---

test('_forceClose: open DC 立即变 closed 并 emit close', () => {
	const ipc = createMockIpc();
	const dc = createOpenDc(ipc);

	const events = [];
	dc.on('close', () => events.push('close'));

	dc._forceClose();

	assert.equal(dc.readyState, 'closed');
	assert.equal(dc._closed, true);
	assert.equal(dc._bufferedAmount, 0);
	assert.equal(dc._goBufferedBytes, 0);
	assert.equal(dc._sendQueue.length, 0);
	assert.equal(events.length, 1);
});

test('_forceClose: 清空 sendQueue 和 bufferedAmount', () => {
	const ipc = createMockIpc();
	// 模拟慢 IPC——阻止 drain 立即完成
	ipc.request = () => new Promise(() => {});
	const dc = createOpenDc(ipc);

	dc.send('queued-A');
	dc.send('queued-B');
	assert.ok(dc._sendQueue.length > 0 || dc._bufferedAmount > 0);

	dc._forceClose();

	assert.equal(dc._sendQueue.length, 0);
	assert.equal(dc._bufferedAmount, 0);
	assert.equal(dc.readyState, 'closed');
});

test('_forceClose: detach IPC 事件监听', () => {
	const ipc = createMockIpc();
	const dc = createOpenDc(ipc);

	const before = ipc.listenerCount('dc.open');
	dc._forceClose();
	assert.equal(ipc.listenerCount('dc.open'), before - 1);
});

test('_forceClose: 已 closed 的 DC 不重复 emit', () => {
	const ipc = createMockIpc();
	const dc = createOpenDc(ipc);

	const events = [];
	dc.on('close', () => events.push('close'));

	dc._forceClose();
	dc._forceClose(); // 重复调用

	assert.equal(events.length, 1);
});

test('_forceClose: connecting 状态直接关闭（不发 IPC）', () => {
	const ipc = createMockIpc();
	const dc = new RTCDataChannel({ _ipc: ipc, _pcId: 'pc-1', _label: 'rpc' });
	assert.equal(dc.readyState, 'connecting');

	dc._forceClose();

	assert.equal(dc.readyState, 'closed');
	assert.equal(dc._closed, true);
	// 未发送任何 IPC request（只有构造时注册的 listener）
	assert.equal(ipc.requests.length, 0);
});

test('_forceClose 后调 close() 不重复 emit 也不发 IPC', async () => {
	const ipc = createMockIpc();
	const dc = createOpenDc(ipc);

	const events = [];
	dc.on('close', () => events.push('close'));

	dc._forceClose();
	assert.equal(events.length, 1);

	// close() 应因 _closed 守卫直接 return
	await dc.close();
	assert.equal(events.length, 1); // 不重复 emit
	// 不应发 dc.close IPC
	assert.ok(!ipc.requests.some((r) => r.method === 'dc.close'));
});

test('close() drain 期间 _forceClose 触发后 close() 静默退出', async () => {
	const ipc = createMockIpc();
	// 模拟慢 IPC，使 drain 停留
	let sendResolve;
	ipc.request = (method) => {
		if (method === 'dc.send') {
			return new Promise((resolve) => { sendResolve = resolve; });
		}
		return Promise.resolve({ header: {}, payload: Buffer.alloc(0) });
	};

	const dc = createOpenDc(ipc);
	dc.send('data');

	// 启动 close()，它会进入 drain 等待
	const closePromise = dc.close();
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(dc.readyState, 'closing');

	// 模拟 IPC 崩溃——先 reject send，再 forceClose
	sendResolve({ header: {}, payload: Buffer.alloc(0) });
	dc._forceClose();

	// close() 应静默完成
	await closePromise;
	assert.equal(dc.readyState, 'closed');
});
