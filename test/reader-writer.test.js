import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { FrameReader } from '../src/ipc/reader.js';
import { FrameWriter } from '../src/ipc/writer.js';

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
