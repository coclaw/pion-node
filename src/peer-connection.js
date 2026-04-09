import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { decode } from '@msgpack/msgpack';
import { RTCDataChannel } from './data-channel.js';

/**
 * W3C-compatible RTCPeerConnection wrapper over pion-ipc IPC.
 * Events: 'icecandidate', 'connectionstatechange', 'iceconnectionstatechange',
 *         'selectedcandidatepairchange', 'icegatheringstatechange', 'signalingstatechange', 'datachannel'
 */
class RTCPeerConnection extends EventEmitter {
	/**
	 * @param {object} [config]
	 * @param {object[]} [config.iceServers] - ICE server configurations
	 * @param {import('./pion-ipc.js').PionIpc} [config._ipc] - PionIpc instance (pion-node extension)
	 * @param {string} [config._pcId] - PeerConnection ID (pion-node extension, defaults to UUID)
	 */
	constructor(config = {}) {
		super();
		this._ipc = config._ipc;
		this._pcId = config._pcId || randomUUID();
		this._iceServers = config.iceServers || [];
		this._dataChannels = new Set();
		this._connState = 'new';
		this._iceState = 'new';
		this._selectedCandidatePair = null;
		this._iceGatheringState = 'new';
		this._signalingState = 'stable';

		// Deferred init: starts IPC pc.create, methods await this before proceeding
		if (this._ipc) {
			this._ready = this._ipc.request('pc.create', {}, {
				pcId: this._pcId,
				iceServers: this._iceServers,
			}).catch((err) => {
				this._initError = err;
				throw err;
			});
		} else {
			const err = new Error('_ipc is required');
			this._initError = err;
			this._ready = Promise.reject(err);
		}
		// Prevent unhandled rejection if _ready is never awaited
		this._ready.catch(() => {});

		this._onIceCandidate = (evt) => {
			if (evt.pcId !== this._pcId) return;
			const candidate = decode(evt.payload);
			this.emit('icecandidate', {
				candidate: {
					candidate: candidate.candidate,
					sdpMid: candidate.sdpMid,
					sdpMLineIndex: candidate.sdpMLineIndex,
				},
			});
		};

		this._onStateChange = (evt) => {
			if (evt.pcId !== this._pcId) return;
			const state = decode(evt.payload);
			const prevConn = this._connState;
			const prevIce = this._iceState;
			this._connState = state.connState;
			this._iceState = state.iceState;
			if (state.connState !== prevConn) {
				this.emit('connectionstatechange');
			}
			if (state.iceState !== prevIce) {
				this.emit('iceconnectionstatechange');
			}
		};

		this._onDataChannel = (evt) => {
			if (evt.pcId !== this._pcId) return;
			const info = decode(evt.payload);
			const dc = new RTCDataChannel({
				_ipc: this._ipc,
				_pcId: this._pcId,
				_label: evt.dcLabel,
				_ordered: info.ordered !== false,
				_remote: true,
			});
			this._dataChannels.add(dc);
			this.emit('datachannel', { channel: dc });
		};

		this._onSelectedCandidatePairChange = (evt) => {
			if (evt.pcId !== this._pcId) return;
			const pair = decode(evt.payload);
			this._selectedCandidatePair = { local: pair.local, remote: pair.remote };
			this.emit('selectedcandidatepairchange');
		};

		this._onIceGatheringStateChange = (evt) => {
			if (evt.pcId !== this._pcId) return;
			const data = decode(evt.payload);
			this._iceGatheringState = data.state;
			this.emit('icegatheringstatechange');
		};

		this._onSignalingStateChange = (evt) => {
			if (evt.pcId !== this._pcId) return;
			const data = decode(evt.payload);
			this._signalingState = data.state;
			this.emit('signalingstatechange');
		};

		if (this._ipc) {
			this._ipc.on('pc.icecandidate', this._onIceCandidate);
			this._ipc.on('pc.statechange', this._onStateChange);
			this._ipc.on('pc.datachannel', this._onDataChannel);
			this._ipc.on('pc.selectedcandidatepairchange', this._onSelectedCandidatePairChange);
			this._ipc.on('pc.icegatheringstatechange', this._onIceGatheringStateChange);
			this._ipc.on('pc.signalingstatechange', this._onSignalingStateChange);
		}

		// on* property handlers
		this._defineOnProperty('onicecandidate');
		this._defineOnProperty('onconnectionstatechange');
		this._defineOnProperty('oniceconnectionstatechange');
		this._defineOnProperty('ondatachannel');
		this._defineOnProperty('onselectedcandidatepairchange');
		this._defineOnProperty('onicegatheringstatechange');
		this._defineOnProperty('onsignalingstatechange');
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

	get connectionState() {
		return this._connState;
	}

	get iceConnectionState() {
		return this._iceState;
	}

	get selectedCandidatePair() {
		return this._selectedCandidatePair;
	}

	get iceGatheringState() {
		return this._iceGatheringState;
	}

	get signalingState() {
		return this._signalingState;
	}

	/**
	 * Create an SDP offer.
	 * @returns {Promise<{ type: string, sdp: string }>}
	 */
	async createOffer() {
		await this._ready;
		const { payload } = await this._ipc.request('pc.createOffer', { pcId: this._pcId });
		const result = decode(payload);
		return { type: 'offer', sdp: result.sdp };
	}

	/**
	 * Create an SDP answer.
	 * @returns {Promise<{ type: string, sdp: string }>}
	 */
	async createAnswer() {
		await this._ready;
		const { payload } = await this._ipc.request('pc.createAnswer', { pcId: this._pcId });
		const result = decode(payload);
		return { type: 'answer', sdp: result.sdp };
	}

	/**
	 * Set the remote SDP description.
	 * @param {{ type: string, sdp: string }} desc
	 */
	async setRemoteDescription(desc) {
		await this._ready;
		await this._ipc.request('pc.setRemoteDescription', { pcId: this._pcId }, {
			type: desc.type,
			sdp: desc.sdp,
		});
	}

	/**
	 * Set the local SDP description.
	 * @param {{ type: string, sdp: string }} desc
	 */
	async setLocalDescription(desc) {
		await this._ready;
		await this._ipc.request('pc.setLocalDescription', { pcId: this._pcId }, {
			type: desc.type,
			sdp: desc.sdp,
		});
	}

	/**
	 * Add a remote ICE candidate.
	 * @param {{ candidate: string, sdpMid: string, sdpMLineIndex: number }} candidate
	 */
	async addIceCandidate(candidate) {
		await this._ready;
		await this._ipc.request('pc.addIceCandidate', { pcId: this._pcId }, {
			candidate: candidate.candidate,
			sdpMid: candidate.sdpMid,
			sdpMLineIndex: candidate.sdpMLineIndex,
		});
	}

	/**
	 * Trigger ICE restart and return the new offer.
	 * @returns {Promise<{ type: string, sdp: string }>}
	 */
	async restartIce() {
		await this._ready;
		const { payload } = await this._ipc.request('pc.restartIce', { pcId: this._pcId });
		const result = decode(payload);
		return { type: 'offer', sdp: result.sdp };
	}

	/**
	 * Create a new DataChannel (synchronous, W3C-compatible).
	 * @param {string} label
	 * @param {object} [opts]
	 * @param {boolean} [opts.ordered=true]
	 * @returns {RTCDataChannel}
	 */
	createDataChannel(label, opts = {}) {
		const dc = new RTCDataChannel({
			_ipc: this._ipc,
			_pcId: this._pcId,
			_label: label,
			_ordered: opts.ordered !== false,
			_remote: false,
		});
		this._dataChannels.add(dc);
		// Async init: send dc.create IPC after pc is ready
		this._ready
			.then(() => dc._init())
			.catch((err) => {
				dc._closed = true;
				dc._readyState = 'closed';
				if (dc.listenerCount('error') > 0) {
					dc.emit('error', err);
				}
				dc.emit('close');
			});
		return dc;
	}

	/**
	 * Close this PeerConnection.
	 */
	async close() {
		for (const dc of this._dataChannels) {
			dc._closed = true;
			dc._sendQueue.length = 0;
			dc._bufferedAmount = 0;
			dc._detach();
			dc._readyState = 'closed';
			dc.emit('close');
		}
		this._dataChannels.clear();
		this._detach();
		if (this._connState !== 'closed') {
			this._connState = 'closed';
			this.emit('connectionstatechange');
		}
		if (!this._ipc) return;
		await this._ready.catch(() => {});
		if (this._initError) return; // pc.create failed, nothing to close on Go side
		await this._ipc.request('pc.close', { pcId: this._pcId });
	}

	_detach() {
		if (!this._ipc) return;
		this._ipc.off('pc.icecandidate', this._onIceCandidate);
		this._ipc.off('pc.statechange', this._onStateChange);
		this._ipc.off('pc.datachannel', this._onDataChannel);
		this._ipc.off('pc.selectedcandidatepairchange', this._onSelectedCandidatePairChange);
		this._ipc.off('pc.icegatheringstatechange', this._onIceGatheringStateChange);
		this._ipc.off('pc.signalingstatechange', this._onSignalingStateChange);
	}
}

export { RTCPeerConnection };
// Backward-compatible alias
export { RTCPeerConnection as PeerConnection };
