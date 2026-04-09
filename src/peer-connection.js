import { EventEmitter } from 'node:events';
import { decode } from '@msgpack/msgpack';
import { DataChannel } from './data-channel.js';

/**
 * W3C-style PeerConnection wrapper over pion-ipc IPC.
 * Events: 'icecandidate', 'connectionstatechange', 'datachannel'
 */
class PeerConnection extends EventEmitter {
	/**
	 * @param {import('./pion-ipc.js').PionIpc} ipc - PionIpc instance
	 * @param {string} pcId - Unique PeerConnection identifier
	 * @param {object[]} [iceServers] - ICE server configurations
	 */
	constructor(ipc, pcId, iceServers = []) {
		super();
		this._ipc = ipc;
		this._pcId = pcId;
		this._iceServers = iceServers;
		this._dataChannels = new Map();
		this._connState = 'new';
		this._iceState = '';

		this._onIceCandidate = (evt) => {
			if (evt.pcId !== pcId) return;
			const candidate = decode(evt.payload);
			this.emit('icecandidate', {
				candidate: candidate.candidate,
				sdpMid: candidate.sdpMid,
				sdpMLineIndex: candidate.sdpMLineIndex,
			});
		};

		this._onStateChange = (evt) => {
			if (evt.pcId !== pcId) return;
			const state = decode(evt.payload);
			this._connState = state.connState;
			this._iceState = state.iceState;
			this.emit('connectionstatechange', {
				connectionState: state.connState,
				iceConnectionState: state.iceState,
			});
		};

		this._onDataChannel = (evt) => {
			if (evt.pcId !== pcId) return;
			const info = decode(evt.payload);
			const dc = new DataChannel(ipc, pcId, evt.dcLabel);
			this._dataChannels.set(evt.dcLabel, dc);
			this.emit('datachannel', { channel: dc, ordered: info.ordered });
		};

		ipc.on('pc.icecandidate', this._onIceCandidate);
		ipc.on('pc.statechange', this._onStateChange);
		ipc.on('pc.datachannel', this._onDataChannel);
	}

	get connectionState() {
		return this._connState;
	}

	get iceConnectionState() {
		return this._iceState;
	}

	/**
	 * Initialize the peer connection on the Go side.
	 */
	async init() {
		await this._ipc.request('pc.create', {}, {
			pcId: this._pcId,
			iceServers: this._iceServers,
		});
	}

	/**
	 * Create an SDP offer.
	 * @returns {Promise<{ type: string, sdp: string }>}
	 */
	async createOffer() {
		const { payload } = await this._ipc.request('pc.createOffer', { pcId: this._pcId });
		const result = decode(payload);
		return { type: 'offer', sdp: result.sdp };
	}

	/**
	 * Create an SDP answer.
	 * @returns {Promise<{ type: string, sdp: string }>}
	 */
	async createAnswer() {
		const { payload } = await this._ipc.request('pc.createAnswer', { pcId: this._pcId });
		const result = decode(payload);
		return { type: 'answer', sdp: result.sdp };
	}

	/**
	 * Set the remote SDP description.
	 * @param {{ type: string, sdp: string }} desc
	 */
	async setRemoteDescription(desc) {
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
		const { payload } = await this._ipc.request('pc.restartIce', { pcId: this._pcId });
		const result = decode(payload);
		return { type: 'offer', sdp: result.sdp };
	}

	/**
	 * Create a new DataChannel.
	 * @param {string} label
	 * @param {object} [opts]
	 * @param {boolean} [opts.ordered=true]
	 * @returns {Promise<DataChannel>}
	 */
	async createDataChannel(label, opts = {}) {
		const ordered = opts.ordered !== false;
		await this._ipc.request('dc.create', { pcId: this._pcId }, {
			label,
			ordered,
		});
		const dc = new DataChannel(this._ipc, this._pcId, label);
		this._dataChannels.set(label, dc);
		return dc;
	}

	/**
	 * Close this PeerConnection.
	 */
	async close() {
		this._detach();
		for (const dc of this._dataChannels.values()) {
			dc._detach();
		}
		this._dataChannels.clear();
		await this._ipc.request('pc.close', { pcId: this._pcId });
	}

	_detach() {
		this._ipc.off('pc.icecandidate', this._onIceCandidate);
		this._ipc.off('pc.statechange', this._onStateChange);
		this._ipc.off('pc.datachannel', this._onDataChannel);
	}
}

export { PeerConnection };
