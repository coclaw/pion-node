import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { writeFileSync, chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PionIpc } from '../src/pion-ipc.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_SCRIPT = join(__dirname, 'helpers', 'fake-pion-ipc.js');

function createFakeBin(mode = 'normal') {
	const tmp = mkdtempSync(join(tmpdir(), 'pion-test-'));
	const script = join(tmp, 'pion-ipc');
	// Embed mode directly in the wrapper script so the child process sees it
	writeFileSync(script, `#!/bin/sh\nexport FAKE_PION_MODE="${mode}"\nexec "${process.execPath}" "${FAKE_SCRIPT}"\n`);
	chmodSync(script, 0o755);
	return script;
}

function createIpc(mode = 'normal', opts = {}) {
	const binPath = createFakeBin(mode);
	const logs = [];
	const ipc = new PionIpc({
		binPath,
		timeout: opts.timeout || 5000,
		logger: (msg) => logs.push(msg),
		autoRestart: opts.autoRestart || false,
		maxBackoffMs: opts.maxBackoffMs,
		restartResetWindowMs: opts.restartResetWindowMs,
	});
	return { ipc, logs };
}

test('start() spawns process and completes ping handshake', async () => {
	const { ipc, logs } = createIpc('normal');

	await ipc.start();

	assert.equal(ipc.started, true);
	assert.ok(logs.some((m) => /spawning/.test(m)));
	assert.ok(logs.some((m) => /pion-ipc ready/.test(m)));

	await ipc.stop();
	assert.equal(ipc.started, false);
});

test('start() logs stderr from child process', async () => {
	const { ipc, logs } = createIpc('stderr');

	await ipc.start();

	// Give stderr time to arrive
	await new Promise((r) => setTimeout(r, 100));
	assert.ok(logs.some((m) => /\[stderr\]/.test(m) && /fake stderr/.test(m)),
		`expected stderr log, got: ${JSON.stringify(logs)}`);

	await ipc.stop();
});

test('start() rejects when ping fails (error response)', async () => {
	const { ipc } = createIpc('error-response');

	await assert.rejects(
		() => ipc.start(),
		/fake error/,
	);

	assert.equal(ipc.started, false);
});

test('start() sets _intentionalStop correctly around ping', async () => {
	const { ipc } = createIpc('normal');

	await ipc.start();

	assert.equal(ipc._intentionalStop, false);

	await ipc.stop();
});

test('double start() throws', async () => {
	const { ipc } = createIpc('normal');

	await ipc.start();

	await assert.rejects(
		() => ipc.start(),
		/already started/,
	);

	await ipc.stop();
});

test('start() schedules reset timer when autoRestart is enabled', async () => {
	const { ipc } = createIpc('normal', { autoRestart: true, restartResetWindowMs: 60000 });

	await ipc.start();

	assert.ok(ipc._resetTimer !== null, 'reset timer should be scheduled');

	await ipc.stop();
});

test('request after successful start works', async () => {
	const { ipc } = createIpc('normal');

	await ipc.start();

	const res = await ipc.request('ping');
	assert.equal(res.header.ok, true);

	await ipc.stop();
});

test('watchdog: crash-after-ping triggers exit event and restart', async () => {
	const { ipc, logs } = createIpc('crash-after-ping', {
		autoRestart: true,
		maxBackoffMs: 50,
	});

	const exitEvents = [];
	ipc.on('exit', (code) => exitEvents.push(code));

	await ipc.start();

	// Wait for the crash (happens ~20ms after ping) + restart attempt
	await new Promise((r) => setTimeout(r, 400));

	assert.ok(exitEvents.length >= 1, `should have received at least one exit event, got ${exitEvents.length}`);
	assert.ok(logs.some((m) => /process exited/.test(m)));

	await ipc.stop();
});
