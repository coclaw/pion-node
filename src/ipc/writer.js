import { encodeFrame } from './protocol.js';

/**
 * Writes length-prefixed IPC frames to a writable stream.
 * Node.js stream.write is internally queued, so no extra mutex needed.
 */
class FrameWriter {
	constructor(stream) {
		this._stream = stream;
	}

	/**
	 * Write a frame to the stream.
	 * @param {object} header - Message header
	 * @param {Buffer|Uint8Array} [payload] - Raw payload bytes
	 */
	write(header, payload) {
		const frameBytes = encodeFrame(header, payload);
		this._stream.write(frameBytes);
	}
}

export { FrameWriter };
