import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '@msgpack/msgpack';
import {
	encodeFrame,
	decodeFrame,
	MAX_FRAME_SIZE,
	HEADER_LEN_SIZE,
} from '../src/ipc/protocol.js';

test('empty payload roundtrip', () => {
	const header = { type: 'req', id: 1, method: 'ping' };
	const frame = encodeFrame(header);
	const totalLen = frame.readUInt32LE(0);
	const body = frame.subarray(4, 4 + totalLen);
	const result = decodeFrame(body);

	assert.equal(result.header.type, 'req');
	assert.equal(result.header.id, 1);
	assert.equal(result.header.method, 'ping');
	assert.equal(result.payload.length, 0);
});

test('payload roundtrip', () => {
	const header = { type: 'req', id: 42, method: 'dc.send', pcId: 'pc1', dcLabel: 'chat' };
	const payload = Buffer.from('hello world');
	const frame = encodeFrame(header, payload);
	const totalLen = frame.readUInt32LE(0);
	const body = frame.subarray(4, 4 + totalLen);
	const result = decodeFrame(body);

	assert.equal(result.header.type, 'req');
	assert.equal(result.header.id, 42);
	assert.equal(result.header.method, 'dc.send');
	assert.equal(result.header.pcId, 'pc1');
	assert.equal(result.header.dcLabel, 'chat');
	assert.deepEqual(result.payload, payload);
});

test('response frame roundtrip', () => {
	const header = { type: 'res', id: 7, ok: true };
	const payload = Buffer.from([0x01, 0x02, 0x03]);
	const frame = encodeFrame(header, payload);
	const totalLen = frame.readUInt32LE(0);
	const result = decodeFrame(frame.subarray(4, 4 + totalLen));

	assert.equal(result.header.type, 'res');
	assert.equal(result.header.id, 7);
	assert.equal(result.header.ok, true);
	assert.deepEqual(result.payload, Buffer.from([0x01, 0x02, 0x03]));
});

test('error response frame', () => {
	const header = { type: 'res', id: 8, ok: false, error: 'not found' };
	const frame = encodeFrame(header);
	const totalLen = frame.readUInt32LE(0);
	const result = decodeFrame(frame.subarray(4, 4 + totalLen));

	assert.equal(result.header.ok, false);
	assert.equal(result.header.error, 'not found');
});

test('event frame roundtrip', () => {
	const header = { type: 'evt', event: 'dc.message', pcId: 'pc1', dcLabel: 'rpc', isBinary: true };
	const payload = Buffer.from([0xFF, 0xFE]);
	const frame = encodeFrame(header, payload);
	const totalLen = frame.readUInt32LE(0);
	const result = decodeFrame(frame.subarray(4, 4 + totalLen));

	assert.equal(result.header.type, 'evt');
	assert.equal(result.header.event, 'dc.message');
	assert.equal(result.header.isBinary, true);
	assert.deepEqual(result.payload, Buffer.from([0xFF, 0xFE]));
});

test('all header fields preserved', () => {
	const header = {
		type: 'req',
		id: 99,
		method: 'pc.create',
		pcId: 'my-pc',
		dcLabel: 'my-dc',
		ok: true,
		error: 'test-err',
		event: 'test-evt',
		isBinary: true,
	};
	const frame = encodeFrame(header);
	const totalLen = frame.readUInt32LE(0);
	const result = decodeFrame(frame.subarray(4, 4 + totalLen));

	assert.equal(result.header.type, 'req');
	assert.equal(result.header.id, 99);
	assert.equal(result.header.method, 'pc.create');
	assert.equal(result.header.pcId, 'my-pc');
	assert.equal(result.header.dcLabel, 'my-dc');
	assert.equal(result.header.ok, true);
	assert.equal(result.header.error, 'test-err');
	assert.equal(result.header.event, 'test-evt');
	assert.equal(result.header.isBinary, true);
});

test('rejects frame body shorter than 2 bytes', () => {
	assert.throws(
		() => decodeFrame(Buffer.alloc(1)),
		/frame too short/
	);
});

test('rejects header length exceeding frame size', () => {
	const buf = Buffer.alloc(4);
	buf.writeUInt16LE(100, 0); // header length = 100 but only 2 bytes remain
	assert.throws(
		() => decodeFrame(buf),
		/header length.*exceeds frame size/
	);
});

