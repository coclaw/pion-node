import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { FrameReader } from '../src/ipc/reader.js';
import { FrameWriter } from '../src/ipc/writer.js';
import { encodeFrame } from '../src/ipc/protocol.js';

test('single frame roundtrip via PassThrough', async () => {
	const stream = new PassThrough();
	const reader = new FrameReader(stream);
	const writer = new FrameWriter(stream);

	const received = new Promise((resolve) => {
		reader.onFrame((header, payload) => resolve({ header, payload }));
	});

	writer.write({ type: 'req', id: 1, method: 'ping' });

	const { header, payload } = await received;
	assert.equal(header.type, 'req');
	assert.equal(header.id, 1);
	assert.equal(header.method, 'ping');
	assert.equal(payload.length, 0);
});

test('frame with binary payload', async () => {
	const stream = new PassThrough();
	const reader = new FrameReader(stream);
	const writer = new FrameWriter(stream);

	const received = new Promise((resolve) => {
		reader.onFrame((header, payload) => resolve({ header, payload }));
	});

	const data = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);
	writer.write({ type: 'evt', event: 'dc.message', isBinary: true }, data);

	const { header, payload } = await received;
	assert.equal(header.type, 'evt');
	assert.equal(header.event, 'dc.message');
	assert.equal(header.isBinary, true);
	assert.deepEqual(payload, data);
});

test('multiple frames in sequence', async () => {
	const stream = new PassThrough();
	const reader = new FrameReader(stream);
	const writer = new FrameWriter(stream);

	const frames = [];
	const allReceived = new Promise((resolve) => {
		reader.onFrame((header, payload) => {
			frames.push({ header, payload });
			if (frames.length === 3) resolve();
		});
	});

	writer.write({ type: 'req', id: 1, method: 'a' });
	writer.write({ type: 'req', id: 2, method: 'b' }, Buffer.from('hello'));
	writer.write({ type: 'res', id: 1, ok: true });

	await allReceived;

	assert.equal(frames[0].header.method, 'a');
	assert.equal(frames[1].header.method, 'b');
	assert.deepEqual(frames[1].payload, Buffer.from('hello'));
	assert.equal(frames[2].header.ok, true);
});

test('handles chunked delivery', async () => {
	const stream = new PassThrough();
	const reader = new FrameReader(stream);

	// Build a complete frame via a helper stream
	const helperStream = new PassThrough();
	const helperWriter = new FrameWriter(helperStream);
	const chunks = [];
	helperStream.on('data', (chunk) => chunks.push(chunk));
	helperWriter.write({ type: 'req', id: 10, method: 'chunked' }, Buffer.from('data'));

	// Wait for data
	await new Promise((resolve) => setTimeout(resolve, 10));

	const fullFrame = Buffer.concat(chunks);

	const received = new Promise((resolve) => {
		reader.onFrame((header, payload) => resolve({ header, payload }));
	});

	// Feed the frame byte-by-byte
	for (let i = 0; i < fullFrame.length; i++) {
		stream.write(Buffer.from([fullFrame[i]]));
	}

	const { header, payload } = await received;
	assert.equal(header.id, 10);
	assert.equal(header.method, 'chunked');
	assert.deepEqual(payload, Buffer.from('data'));
});

test('reader emits error for oversized frame', async () => {
	const stream = new PassThrough();
	const reader = new FrameReader(stream);

	const errPromise = new Promise((resolve) => {
		reader.onError((err) => resolve(err));
	});

	// Write a length prefix indicating a frame larger than MAX_FRAME_SIZE
	const buf = Buffer.alloc(4);
	buf.writeUInt32LE(20 * 1024 * 1024, 0); // 20 MiB
	stream.write(buf);

	const err = await errPromise;
	assert.match(err.message, /exceeds max/);
});

test('reader calls onEnd when stream ends', async () => {
	const stream = new PassThrough();
	const reader = new FrameReader(stream);

	const endPromise = new Promise((resolve) => {
		reader.onEnd(resolve);
	});

	stream.end();
	await endPromise;
});

