#!/usr/bin/env node
/**
 * Fake pion-ipc binary for testing PionIpc.start() internals.
 * Reads IPC frames from stdin, responds to 'ping' with ok=true.
 * Behavior is controlled by the FAKE_PION_MODE env var:
 *   - "normal" (default): responds to ping, stays alive until stdin closes
 *   - "stderr": writes to stderr, then responds to ping
 *   - "crash-after-ping": responds to ping, then exits with code 1
 *   - "no-response": never responds (for timeout testing)
 *   - "error-response": responds with ok=false
 */
import { encode, decode } from '@msgpack/msgpack';

const LENGTH_PREFIX_SIZE = 4;
const HEADER_LEN_SIZE = 2;

function encodeFrame(header, payload = Buffer.alloc(0)) {
	const headerBytes = encode(header);
	const totalLen = HEADER_LEN_SIZE + headerBytes.length + payload.length;
	const buf = Buffer.alloc(LENGTH_PREFIX_SIZE + totalLen);
	buf.writeUInt32LE(totalLen, 0);
	buf.writeUInt16LE(headerBytes.length, LENGTH_PREFIX_SIZE);
	Buffer.from(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength)
		.copy(buf, LENGTH_PREFIX_SIZE + HEADER_LEN_SIZE);
	if (payload.length > 0) {
		const src = Buffer.isBuffer(payload)
			? payload
			: Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
		src.copy(buf, LENGTH_PREFIX_SIZE + HEADER_LEN_SIZE + headerBytes.length);
	}
	return buf;
}

function decodeFrameFromBuf(data) {
	const headerLen = data.readUInt16LE(0);
	const header = decode(data.subarray(HEADER_LEN_SIZE, HEADER_LEN_SIZE + headerLen));
	const payload = data.subarray(HEADER_LEN_SIZE + headerLen);
	return { header, payload };
}

const mode = process.env.FAKE_PION_MODE || 'normal';

if (mode === 'stderr') {
	process.stderr.write('fake stderr output\n');
}

let buffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	while (buffer.length >= 4) {
		const totalLen = buffer.readUInt32LE(0);
		if (buffer.length < 4 + totalLen) return;
		const frameData = buffer.subarray(4, 4 + totalLen);
		buffer = buffer.subarray(4 + totalLen);

		const { header } = decodeFrameFromBuf(frameData);

		if (mode === 'no-response') return;

		if (header.method === 'ping') {
			if (mode === 'error-response') {
				process.stdout.write(encodeFrame({ type: 'res', id: header.id, ok: false, error: 'fake error' }));
			} else {
				process.stdout.write(encodeFrame({ type: 'res', id: header.id, ok: true }));
			}

			if (mode === 'crash-after-ping') {
				setTimeout(() => process.exit(1), 20);
			}
		} else {
			// Echo back ok for any other request
			process.stdout.write(encodeFrame({ type: 'res', id: header.id, ok: true }));
		}
	}
});

process.stdin.on('end', () => {
	process.exit(0);
});
