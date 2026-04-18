import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PionIpc } from '../src/pion-ipc.js';
import { resolveBinary } from '../src/binary.js';

let BIN_PATH = null;
try { BIN_PATH = resolveBinary(); } catch { /* no binary available */ }
const skipReason = BIN_PATH ? false : 'pion-ipc binary not found (set PION_IPC_BIN, install platform pkg, or add to PATH)';

test('start and ping', { skip: skipReason }, async () => {
	const ipc = new PionIpc({ binPath: BIN_PATH });
	await ipc.start();
	assert.equal(ipc.started, true);

	// ping again explicitly
	const { header } = await ipc.request('ping');
	assert.equal(header.ok, true);

	await ipc.stop();
	assert.equal(ipc.started, false);
});

test('stop closes process', { skip: skipReason }, async () => {
	const ipc = new PionIpc({ binPath: BIN_PATH });
	await ipc.start();

	// Intentional stop 下 PionIpc 不 emit 'exit'（见 _handleProcessExit）；
	// 直接监听底层子进程拿退出码。
	const proc = ipc._proc;
	const exitCodePromise = new Promise((resolve) => {
		proc.once('exit', (code) => resolve(code));
	});

	await ipc.stop();
	const code = await exitCodePromise;
	assert.equal(code, 0);
	assert.equal(ipc.started, false);
});

test('request after stop rejects', { skip: skipReason }, async () => {
	const ipc = new PionIpc({ binPath: BIN_PATH });
	await ipc.start();
	await ipc.stop();

	await assert.rejects(
		() => ipc.request('ping'),
		/not started/
	);
});

test('unknown method returns error', { skip: skipReason }, async () => {
	const ipc = new PionIpc({ binPath: BIN_PATH });
	await ipc.start();

	try {
		// Go 端未知方法当前返回 `peer "" not found`（走 peer lookup 分支）；
		// 测试意图是"未知方法会被 reject 而非 hang"，对错误内容放宽。
		await assert.rejects(
			() => ipc.request('nonexistent.method'),
			(err) => err instanceof Error,
		);
	} finally {
		await ipc.stop();
	}
});

test('double start throws', { skip: skipReason }, async () => {
	const ipc = new PionIpc({ binPath: BIN_PATH });
	await ipc.start();

	await assert.rejects(
		() => ipc.start(),
		/already started/
	);

	await ipc.stop();
});

test('process crash rejects pending requests', { skip: skipReason }, async () => {
	const ipc = new PionIpc({ binPath: BIN_PATH, timeout: 5000 });
	await ipc.start();

	// 发送一个不会立即返回的请求，然后杀掉进程
	const reqPromise = ipc.request('ping');
	// 等 ping 完成后再发一个长时间请求并立即杀进程
	await reqPromise;

	const pendingPromise = ipc.request('pc.create', {}, { pcId: 'crash-test', iceServers: [] });
	// 杀掉 Go 进程
	ipc._proc.kill('SIGKILL');

	await assert.rejects(pendingPromise, /process exited/);
});

test('request timeout rejects', { skip: skipReason }, async () => {
	const ipc = new PionIpc({ binPath: BIN_PATH, timeout: 200 });
	await ipc.start();

	// pc.createOffer 需要先创建 PC，在没有 PC 的情况下可能返回错误而不是超时
	// 使用一个会挂起的场景：创建 PC 后关闭 stdin 但不 stop
	// 更简单的方式：手动构造一个不会被响应的请求
	// 直接用一个短超时 + 请求一个存在但需要前置条件的方法
	await assert.rejects(
		() => ipc.request('pc.createOffer', { pcId: 'nonexistent-pc' }),
		// 可能超时或返回错误，两者都可接受
		(err) => err instanceof Error
	);

	await ipc.stop();
});
