import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { PionIpc } from '../src/pion-ipc.js';

const BIN_PATH = process.env.PION_IPC_BIN;
const hasBinary = BIN_PATH && existsSync(BIN_PATH);

test('start and ping', { skip: !hasBinary && 'PION_IPC_BIN not set or binary missing' }, async () => {
	const ipc = new PionIpc({ binPath: BIN_PATH });
	await ipc.start();
	assert.equal(ipc.started, true);

	// ping again explicitly
	const { header } = await ipc.request('ping');
	assert.equal(header.ok, true);

	await ipc.stop();
	assert.equal(ipc.started, false);
});

test('stop closes process', { skip: !hasBinary && 'PION_IPC_BIN not set or binary missing' }, async () => {
	const ipc = new PionIpc({ binPath: BIN_PATH });
	await ipc.start();

	const exitPromise = new Promise((resolve) => {
		ipc.on('exit', (code) => resolve(code));
	});

	await ipc.stop();
	const code = await exitPromise;
	// Go process should exit cleanly when stdin closes
	assert.equal(code, 0);
});

test('request after stop rejects', { skip: !hasBinary && 'PION_IPC_BIN not set or binary missing' }, async () => {
	const ipc = new PionIpc({ binPath: BIN_PATH });
	await ipc.start();
	await ipc.stop();

	await assert.rejects(
		() => ipc.request('ping'),
		/not started/
	);
});

test('unknown method returns error', { skip: !hasBinary && 'PION_IPC_BIN not set or binary missing' }, async () => {
	const ipc = new PionIpc({ binPath: BIN_PATH });
	await ipc.start();

	await assert.rejects(
		() => ipc.request('nonexistent.method'),
		/unknown method/
	);

	await ipc.stop();
});

test('double start throws', { skip: !hasBinary && 'PION_IPC_BIN not set or binary missing' }, async () => {
	const ipc = new PionIpc({ binPath: BIN_PATH });
	await ipc.start();

	await assert.rejects(
		() => ipc.start(),
		/already started/
	);

	await ipc.stop();
});
