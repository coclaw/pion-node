import { decodeFrame, MAX_FRAME_SIZE } from './protocol.js';

/**
 * Reads length-prefixed IPC frames from a readable stream.
 */
class FrameReader {
	constructor(stream) {
		this._stream = stream;
		this._buffer = Buffer.alloc(0);
		this._onFrameCb = null;
		this._onErrorCb = null;
		this._onEndCb = null;

		stream.on('data', (chunk) => this._onData(chunk));
		stream.on('end', () => this._onEndCb?.());
		stream.on('error', (err) => this._onErrorCb?.(err));
	}

	onFrame(cb) { this._onFrameCb = cb; }
	onError(cb) { this._onErrorCb = cb; }
	onEnd(cb) { this._onEndCb = cb; }

	_onData(chunk) {
		this._buffer = Buffer.concat([this._buffer, chunk]);
		this._drain();
	}

	_drain() {
		while (this._buffer.length >= 4) {
			const totalLen = this._buffer.readUInt32LE(0);
			if (totalLen > MAX_FRAME_SIZE) {
				this._onErrorCb?.(new Error(`frame size ${totalLen} exceeds max ${MAX_FRAME_SIZE}`));
				this._buffer = Buffer.alloc(0);
				return;
			}
			if (this._buffer.length < 4 + totalLen) return; // incomplete
			const frameData = this._buffer.subarray(4, 4 + totalLen);
			this._buffer = this._buffer.subarray(4 + totalLen);
			try {
				const { header, payload } = decodeFrame(frameData);
				this._onFrameCb?.(header, payload);
			} catch (err) {
				this._onErrorCb?.(err);
			}
		}
	}
}

export { FrameReader };
