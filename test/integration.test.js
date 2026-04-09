import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { PionIpc } from '../src/pion-ipc.js';
import { RTCPeerConnection } from '../src/peer-connection.js';
import { RTCDataChannel } from '../src/data-channel.js';

const BIN_PATH = process.env.PION_IPC_BIN;
const hasBinary = BIN_PATH && existsSync(BIN_PATH);

test('two PeerConnections exchange data via DataChannel', {
	skip: !hasBinary && 'PION_IPC_BIN not set or binary missing',
	timeout: 30_000,
}, async () => {
	const ipc = new PionIpc({ binPath: BIN_PATH });
	await ipc.start();

	const pc1 = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-offerer' });
	const pc2 = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-answerer' });

	// Wait for deferred init
	await pc1._ready;
	await pc2._ready;

	// Collect ICE candidates
	const pc1Candidates = [];
	const pc2Candidates = [];

	pc1.on('icecandidate', (e) => pc1Candidates.push(e.candidate));
	pc2.on('icecandidate', (e) => pc2Candidates.push(e.candidate));

	// pc1 creates a DataChannel (synchronous) and an offer
	const dc1 = pc1.createDataChannel('test-channel');

	const offer = await pc1.createOffer();
	await pc2.setRemoteDescription(offer);

	const answer = await pc2.createAnswer();
	await pc1.setRemoteDescription(answer);

	// Wait for ICE candidates to trickle, then exchange them
	await new Promise((resolve) => setTimeout(resolve, 500));

	for (const c of pc1Candidates) {
		await pc2.addIceCandidate(c);
	}
	for (const c of pc2Candidates) {
		await pc1.addIceCandidate(c);
	}

	// Wait for the remote DataChannel to appear on pc2
	const remoteDc = await new Promise((resolve) => {
		pc2.on('datachannel', (evt) => resolve(evt.channel));
	});

	assert.equal(remoteDc.label, 'test-channel');
	assert.ok(remoteDc instanceof RTCDataChannel);

	// Wait for dc1 to open
	await new Promise((resolve) => {
		if (dc1.readyState === 'open') return resolve();
		dc1.on('open', resolve);
		setTimeout(() => resolve(), 2000);
	});

	// Send a text message from dc1 -> remoteDc
	const msgPromise = new Promise((resolve) => {
		remoteDc.on('message', (msg) => resolve(msg));
	});

	dc1.send('hello from offerer');
	const received = await msgPromise;
	assert.equal(received.data, 'hello from offerer');

	// Send binary data from remoteDc -> dc1
	const binPromise = new Promise((resolve) => {
		dc1.on('message', (msg) => resolve(msg));
	});

	// Wait for remoteDc to be open
	if (remoteDc.readyState !== 'open') {
		await new Promise((resolve) => {
			remoteDc.on('open', resolve);
			setTimeout(() => resolve(), 2000);
		});
	}

	remoteDc.send(Buffer.from([0x01, 0x02, 0x03]));
	const binReceived = await binPromise;
	assert.ok(Buffer.isBuffer(binReceived.data));
	assert.deepEqual([...binReceived.data], [1, 2, 3]);

	// Attach error handlers before close to prevent unhandled 'error' events
	dc1.on('error', () => {});
	remoteDc.on('error', () => {});

	// Clean up
	await pc1.close();
	await pc2.close();
	await ipc.stop();
});

test('PeerConnection connectionstatechange event fires', {
	skip: !hasBinary && 'PION_IPC_BIN not set or binary missing',
	timeout: 20_000,
}, async () => {
	const ipc = new PionIpc({ binPath: BIN_PATH });
	await ipc.start();

	const pc1 = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-state-1' });
	const pc2 = new RTCPeerConnection({ _ipc: ipc, _pcId: 'pc-state-2' });

	await pc1._ready;
	await pc2._ready;

	const states = [];
	pc1.on('connectionstatechange', () => {
		states.push(pc1.connectionState);
	});

	// Suppress dc.error during teardown for any remote DCs
	pc2.on('datachannel', (evt) => {
		evt.channel.on('error', () => {});
	});

	// Create offer/answer to trigger state changes
	const dummyDc = pc1.createDataChannel('dummy');
	dummyDc.on('error', () => {}); // suppress teardown errors
	const offer = await pc1.createOffer();
	await pc2.setRemoteDescription(offer);
	const answer = await pc2.createAnswer();
	await pc1.setRemoteDescription(answer);

	// Wait for ICE and connection to establish
	const pc1Candidates = [];
	const pc2Candidates = [];
	pc1.on('icecandidate', (e) => pc1Candidates.push(e.candidate));
	pc2.on('icecandidate', (e) => pc2Candidates.push(e.candidate));

	await new Promise((resolve) => setTimeout(resolve, 500));

	for (const c of pc1Candidates) await pc2.addIceCandidate(c);
	for (const c of pc2Candidates) await pc1.addIceCandidate(c);

	// Wait for connected state
	await new Promise((resolve) => setTimeout(resolve, 2000));

	assert.ok(states.length > 0, 'should have received state changes');

	await pc1.close();
	await pc2.close();
	await ipc.stop();
});
