import { EventEmitter } from 'node:events';
import { decode } from '@msgpack/msgpack';

/**
 * W3C-style DataChannel wrapper over pion-ipc IPC.
 * Events: 'open', 'close', 'message', 'error', 'bufferedamountlow'
 */
class DataChannel extends EventEmitter {
	/**
	 * @param {import('./pion-ipc.js').PionIpc} ipc - PionIpc instance
	 * @param {string} pcId - PeerConnection ID
	 * @param {string} label - DataChannel label
	 */
	constructor(ipc, pcId, label) {
		super();
		this._ipc = ipc;
		this._pcId = pcId;
		this._label = label;

		this._onDcOpen = (evt) => {
			if (evt.pcId === pcId && evt.dcLabel === label) this.emit('open');
		};
		this._onDcClose = (evt) => {
			if (evt.pcId === pcId && evt.dcLabel === label) this.emit('close');
		};
		this._onDcMessage = (evt) => {
			if (evt.pcId === pcId && evt.dcLabel === label) {
				this.emit('message', {
					data: evt.isBinary ? evt.payload : evt.payload.toString('utf8'),
					isBinary: !!evt.isBinary,
				});
			}
		};
		this._onDcError = (evt) => {
			if (evt.pcId === pcId && evt.dcLabel === label) {
				this.emit('error', new Error(evt.payload?.toString('utf8') || 'unknown error'));
			}
		};
		this._onDcBal = (evt) => {
			if (evt.pcId === pcId && evt.dcLabel === label) {
				this.emit('bufferedamountlow');
			}
		};

		ipc.on('dc.open', this._onDcOpen);
		ipc.on('dc.close', this._onDcClose);
		ipc.on('dc.message', this._onDcMessage);
		ipc.on('dc.error', this._onDcError);
		ipc.on('dc.bufferedamountlow', this._onDcBal);
	}

	get label() {
		return this._label;
	}

	/**
	 * Send data through the DataChannel.
	 * @param {string|Buffer} data - Text string or binary buffer
	 */
	async send(data) {
		const isBinary = Buffer.isBuffer(data);
		const payload = isBinary ? data : Buffer.from(data, 'utf8');
		await this._ipc.request('dc.send', {
			pcId: this._pcId,
			dcLabel: this._label,
			isBinary,
		}, payload);
	}

	/**
	 * Close this DataChannel.
	 */
	async close() {
		this._detach();
		await this._ipc.request('dc.close', {
			pcId: this._pcId,
			dcLabel: this._label,
		});
	}

	/**
	 * Get the current buffered amount.
	 * @returns {Promise<number>}
	 */
	async getBufferedAmount() {
		const { payload } = await this._ipc.request('dc.getBA', {
			pcId: this._pcId,
			dcLabel: this._label,
		});
		const result = decode(payload);
		return result.bufferedAmount;
	}

	/**
	 * Set the buffered amount low threshold.
	 * @param {number} threshold
	 */
	async setBufferedAmountLowThreshold(threshold) {
		await this._ipc.request('dc.setBALT', {
			pcId: this._pcId,
			dcLabel: this._label,
		}, { threshold });
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

export { DataChannel };
