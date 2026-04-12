import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { encode } from '@msgpack/msgpack';
import { FrameReader } from './ipc/reader.js';
import { FrameWriter } from './ipc/writer.js';
import { resolveBinary } from './binary.js';

const DEFAULT_TIMEOUT = 10_000;
const DEFAULT_RESTART_RESET_WINDOW_MS = 60_000;
const RESTART_BASE_DELAY_MS = 200;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

/**
 * Manages a pion-ipc Go child process, providing request/response IPC
 * and event emission.
 *
 * Events: 'exit', 'error', 'restart'
 * - 'exit' (code, signal): process exited (crash or stop)
 * - 'restart': watchdog auto-restart succeeded
 *
 * When autoRestart is enabled, PionIpc acts as a watchdog: it retries
 * indefinitely with capped exponential backoff until stop() is called.
 */
class PionIpc extends EventEmitter {
	/**
	 * @param {object} [opts]
	 * @param {string} [opts.binPath] - Path to pion-ipc binary (overrides auto-detection)
	 * @param {Function} [opts.logger] - Logging function (receives string)
	 * @param {number} [opts.timeout] - Default request timeout in ms
	 * @param {boolean} [opts.autoRestart] - Watchdog mode: auto-restart on crash (default false)
	 * @param {number} [opts.maxBackoffMs] - Max backoff delay for watchdog retries (default 30s)
	 * @param {number} [opts.restartResetWindowMs] - Stable uptime before resetting attempt counter (default 60s)
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

		// watchdog 相关
		this._autoRestart = !!opts.autoRestart;
		this._maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
		this._restartResetWindowMs = opts.restartResetWindowMs ?? DEFAULT_RESTART_RESET_WINDOW_MS;
		this._intentionalStop = false;
		this._stopped = false;
		this._restartAttempts = 0;
		this._restartTimer = null;
		this._resetTimer = null;
		this._lastStartTime = 0;
	}

	/**
	 * Spawn the pion-ipc process and verify it is ready via ping.
	 */
	async start() {
		if (this._started) throw new Error('already started');
		this._stopped = false;
		this._intentionalStop = false;
		// 清除残留 watchdog timer：外部直接调 start() 时，可能有 pending 的重启 timer，
		// 若不清除，timer 触发后会 hit "already started" 并无限循环。
		clearTimeout(this._restartTimer);

		const bin = this._binPath || resolveBinary();
		this._log(`spawning ${bin}`);

		this._proc = spawn(bin, [], {
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		this._proc.on('error', (err) => {
			this._log(`process error: ${err.message}`);
			this.__safeEmit('error', err);
		});

		this._proc.on('exit', (code, signal) => this._handleProcessExit(code, signal));

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
		this._lastStartTime = Date.now();
		// ping 验证前设 _intentionalStop：若进程在 await 期间崩溃，
		// 防止 _handleProcessExit 与下方 catch 路径同时触发 _scheduleRestart。
		this._intentionalStop = true;

		// Verify process is ready
		try {
			await this.request('ping');
			this._intentionalStop = false;
		} catch (err) {
			await this._abortStart().catch(() => {});
			throw err;
		}

		// 稳定运行窗口：进程存活超过 resetWindow 后重置重试计数器
		this._scheduleResetTimer();

		this._log('pion-ipc ready');
	}

	/**
	 * Stop the pion-ipc process gracefully and permanently halt the watchdog.
	 * Closes stdin to signal the Go process, then waits for exit with a timeout.
	 * @param {number} [timeout=5000] - Max ms to wait before SIGTERM
	 */
	async stop(timeout = 5000) {
		// 先设标记再检查 _proc——即使进程已崩溃（_proc 被 exit handler 置 null），
		// 仍需取消待执行的 restart timer，否则 stop() 后进程会被意外重启。
		this._intentionalStop = true;
		this._stopped = true;
		clearTimeout(this._restartTimer);
		clearTimeout(this._resetTimer);
		await this._killProc(timeout, 'ipc stopped');
	}

	/**
	 * Internal: abort a failed start() — clean up without permanently halting the watchdog.
	 * _intentionalStop 已在 start() 的 ping 前预设为 true，此处无需再设。
	 */
	async _abortStart(timeout = 5000) {
		clearTimeout(this._restartTimer);
		clearTimeout(this._resetTimer);
		await this._killProc(timeout, 'ipc start aborted');
	}

	/**
	 * Internal: kill the Go process and reject all pending IPC requests.
	 * @param {number} timeout - Max ms to wait before SIGTERM
	 * @param {string} reason - Error message for pending rejections
	 */
	async _killProc(timeout, reason) {
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
				this._rejectAllPending(new Error(reason));
				resolve();
			};

			proc.on('exit', done);

			const timer = setTimeout(() => {
				this._log(`${reason}: timeout, sending SIGTERM`);
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
	 * Safe emit: only emits when listeners exist, swallows listener exceptions.
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

	/**
	 * Unified process exit handler — rejects pending requests, clears refs, emits exit, triggers auto-restart.
	 */
	_handleProcessExit(code, signal) {
		this._log(`process exited code=${code} signal=${signal}`);
		this._rejectAllPending(new Error(`process exited (code=${code}, signal=${signal})`));
		this._proc = null;
		this._started = false;
		clearTimeout(this._resetTimer);

		// intentional stop/abort 时不 emit 'exit'：
		// 消费者（RTCPeerConnection）此时要么已 closed，要么尚未创建。
		if (!this._intentionalStop) {
			this.emit('exit', code, signal);
			if (this._autoRestart) {
				this._scheduleRestart();
			}
		}
	}

	/**
	 * Watchdog: schedule a restart attempt with capped exponential backoff.
	 * Retries indefinitely until stop() is called.
	 */
	_scheduleRestart() {
		const delay = Math.min(
			RESTART_BASE_DELAY_MS * Math.pow(2, this._restartAttempts),
			this._maxBackoffMs,
		);
		this._restartAttempts++;
		this._log(`watchdog: restart #${this._restartAttempts} in ${delay}ms`);

		this._restartTimer = setTimeout(async () => {
			if (this._stopped) return;
			// start() 重置 _intentionalStop = false（成功后由崩溃重新触发 watchdog），
			// 失败时调 _abortStart()（不设 _stopped），catch 路径继续重试。
			try {
				await this.start();
				this._log('watchdog: restart succeeded');
				this.__safeEmit('restart');
			} catch (err) {
				this._log(`watchdog: restart failed: ${err.message}`);
				if (this._stopped) return;
				this._scheduleRestart();
			}
		}, delay);
	}

	/**
	 * Stability window timer: resets the restart counter after the process has been alive for resetWindow ms.
	 */
	_scheduleResetTimer() {
		clearTimeout(this._resetTimer);
		if (!this._autoRestart || this._restartResetWindowMs <= 0) return;
		this._resetTimer = setTimeout(() => {
			if (this._started && this._restartAttempts > 0) {
				this._log(`stable for ${this._restartResetWindowMs}ms, resetting restart counter`);
				this._restartAttempts = 0;
			}
		}, this._restartResetWindowMs);
	}

	get started() {
		return this._started;
	}
}

export { PionIpc };
