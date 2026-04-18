import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveBinary } from '../src/binary.js';

test('PION_IPC_BIN env returns path', () => {
	const orig = process.env.PION_IPC_BIN;
	try {
		process.env.PION_IPC_BIN = process.execPath;
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

test('platform package found resolves binary path', () => {
	const orig = process.env.PION_IPC_BIN;
	try {
		delete process.env.PION_IPC_BIN;

		// 创建临时目录模拟平台包
		const tmpDir = mkdtempSync(join(tmpdir(), 'pion-bin-test-'));
		const binDir = join(tmpDir, 'bin');
		mkdirSync(binDir);
		const binName = process.platform === 'win32' ? 'pion-ipc.exe' : 'pion-ipc';
		const binPath = join(binDir, binName);
		writeFileSync(binPath, '');
		writeFileSync(join(tmpDir, 'package.json'), '{}');

		// 自定义 resolve：返回模拟的 package.json 路径
		const fakeResolve = (specifier) => {
			if (specifier.endsWith('/package.json')) return join(tmpDir, 'package.json');
			throw new Error('not found');
		};

		const result = resolveBinary(fakeResolve);
		assert.equal(result, binPath);
	} finally {
		if (orig !== undefined) {
			process.env.PION_IPC_BIN = orig;
		} else {
			delete process.env.PION_IPC_BIN;
		}
	}
});

test('platform package installed but binary missing falls through to PATH', () => {
	const orig = process.env.PION_IPC_BIN;
	const origPath = process.env.PATH;
	try {
		delete process.env.PION_IPC_BIN;

		// 平台包存在但没有 binary
		const tmpDir = mkdtempSync(join(tmpdir(), 'pion-bin-test-'));
		writeFileSync(join(tmpDir, 'package.json'), '{}');
		const fakeResolve = (specifier) => {
			if (specifier.endsWith('/package.json')) return join(tmpDir, 'package.json');
			throw new Error('not found');
		};

		// PATH 也设为空，应抛出
		process.env.PATH = '/tmp/empty-path-for-test';
		assert.throws(
			() => resolveBinary(fakeResolve),
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

test('platform package not installed falls through to PATH', () => {
	const orig = process.env.PION_IPC_BIN;
	const origPath = process.env.PATH;
	try {
		delete process.env.PION_IPC_BIN;

		// resolve 抛异常 = 包未安装
		const fakeResolve = () => { throw new Error('MODULE_NOT_FOUND'); };

		process.env.PATH = '/tmp/empty-path-for-test';
		assert.throws(
			() => resolveBinary(fakeResolve),
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

test('no env and not in PATH throws', () => {
	const orig = process.env.PION_IPC_BIN;
	const origPath = process.env.PATH;
	try {
		delete process.env.PION_IPC_BIN;
		process.env.PATH = '/tmp/empty-path-for-test';
		// 必须同时 mock require.resolve 模拟"平台包未安装"，否则本地 pnpm install
		// 拉到 @coclaw/pion-ipc-<platform> 会让 resolveBinary 直接从 node_modules 找到二进制。
		const fakeResolve = () => { throw new Error('MODULE_NOT_FOUND'); };
		assert.throws(
			() => resolveBinary(fakeResolve),
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

test('PATH lookup finds binary', () => {
	const orig = process.env.PION_IPC_BIN;
	const origPath = process.env.PATH;
	try {
		delete process.env.PION_IPC_BIN;

		// 包未安装
		const fakeResolve = () => { throw new Error('MODULE_NOT_FOUND'); };

		// 在临时目录放一个假 binary
		const tmpDir = mkdtempSync(join(tmpdir(), 'pion-path-test-'));
		const binName = process.platform === 'win32' ? 'pion-ipc.exe' : 'pion-ipc';
		writeFileSync(join(tmpDir, binName), '');
		process.env.PATH = tmpDir;

		const result = resolveBinary(fakeResolve);
		assert.equal(result, join(tmpDir, binName));
	} finally {
		if (orig !== undefined) {
			process.env.PION_IPC_BIN = orig;
		} else {
			delete process.env.PION_IPC_BIN;
		}
		process.env.PATH = origPath;
	}
});

test('PATH lookup skips empty entries', () => {
	const orig = process.env.PION_IPC_BIN;
	const origPath = process.env.PATH;
	try {
		delete process.env.PION_IPC_BIN;
		const fakeResolve = () => { throw new Error('MODULE_NOT_FOUND'); };

		// Put a valid dir after empty entries
		const tmpDir = mkdtempSync(join(tmpdir(), 'pion-path-test-'));
		const binName = process.platform === 'win32' ? 'pion-ipc.exe' : 'pion-ipc';
		writeFileSync(join(tmpDir, binName), '');
		const sep = process.platform === 'win32' ? ';' : ':';
		// PATH with leading empty entries
		process.env.PATH = `${sep}${sep}${tmpDir}`;

		const result = resolveBinary(fakeResolve);
		assert.equal(result, join(tmpDir, binName));
	} finally {
		if (orig !== undefined) {
			process.env.PION_IPC_BIN = orig;
		} else {
			delete process.env.PION_IPC_BIN;
		}
		process.env.PATH = origPath;
	}
});
