import { decodeFrame, MAX_FRAME_SIZE } from './protocol.js';

/**
 * Reads length-prefixed IPC frames from a readable stream.
 * Uses a chunk list to avoid unnecessary Buffer.concat on every data event.
 */
class FrameReader {
	constructor(stream) {
		this._stream = stream;
		this._chunks = [];
		this._totalLen = 0;
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
		this._chunks.push(chunk);
		this._totalLen += chunk.length;
		this._drain();
	}

	/** Merge chunks into a single buffer (only when needed for parsing). */
	_compact() {
		if (this._chunks.length > 1) {
			this._chunks = [Buffer.concat(this._chunks, this._totalLen)];
		}
	}

	_drain() {
		while (this._totalLen >= 4) {
			this._compact();
			const buf = this._chunks[0];
			const totalLen = buf.readUInt32LE(0);
			if (totalLen < 2) {
				this._onErrorCb?.(new Error(`frame size ${totalLen} too small (min 2)`));
				this._chunks = [];
				this._totalLen = 0;
				return;
			}
			if (totalLen > MAX_FRAME_SIZE) {
				this._onErrorCb?.(new Error(`frame size ${totalLen} exceeds max ${MAX_FRAME_SIZE}`));
				this._chunks = [];
				this._totalLen = 0;
				return;
			}
			if (this._totalLen < 4 + totalLen) return; // incomplete
			const frameData = buf.subarray(4, 4 + totalLen);
			const remaining = buf.subarray(4 + totalLen);
			if (remaining.length > 0) {
				this._chunks = [remaining];
			} else {
				this._chunks = [];
			}
			this._totalLen -= (4 + totalLen);
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
