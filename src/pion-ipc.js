import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { encode } from '@msgpack/msgpack';
import { FrameReader } from './ipc/reader.js';
import { FrameWriter } from './ipc/writer.js';
import { resolveBinary } from './binary.js';

const DEFAULT_TIMEOUT = 10_000;

/**
 * Manages a pion-ipc Go child process, providing request/response IPC
 * and event emission.
 */
class PionIpc extends EventEmitter {
	/**
	 * @param {object} [opts]
	 * @param {string} [opts.binPath] - Path to pion-ipc binary (overrides auto-detection)
	 * @param {Function} [opts.logger] - Logging function (receives string)
	 * @param {number} [opts.timeout] - Default request timeout in ms
	 */
	constructor(opts = {}) {
		super();
		this._binPath = opts.binPath || null;
		this._logger = opts.logger || null;
		this._timeout = opts.timeout ?? DEFAULT_TIMEOUT;
		this._proc = null;
		this._reader = null;
		this._writer = null;
		this._nextId = 1;
		this._pending = new Map(); // id -> { resolve, reject, timer }
		this._started = false;
	}

	/**
	 * Spawn the pion-ipc process and verify it is ready via ping.
	 */
	async start() {
		if (this._started) throw new Error('already started');

		const bin = this._binPath || resolveBinary();
		this._log(`spawning ${bin}`);

		this._proc = spawn(bin, [], {
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		this._proc.on('error', (err) => {
			this._log(`process error: ${err.message}`);
			this.__safeEmit('error', err);
		});

		this._proc.on('exit', (code, signal) => {
			this._log(`process exited code=${code} signal=${signal}`);
			this._rejectAllPending(new Error(`process exited (code=${code}, signal=${signal})`));
			this._started = false;
			this.emit('exit', code, signal);
		});

		// Collect stderr for logging
		this._proc.stderr?.on('data', (chunk) => {
			this._log(`[stderr] ${chunk.toString().trimEnd()}`);
		});

		this._reader = new FrameReader(this._proc.stdout);
		this._writer = new FrameWriter(this._proc.stdin);

		this._reader.onFrame((header, payload) => {
			if (header.type === 'res') {
				this._handleResponse(header, payload);
			} else if (header.type === 'evt') {
				this._handleEvent(header, payload);
			} else {
				this._log(`unknown message type: ${header.type}`);
			}
		});

		this._reader.onError((err) => {
			this._log(`reader error: ${err.message}`);
			this.__safeEmit('error', err);
		});

		this._reader.onEnd(() => {
			this._log('stdout ended');
		});

		this._started = true;

		// Verify process is ready
		try {
			await this.request('ping');
		} catch (err) {
			await this.stop().catch(() => {});
			throw err;
		}
		this._log('pion-ipc ready');
	}

	/**
	 * Stop the pion-ipc process gracefully.
	 * Closes stdin to signal the Go process, then waits for exit with a timeout.
	 * @param {number} [timeout=5000] - Max ms to wait before SIGTERM
	 */
	async stop(timeout = 5000) {
		if (!this._proc) return;

		const proc = this._proc;
		this._proc = null;
		this._started = false;

		return new Promise((resolve) => {
			let settled = false;

			const done = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this._rejectAllPending(new Error('ipc stopped'));
				resolve();
			};

			proc.on('exit', done);

			const timer = setTimeout(() => {
				this._log('stop timeout, sending SIGTERM');
				proc.kill('SIGTERM');
				// Give it a bit more time after SIGTERM
				setTimeout(done, 1000);
			}, timeout);

			// Close stdin to signal graceful shutdown
			proc.stdin.end();
		});
	}

	/**
	 * Send a request and wait for a matching response.
	 * @param {string} method - RPC method name
	 * @param {object} [opts] - Header fields: pcId, dcLabel, isBinary
	 * @param {Buffer|Uint8Array|object} [payload] - Payload (object will be msgpack-encoded)
	 * @returns {Promise<{ header: object, payload: Buffer }>}
	 */
	async request(method, opts = {}, payload) {
		if (!this._started) throw new Error('not started');

		const id = this._nextId;
		this._nextId = (this._nextId + 1) >>> 0;
		if (this._nextId === 0) this._nextId = 1; // skip 0 (omitempty issue)
		const header = {
			type: 'req',
			id,
			method,
		};

		if (opts.pcId != null) header.pcId = opts.pcId;
		if (opts.dcLabel != null) header.dcLabel = opts.dcLabel;
		if (opts.isBinary) header.isBinary = true;

		let payloadBuf = Buffer.alloc(0);
		if (payload !== undefined && payload !== null) {
			if (Buffer.isBuffer(payload) || payload instanceof Uint8Array) {
				payloadBuf = payload;
			} else {
				// Encode object as msgpack
				payloadBuf = Buffer.from(encode(payload));
			}
		}

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this._pending.delete(id);
				reject(new Error(`request timeout: ${method} (id=${id})`));
			}, this._timeout);

			this._pending.set(id, { resolve, reject, timer, method });
			try {
				this._writer.write(header, payloadBuf);
			} catch (err) {
				this._pending.delete(id);
				clearTimeout(timer);
				reject(err);
			}
		});
	}

	_handleResponse(header, payload) {
		const entry = this._pending.get(header.id);
		if (!entry) {
			this._log(`orphan response id=${header.id}`);
			return;
		}
		this._pending.delete(header.id);
		clearTimeout(entry.timer);

		if (header.ok) {
			entry.resolve({ header, payload });
		} else {
			// 始终记录 IPC 层错误（含 method 上下文），即使上层 catch 了也保留诊断痕迹
			this._log(`request error id=${header.id} method=${entry.method} err=${header.error || 'request failed'}`);
			entry.reject(new Error(header.error || 'request failed'));
		}
	}

	_handleEvent(header, payload) {
		this.emit(header.event, {
			pcId: header.pcId,
			dcLabel: header.dcLabel,
			isBinary: header.isBinary,
			payload,
		});
	}

	_rejectAllPending(err) {
		for (const [id, entry] of this._pending) {
			clearTimeout(entry.timer);
			entry.reject(err);
			this._pending.delete(id);
		}
	}

	_log(msg) {
		try {
			if (this._logger) {
				this._logger(`[pion-ipc] ${msg}`);
			} else {
				// 兜底：未配置 logger 时仍要让错误可见，避免静默吞掉诊断
				console.warn(`[pion-ipc] ${msg}`);
			}
		/* c8 ignore next 3 -- logger 抛异常属罕见，吞掉以保证调用方不被污染 */
		} catch {
			// nothing
		}
	}

	/**
	 * 安全 emit：仅在有 listener 时 emit 且吞 listener 异常。
	 * 与 RTCDataChannel.__safeEmit 同语义，避免 EventEmitter 默认行为
	 * 在没有应用层注册时杀掉宿主进程。
	 */
	__safeEmit(event, ...args) {
		if (this.listenerCount(event) === 0) return;
		try {
			this.emit(event, ...args);
		/* c8 ignore next 3 -- listener 抛异常属罕见 */
		} catch (err) {
			this._log(`emit ${event} listener threw: ${err?.message ?? err}`);
		}
	}

	get started() {
		return this._started;
	}
}

export { PionIpc };
