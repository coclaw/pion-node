import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBinary } from '../src/binary.js';

test('PION_IPC_BIN env returns path', () => {
	const orig = process.env.PION_IPC_BIN;
	try {
		// 指向一个确定存在的文件
		process.env.PION_IPC_BIN = process.execPath; // node binary 自身
		const result = resolveBinary();
		assert.equal(result, process.execPath);
	} finally {
		if (orig !== undefined) {
			process.env.PION_IPC_BIN = orig;
		} else {
			delete process.env.PION_IPC_BIN;
		}
	}
});

test('PION_IPC_BIN env pointing to non-existent file throws', () => {
	const orig = process.env.PION_IPC_BIN;
	try {
		process.env.PION_IPC_BIN = '/tmp/definitely-does-not-exist-pion-ipc-xyz';
		assert.throws(
			() => resolveBinary(),
			/non-existent file/
		);
	} finally {
		if (orig !== undefined) {
			process.env.PION_IPC_BIN = orig;
		} else {
			delete process.env.PION_IPC_BIN;
		}
	}
});

test('no env and not in PATH throws', () => {
	const orig = process.env.PION_IPC_BIN;
	const origPath = process.env.PATH;
	try {
		delete process.env.PION_IPC_BIN;
		// 设置 PATH 为空目录，确保 which pion-ipc 失败
		process.env.PATH = '/tmp/empty-path-for-test';
		assert.throws(
			() => resolveBinary(),
			/pion-ipc binary not found/
		);
	} finally {
		if (orig !== undefined) {
			process.env.PION_IPC_BIN = orig;
		} else {
			delete process.env.PION_IPC_BIN;
		}
		process.env.PATH = origPath;
	}
});