test('Uint8Array payload roundtrip', () => {
	const header = { type: 'req', id: 5, method: 'test' };
	const payload = new Uint8Array([10, 20, 30]);
	const frame = encodeFrame(header, payload);
	const totalLen = frame.readUInt32LE(0);
	const result = decodeFrame(frame.subarray(4, 4 + totalLen));

	assert.deepEqual([...result.payload], [10, 20, 30]);
});

test('large payload near limit', () => {
	const header = { type: 'req', id: 1, method: 'big' };
	// Create a payload that makes the frame close to but within max
	const payload = Buffer.alloc(1024 * 1024); // 1 MiB
	const frame = encodeFrame(header, payload);
	const totalLen = frame.readUInt32LE(0);
	const result = decodeFrame(frame.subarray(4, 4 + totalLen));
	assert.equal(result.payload.length, 1024 * 1024);
});

test('rejects frame exceeding max size', () => {
	const header = { type: 'req', id: 1, method: 'toobig' };
	const payload = Buffer.alloc(MAX_FRAME_SIZE); // will exceed with header
	assert.throws(
		() => encodeFrame(header, payload),
		/frame too large/
	);
});

test('decodeFrame with headerLen=0', () => {
	// 构造 headerLen=0 的帧体：2 字节 headerLen(0) + 若干 payload
	const body = Buffer.alloc(6);
	body.writeUInt16LE(0, 0); // headerLen=0
	body.write('data', 2);
	// headerLen=0 → decode 空 msgpack 区域，msgpack 解码空 buffer 会抛错
	assert.throws(() => decodeFrame(body));
});

test('frame at exact MAX_FRAME_SIZE boundary succeeds', () => {
	const header = { type: 'req', id: 1, method: 'x' };
	const headerBytes = encode(header);
	// totalLen = HEADER_LEN_SIZE(2) + headerBytes.length + payloadLen = MAX_FRAME_SIZE
	const payloadLen = MAX_FRAME_SIZE - HEADER_LEN_SIZE - headerBytes.length;
	const payload = Buffer.alloc(payloadLen);
	const frame = encodeFrame(header, payload);
	const totalLen = frame.readUInt32LE(0);
	assert.equal(totalLen, MAX_FRAME_SIZE);
	const result = decodeFrame(frame.subarray(4, 4 + totalLen));
	assert.equal(result.payload.length, payloadLen);
});

test('frame at MAX_FRAME_SIZE + 1 fails', () => {
	const header = { type: 'req', id: 1, method: 'x' };
	const headerBytes = encode(header);
	// totalLen = HEADER_LEN_SIZE + headerBytes.length + payloadLen = MAX_FRAME_SIZE + 1
	const payloadLen = MAX_FRAME_SIZE - HEADER_LEN_SIZE - headerBytes.length + 1;
	const payload = Buffer.alloc(payloadLen);
	assert.throws(
		() => encodeFrame(header, payload),
		/frame too large/
	);
});

test('payload with all 256 byte values roundtrip', () => {
	const header = { type: 'req', id: 1, method: 'allbytes' };
	const payload = Buffer.alloc(256);
	for (let i = 0; i < 256; i++) payload[i] = i;
	const frame = encodeFrame(header, payload);
	const totalLen = frame.readUInt32LE(0);
	const result = decodeFrame(frame.subarray(4, 4 + totalLen));
	assert.deepEqual(result.payload, payload);
});

test('decode header with missing optional fields', () => {
	// 模拟 Go 的 omitempty：header 只有 { type: 'res', id: 1 }，无 ok/error
	const header = { type: 'res', id: 1 };
	const frame = encodeFrame(header);
	const totalLen = frame.readUInt32LE(0);
	const result = decodeFrame(frame.subarray(4, 4 + totalLen));
	assert.equal(result.header.type, 'res');
	assert.equal(result.header.id, 1);
	assert.equal(result.header.ok, undefined);
	assert.equal(result.header.error, undefined);
});

test('decode empty map header', () => {
	const header = {};
	const frame = encodeFrame(header);
	const totalLen = frame.readUInt32LE(0);
	const result = decodeFrame(frame.subarray(4, 4 + totalLen));
	assert.deepEqual(result.header, {});
	assert.equal(result.payload.length, 0);
});