test('multiple frames in single chunk', async () => {
	const stream = new PassThrough();
	const reader = new FrameReader(stream);

	const frames = [];
	const allReceived = new Promise((resolve) => {
		reader.onFrame((header, payload) => {
			frames.push({ header, payload });
			if (frames.length === 2) resolve();
		});
	});

	// 将两个完整帧拼接到一个 chunk 中写入
	const frame1 = encodeFrame({ type: 'req', id: 1, method: 'a' });
	const frame2 = encodeFrame({ type: 'req', id: 2, method: 'b' }, Buffer.from('hi'));
	stream.write(Buffer.concat([frame1, frame2]));

	await allReceived;
	assert.equal(frames[0].header.method, 'a');
	assert.equal(frames[1].header.method, 'b');
	assert.deepEqual(frames[1].payload, Buffer.from('hi'));
});

test('reader propagates stream error', async () => {
	const stream = new PassThrough();
	const reader = new FrameReader(stream);

	const errPromise = new Promise((resolve) => {
		reader.onError((err) => resolve(err));
	});

	stream.destroy(new Error('stream broke'));

	const err = await errPromise;
	assert.equal(err.message, 'stream broke');
});

test('reader calls onError for corrupt frame body', async () => {
	const stream = new PassThrough();
	const reader = new FrameReader(stream);

	const errPromise = new Promise((resolve) => {
		reader.onError((err) => resolve(err));
	});

	// 写一个长度前缀 = 4，后面跟 4 字节随机（不是合法 msgpack）
	const buf = Buffer.alloc(8);
	buf.writeUInt32LE(4, 0); // totalLen = 4
	// headerLen 声明 2 字节，但 msgpack 内容非法
	buf.writeUInt16LE(2, 4);
	buf[6] = 0xFF; // 非法 msgpack
	buf[7] = 0xFF;
	stream.write(buf);

	const err = await errPromise;
	assert.ok(err instanceof Error);
});

test('writer throws after stream error', () => {
	const stream = new PassThrough();
	const writer = new FrameWriter(stream);

	// 手动触发 stream error
	stream.emit('error', new Error('pipe broken'));

	assert.throws(
		() => writer.write({ type: 'req', id: 1, method: 'x' }),
		/pipe broken/
	);
});

test('writer write to ended stream', async () => {
	const stream = new PassThrough();
	const writer = new FrameWriter(stream);

	stream.end();

	// PassThrough 在 end 后 write 会触发 error 事件
	// writer 自身不直接抛，但 stream 会 emit error
	const errors = [];
	stream.on('error', (err) => errors.push(err));
	writer.write({ type: 'req', id: 1, method: 'x' });
	// Node.js emits 'write after end' error
	await new Promise((r) => setTimeout(r, 10));
	assert.ok(errors.length > 0, 'should emit error when writing to ended stream');
});

test('reader emits error for frame size too small (< 2)', async () => {
	const stream = new PassThrough();
	const reader = new FrameReader(stream);

	const errPromise = new Promise((resolve) => {
		reader.onError((err) => resolve(err));
	});

	// Write a length prefix indicating totalLen = 1, which is below minimum of 2
	const buf = Buffer.alloc(5);
	buf.writeUInt32LE(1, 0); // totalLen = 1
	buf[4] = 0x00; // one byte of body data (insufficient)
	stream.write(buf);

	const err = await errPromise;
	assert.match(err.message, /too small/);
});

test('reader resets buffer after frame-too-small error', async () => {
	const stream = new PassThrough();
	const reader = new FrameReader(stream);

	let errorCount = 0;
	reader.onError(() => { errorCount++; });

	// Send a frame with totalLen = 0 (too small)
	const buf = Buffer.alloc(4);
	buf.writeUInt32LE(0, 0);
	stream.write(buf);

	await new Promise((r) => setTimeout(r, 10));
	assert.equal(errorCount, 1);

	// Reader should have reset its buffer; send a valid frame
	const frames = [];
	reader.onFrame((header) => frames.push(header));

	const validFrame = encodeFrame({ type: 'req', id: 1, method: 'ok' });
	stream.write(validFrame);

	await new Promise((r) => setTimeout(r, 10));
	assert.equal(frames.length, 1);
	assert.equal(frames[0].method, 'ok');
});
