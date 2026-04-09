import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

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

	// 2. PATH lookup
	try {
		const result = execSync('which pion-ipc', { encoding: 'utf8' }).trim();
		if (result) return result;
	} catch {
		// not found in PATH
	}

	throw new Error(
		'pion-ipc binary not found. Set PION_IPC_BIN or add pion-ipc to PATH.'
	);
}

export { resolveBinary };
