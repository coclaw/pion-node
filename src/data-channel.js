import { EventEmitter } from 'node:events';
import { decode } from '@msgpack/msgpack';

/** close() 等待 sendQueue 排空的默认最大时长（毫秒）；超时后丢弃残余 */
const DEFAULT_CLOSE_DRAIN_TIMEOUT_MS = 5000;

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
		// _bufferedAmount = JS-side 估算（sendQueue + IPC in-flight），同步维护
		this._bufferedAmount = 0;
		// _goBufferedBytes = Go-side 实际 SCTP BufferedAmount 的缓存
		// 由两条路径更新：
		// 1. drain loop 在收到 dc.send IPC ack 时从 ack.payload 解析（主路径）
		// 2. _refreshGoBA() 在收到 bal IPC 事件后主动 dc.getBA 查询（补充路径）
		// 两者都来自 Go 真值，后到者覆盖。
		this._goBufferedBytes = 0;
		this._bufferedAmountLowThreshold = 0;
		this._sendQueue = [];
		this._draining = false;
		this._closed = false;
		// 测试可注入更短超时；生产用 5s 默认
		this._closeDrainTimeoutMs = config._closeDrainTimeoutMs ?? DEFAULT_CLOSE_DRAIN_TIMEOUT_MS;

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
				this.__reportError(new Error(evt.payload?.toString('utf8') || 'unknown error'), 'remote-error');
			}
		};
		this._onDcBal = (evt) => {
			if (evt.pcId !== this._pcId || evt.dcLabel !== this._label) return;
			if (this._readyState !== 'open') return;
			this._refreshGoBA();
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

	/**
	 * W3C bufferedAmount。
	 *
	 * 返回 (JS-side `_bufferedAmount`) + (Go-side SCTP BufferedAmount 缓存)。
	 *
	 * **R 方案**：
	 * - `_bufferedAmount` 由 `send()` 同步增加、drain loop 同步减少
	 * - `_goBufferedBytes` 由 drain loop 在收到 send IPC ack 时从 ack.payload 解析更新
	 * - 因此 getter 在 send 完成后**立即**反映 Go-side 的真实状态
	 *
	 * **W3C 语义守卫**：
	 * - `connecting`：还没发过任何东西，返回 0
	 * - `closing`：仍在 graceful drain，残余字节真实存在，返回完整 sum
	 * - `closed`：已强制清零，sum 即为 0；返回值与计算一致
	 */
	get bufferedAmount() {
		if (this._readyState === 'connecting') return 0;
		return this._bufferedAmount + this._goBufferedBytes;
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
			this.__reportError(err, 'setBALT');
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
				if (this._closed) break;
				const { isBinary, payload } = this._sendQueue.shift();

				// **关键**：在 await IPC 之前快照 cache，用于后面计算 prevTotal。
				// 必须使用这个旧值，否则 threshold-cross 检测会被 ack 携带的新 BA 污染，
				// 导致"应当 emit 的 bufferedamountlow 不会触发"——下游 stream.resume 不会被调用，
				// 文件传输会卡死。
				const prevBufferedAmount = this._bufferedAmount;
				const prevGoBufferedBytes = this._goBufferedBytes;

				let ackPayload = null;
				try {
					const res = await this._ipc.request('dc.send', {
						pcId: this._pcId,
						dcLabel: this._label,
						isBinary,
					}, payload);
					ackPayload = res?.payload;
				} catch (err) {
					if (!this._closed) this.__reportError(err, 'send');
				}

				// 在 await 之后再次检查 _closed —— close() 可能已经强制清零状态，
				// 此时不应再触碰 cache 或 emit 任何事件（避免 post-close 复活 cache）。
				if (this._closed) break;

				// **R 方案核心**：从 send ack 中解析 Go-side BufferedAmount 并刷新缓存。
				// 这是 _goBufferedBytes 的主更新路径——不再依赖 lazy refresh。
				// ack.payload 是 msgpack 编码的 { bufferedAmount: uint64 }。
				if (ackPayload && ackPayload.length > 0) {
					try {
						const decoded = decode(ackPayload);
						const goBA = Number(decoded?.bufferedAmount);
						if (Number.isFinite(goBA) && goBA >= 0) {
							this._goBufferedBytes = goBA;
						}
					/* c8 ignore next 3 -- msgpack decode 失败保留旧值，下次 ack 自然校正 */
					} catch {
						// keep stale value
					}
				}

				this._bufferedAmount = Math.max(0, this._bufferedAmount - payload.length);

				// threshold-cross 检测：用 await 之前快照的 cache 算 prevTotal，
				// 用 ack 之后的实时值算 newTotal。两者代表 drain step 前后的总 buffered。
				// Only emit when crossing threshold (from above to at-or-below)
				const prevTotal = prevBufferedAmount + prevGoBufferedBytes;
				const newTotal = this._bufferedAmount + this._goBufferedBytes;
				if (prevTotal > this._bufferedAmountLowThreshold
					&& newTotal <= this._bufferedAmountLowThreshold) {
					this.__safeEmit('bufferedamountlow');
				}
			}
			this._draining = false;

			// Check for messages queued during drain
			if (this._sendQueue.length > 0 && !this._closed) {
				this._drainQueue();
			}
		};

		drain().catch((err) => {
			// 防御性兜底：drain 内部所有 emit 已通过 __safeEmit 包装，理论不可达；
			// 保留以应对未来引入的同步异常（如 _bufferedAmount 计算溢出等）。
			/* c8 ignore next */
			if (!this._closed) this.__reportError(err, 'drain');
		});
	}

	/**
	 * 上报 DataChannel 错误：始终通过 ipc logger 记录（保证诊断可见），
	 * 仅在有 'error' listener 时 emit；listener 抛异常时同样吞并记录，
	 * 永不让本方法抛出（避免污染调用方的 try/catch 链路）。
	 * @param {Error} err
	 * @param {string} context - 触发位置标签（send/drain/setBALT/remote-error 等）
	 */
	__reportError(err, context) {
		const msg = err?.message ?? String(err);
		try {
			this._ipc?._log?.(`dc error pcId=${this._pcId} label=${this._label} ctx=${context} err=${msg}`);
		/* c8 ignore next 3 -- logger 抛异常属罕见，吞掉以保证错误上报路径不被阻断 */
		} catch {
			// nothing
		}
		this.__safeEmit('error', err);
	}

	/**
	 * 安全 emit：仅在有 listener 时 emit，且吞掉 listener 同步抛出的异常。
	 * 用于所有"非致命事件"路径，避免 EventEmitter 默认行为或恶意 listener
	 * 让 pion-node 内部状态机崩溃。
	 */
	__safeEmit(event, ...args) {
		if (this.listenerCount(event) === 0) return;
		try {
			this.emit(event, ...args);
		} catch (err) {
			/* c8 ignore next 3 -- nested logger 失败属罕见 */
			try {
				this._ipc?._log?.(`dc ${this._label} emit ${event} listener threw: ${err?.message ?? err}`);
			} catch { /* nothing */ }
		}
	}

	/**
	 * bal IPC 后主动查询 Go-side BA，刷新 _goBufferedBytes 缓存，然后 emit bufferedamountlow。
	 * 解决 bal 事件不携带 BA 数据导致缓存过期的问题——长空闲后上层可能因旧缓存
	 * 误判 BA 高于实际而拒绝发送，形成死锁。
	 *
	 * per-PC worker 保证 dc.getBA 在同 PC 的串行队列中执行，无竞态。
	 */
	_refreshGoBA() {
		if (this._closed) return;
		this._ipc.request('dc.getBA', {
			pcId: this._pcId,
			dcLabel: this._label,
		}).then((res) => {
			if (this._closed || this._readyState !== 'open') return;
			if (res?.payload && res.payload.length > 0) {
				try {
					const decoded = decode(res.payload);
					const goBA = Number(decoded?.bufferedAmount);
					if (Number.isFinite(goBA) && goBA >= 0) {
						this._goBufferedBytes = goBA;
					}
				/* c8 ignore next 3 -- decode 失败保留旧值，下次 ack 自然校正 */
				} catch {
					// keep stale value
				}
			}
			this.__safeEmit('bufferedamountlow');
		}).catch((err) => {
			// IPC 失败——仍 emit（旧行为回退），保持缓存不变
			this._ipc?._log?.(`dc ${this._label} dc.getBA failed: ${err?.message}`);
			if (!this._closed && this._readyState === 'open') {
				this.__safeEmit('bufferedamountlow');
			}
		});
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
	 *
	 * W3C 兼容的 graceful close：先等待 sendQueue 排空再关闭，
	 * 否则调用 close() 之前 push 的最后一条消息会被丢弃（典型场景：
	 * 文件下载在 stream 'end' 中先 send 完成确认 JSON、紧接着 close）。
	 *
	 * 5 秒兜底：drain 异常停滞时不无限阻塞，超时后丢弃残余并强关。
	 */
	async close() {
		if (this._closed) return;
		this._readyState = 'closing';
		const startWait = Date.now();
		while (this._sendQueue.length > 0 || this._draining) {
			if (Date.now() - startWait > this._closeDrainTimeoutMs) {
				this._ipc?._log?.(`dc ${this._label} close drain timeout, dropping ${this._sendQueue.length} queued message(s)`);
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		// _forceClose() 可能在 drain wait 期间已完成清理和 emit，此时不再重复操作
		if (this._closed) return;
		this._closed = true;
		this._sendQueue.length = 0;
		this._bufferedAmount = 0;
		this._goBufferedBytes = 0;
		this._detach();
		this._readyState = 'closed';
		await this._ipc.request('dc.close', {
			pcId: this._pcId,
			dcLabel: this._label,
		});
		this.emit('close');
	}

	/**
	 * IPC 进程崩溃时的强制关闭——不发 IPC、不等 drain，直接转 closed。
	 * 由 RTCPeerConnection 的 exit handler 调用。
	 */
	_forceClose() {
		if (this._closed) return;
		this._closed = true;
		this._sendQueue.length = 0;
		this._bufferedAmount = 0;
		this._goBufferedBytes = 0;
		this._detach();
		this._readyState = 'closed';
		this.emit('close');
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
