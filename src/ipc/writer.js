import { encodeFrame } from './protocol.js';

/**
 * Writes length-prefixed IPC frames to a writable stream.
 * Node.js stream.write is internally queued, so no extra mutex needed.
 */
class FrameWriter {
	constructor(stream) {
		this._stream = stream;
		this._error = null;
		stream.on('error', (err) => {
			this._error = err;
		});
	}

	/**
	 * Write a frame to the stream.
	 * @param {object} header - Message header
	 * @param {Buffer|Uint8Array} [payload] - Raw payload bytes
	 * @returns {boolean} stream.write return value
	 */
	write(header, payload) {
		if (this._error) throw this._error;
		const frameBytes = encodeFrame(header, payload);
		return this._stream.write(frameBytes);
	}
}

export { FrameWriter };
