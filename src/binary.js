import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const PLATFORM_PACKAGES = {
	'linux-x64': '@coclaw/pion-ipc-linux-x64',
	'linux-arm64': '@coclaw/pion-ipc-linux-arm64',
	'linux-arm': '@coclaw/pion-ipc-linux-arm',
	'darwin-x64': '@coclaw/pion-ipc-darwin-x64',
	'darwin-arm64': '@coclaw/pion-ipc-darwin-arm64',
	'win32-x64': '@coclaw/pion-ipc-win32-x64',
};

/**
 * Resolve the pion-ipc binary path.
 * Priority: 1) PION_IPC_BIN env  2) npm platform package  3) PATH lookup
 * @param {Function} [resolve] - Custom require.resolve (for testing)
 * @returns {string} Absolute path to the binary
 */
function resolveBinary(resolve) {
	// 1. 环境变量
	const envBin = process.env.PION_IPC_BIN;
	if (envBin) {
		if (!existsSync(envBin)) {
			throw new Error(`PION_IPC_BIN points to non-existent file: ${envBin}`);
		}
		return envBin;
	}

	// 2. npm 平台包
	const platformKey = `${process.platform}-${process.arch}`;
	const pkgName = PLATFORM_PACKAGES[platformKey];
	if (pkgName) {
		try {
			const resolveFn = resolve || createRequire(import.meta.url).resolve;
			const pkgJson = resolveFn(`${pkgName}/package.json`);
			const pkgDir = join(pkgJson, '..');
			const binName = process.platform === 'win32' ? 'pion-ipc.exe' : 'pion-ipc';
			const binPath = join(pkgDir, 'bin', binName);
			if (existsSync(binPath)) return binPath;
		} catch {
			// 包未安装，继续
		}
	}

	// 3. PATH 查找
	const isWin = process.platform === 'win32';
	const pathDirs = (process.env.PATH || '').split(isWin ? ';' : ':');
	const names = isWin
		? ['pion-ipc.exe', 'pion-ipc.cmd', 'pion-ipc.bat', 'pion-ipc']
		: ['pion-ipc'];

	for (const dir of pathDirs) {
		if (!dir) continue;
		for (const name of names) {
			const fullPath = join(dir, name);
			if (existsSync(fullPath)) return fullPath;
		}
	}

	throw new Error(
		'pion-ipc binary not found. Install @coclaw/pion-node (includes platform binary), set PION_IPC_BIN, or add pion-ipc to PATH.'
	);
}

export { resolveBinary };
