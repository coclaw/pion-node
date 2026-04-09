import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Resolve the pion-ipc binary path.
 * Priority: 1) PION_IPC_BIN env var  2) PATH lookup
 * @returns {string} Absolute path to the binary
 */
function resolveBinary() {
	// 1. Environment variable
	const envBin = process.env.PION_IPC_BIN;
	if (envBin) {
		if (!existsSync(envBin)) {
			throw new Error(`PION_IPC_BIN points to non-existent file: ${envBin}`);
		}
		return envBin;
	}

	// 2. PATH lookup (cross-platform, no child process)
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
		'pion-ipc binary not found. Set PION_IPC_BIN or add pion-ipc to PATH.'
	);
}

export { resolveBinary };
