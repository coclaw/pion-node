import { EventEmitter } from 'node:events';

/**
 * W3C-compatible RTCDataChannel wrapper over pion-ipc IPC.
 * Events: 'open', 'close', 'message', 'error', 'bufferedamountlow'
 */
class RTCDataChannel extends EventEmitter {
	/**
	 * @param {object} config
	 * @param {import('./pion-ipc.js').PionIpc} config._ipc - PionIpc instance
	 * @param {string} config._pcId - PeerConnection ID
	 * @param {string} config._label - DataChannel label
	 * @param {boolean} [config._ordered=true] - Ordered delivery
	 * @param {boolean} [config._remote=false] - True if created by remote peer
	 */
	constructor(config = {}) {
		super();
		this._ipc = config._ipc;
		this._pcId = config._pcId;
		this._label = config._label;
		this._ordered = config._ordered !== false;
		this._remote = !!config._remote;
		this._readyState = 'connecting';
		this._bufferedAmount = 0;
		this._bufferedAmountLowThreshold = 0;
		this._sendQueue = [];
		this._draining = false;

		this._onDcOpen = (evt) => {
			if (evt.pcId === this._pcId && evt.dcLabel === this._label) {
				this._readyState = 'open';
				this.emit('open');
			}
		};
		this._onDcClose = (evt) => {
			if (evt.pcId === this._pcId && evt.dcLabel === this._label) {
				this._readyState = 'closed';
				this.emit('close');
			}
		};
		this._onDcMessage = (evt) => {
			if (evt.pcId === this._pcId && evt.dcLabel === this._label) {
				this.emit('message', {
					data: evt.isBinary ? evt.payload : evt.payload.toString('utf8'),
				});
			}
		};
		this._onDcError = (evt) => {
			if (evt.pcId === this._pcId && evt.dcLabel === this._label) {
				this.emit('error', new Error(evt.payload?.toString('utf8') || 'unknown error'));
			}
		};
		this._onDcBal = (evt) => {
			if (evt.pcId === this._pcId && evt.dcLabel === this._label) {
				this.emit('bufferedamountlow');
			}
		};

		this._ipc.on('dc.open', this._onDcOpen);
		this._ipc.on('dc.close', this._onDcClose);
		this._ipc.on('dc.message', this._onDcMessage);
		this._ipc.on('dc.error', this._onDcError);
		this._ipc.on('dc.bufferedamountlow', this._onDcBal);

		// on* property handlers
		this._defineOnProperty('onopen');
		this._defineOnProperty('onclose');
		this._defineOnProperty('onmessage');
		this._defineOnProperty('onerror');
		this._defineOnProperty('onbufferedamountlow');
	}

	_defineOnProperty(name) {
		let handler = null;
		Object.defineProperty(this, name, {
			get: () => handler,
			set: (fn) => {
				if (handler) this.off(name.slice(2), handler);
				handler = fn;
				if (fn) this.on(name.slice(2), fn);
			},
			configurable: true,
		});
	}

	get label() {
		return this._label;
	}

	get ordered() {
		return this._ordered;
	}

	get readyState() {
		return this._readyState;
	}

	get bufferedAmount() {
		return this._bufferedAmount;
	}

	get bufferedAmountLowThreshold() {
		return this._bufferedAmountLowThreshold;
	}

	set bufferedAmountLowThreshold(value) {
		this._bufferedAmountLowThreshold = value;
		// Async notify Go side
		this._ipc.request('dc.setBALT', {
			pcId: this._pcId,
			dcLabel: this._label,
		}, { threshold: value }).catch((err) => {
			this.emit('error', err);
		});
	}

	/**
	 * Send data through the DataChannel (synchronous, W3C-compatible).
	 * @param {string|Buffer|Uint8Array} data
	 */
	send(data) {
		if (this._readyState !== 'open') {
			throw new Error('InvalidStateError: not open');
		}

		const isBinary = Buffer.isBuffer(data) || (data instanceof Uint8Array);
		const payload = isBinary ? Buffer.from(data) : Buffer.from(String(data), 'utf8');

		this._bufferedAmount += payload.length;
		this._sendQueue.push({ isBinary, payload });
		this._drainQueue();
	}

	/**
	 * Internal: process the send queue asynchronously.
	 */
	_drainQueue() {
		if (this._draining) return;
		this._draining = true;

		const drain = async () => {
			while (this._sendQueue.length > 0) {
				const { isBinary, payload } = this._sendQueue.shift();
				try {
					await this._ipc.request('dc.send', {
						pcId: this._pcId,
						dcLabel: this._label,
						isBinary,
					}, payload);
				} catch (err) {
					this.emit('error', err);
				}
				const prevAmount = this._bufferedAmount;
				this._bufferedAmount = Math.max(0, this._bufferedAmount - payload.length);

				// Only emit when crossing threshold (from above to at-or-below)
				if (prevAmount > this._bufferedAmountLowThreshold
					&& this._bufferedAmount <= this._bufferedAmountLowThreshold) {
					this.emit('bufferedamountlow');
				}
			}
			this._draining = false;

			// Check for messages queued during drain
			if (this._sendQueue.length > 0) {
				this._drainQueue();
			}
		};

		drain().catch((err) => this.emit('error', err));
	}

	/**
	 * Initialize the DataChannel on the Go side (local channels only).
	 * Called internally by RTCPeerConnection.createDataChannel().
	 */
	async _init() {
		await this._ipc.request('dc.create', { pcId: this._pcId }, {
			label: this._label,
			ordered: this._ordered,
		});
	}

	/**
	 * Close this DataChannel.
	 */
	async close() {
		this._detach();
		this._readyState = 'closed';
		await this._ipc.request('dc.close', {
			pcId: this._pcId,
			dcLabel: this._label,
		});
	}

	/**
	 * Remove all IPC event listeners for this channel.
	 */
	_detach() {
		this._ipc.off('dc.open', this._onDcOpen);
		this._ipc.off('dc.close', this._onDcClose);
		this._ipc.off('dc.message', this._onDcMessage);
		this._ipc.off('dc.error', this._onDcError);
		this._ipc.off('dc.bufferedamountlow', this._onDcBal);
	}
}

export { RTCDataChannel };
// Backward-compatible alias
export { RTCDataChannel as DataChannel };
