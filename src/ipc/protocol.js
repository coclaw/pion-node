import { encode, decode } from '@msgpack/msgpack';

const LENGTH_PREFIX_SIZE = 4;
const HEADER_LEN_SIZE = 2;
const MAX_FRAME_SIZE = 16 * 1024 * 1024;

/**
 * Encode a frame into wire format.
 * @param {object} header - Message header (type, id, method, etc.)
 * @param {Buffer|Uint8Array} [payload] - Raw payload bytes
 * @returns {Buffer} Complete frame bytes
 */
function encodeFrame(header, payload = Buffer.alloc(0)) {
	const headerBytes = encode(header);

	if (headerBytes.length > 0xFFFF) {
		throw new Error(`header too large: ${headerBytes.length} bytes`);
	}

	const totalLen = HEADER_LEN_SIZE + headerBytes.length + payload.length;
	if (totalLen > MAX_FRAME_SIZE) {
		throw new Error(`frame too large: ${totalLen} > ${MAX_FRAME_SIZE}`);
	}

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

/**
 * Decode a frame body (without the 4-byte length prefix).
 * @param {Buffer} data - Frame body bytes
 * @returns {{ header: object, payload: Buffer }}
 */
function decodeFrame(data) {
	if (data.length < HEADER_LEN_SIZE) {
		throw new Error(`frame too short: ${data.length} bytes`);
	}

	const headerLen = data.readUInt16LE(0);
	if (HEADER_LEN_SIZE + headerLen > data.length) {
		throw new Error(`header length ${headerLen} exceeds frame size ${data.length}`);
	}

	const header = decode(data.subarray(HEADER_LEN_SIZE, HEADER_LEN_SIZE + headerLen));
	const payload = data.subarray(HEADER_LEN_SIZE + headerLen);

	return { header, payload };
}

export {
	encodeFrame,
	decodeFrame,
	LENGTH_PREFIX_SIZE,
	HEADER_LEN_SIZE,
	MAX_FRAME_SIZE,
};
