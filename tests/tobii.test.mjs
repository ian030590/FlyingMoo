import test from 'node:test';
import assert from 'node:assert/strict';
import { desktop } from '../wwwroot/desktop.mjs';
import { TobiiProvider } from '../wwwroot/providers/tobii.mjs';

function setup(t) {
  globalThis.window = { __TAURI__: { core: { invoke() {} } } };
  t.after(() => { delete globalThis.window; });
  t.mock.method(desktop, 'stopTobii', async () => {});
  t.mock.method(desktop, 'startTobii', async () => ({ success: true }));
  t.mock.method(desktop, 'mapNativeTimeToFrontend', () => performance.now());
  t.mock.method(desktop, 'readTobiiSnapshot', async () => null);
  const provider = new TobiiProvider();
  const messages = [];
  t.after(() => provider.stop());
  return { provider, messages };
}

const snapshot = (sessionId, timestampUs = 1000) => ({
  sessionId, timestampUs, valid: true, yawDeg: 20, pitchDeg: 10, rollDeg: 5,
  headX: 1, headY: 2, headZ: 600
});

test('Tobii: native startup snapshot is acknowledged and lifecycle commands stay ordered', async t => {
  const { provider } = setup(t);
  t.mock.restoreAll();
  const order = [];
  t.mock.method(desktop, 'syncClock', async () => {});
  let release;
  t.mock.method(desktop, 'invoke', async (command, args) => {
    order.push([command, args.sessionId]);
    if (command === 'start_tobii') {
      await new Promise(resolve => { release = resolve; });
      return { sessionId: args.sessionId, status: 'starting', valid: false };
    }
  });
  const starting = desktop.startTobii(7);
  const stopping = desktop.stopTobii(7);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, [['start_tobii', 7]]);
  release();
  assert.equal((await starting).success, true);
  await stopping;
  assert.deepEqual(order, [['start_tobii', 7], ['stop_tobii', 7]]);
  provider.sessionId = 7;
});

test('Tobii: repeated snapshots never become fresh poses; invalid values cannot become zero angles', async t => {
  const { provider, messages } = setup(t);
  await provider.start(7, message => messages.push(message));
  const read = t.mock.method(desktop, 'readTobiiSnapshot', async () => snapshot(7));
  await provider.pollSnapshot();
  await provider.pollSnapshot();
  assert.equal(messages.filter(m => m.type === 'pose').length, 1);
  assert.equal(messages.find(m => m.type === 'pose').sample.headZ, 600);
  read.mock.mockImplementation(async () => snapshot(7, 999));
  await provider.pollSnapshot();
  assert.equal(messages.filter(m => m.type === 'pose').length, 1);
  read.mock.mockImplementation(async () => ({ ...snapshot(7, 1001), yawDeg: NaN }));
  await provider.pollSnapshot();
  assert.equal(messages.filter(m => m.type === 'pose').length, 1);
  assert.equal(messages.at(-1).state, 'tracking-lost');
});

test('Tobii: stale and future captures are rejected; tracking loss and recovery remain visible', async t => {
  const { provider, messages } = setup(t);
  await provider.start(7, message => messages.push(message));
  const read = t.mock.method(desktop, 'readTobiiSnapshot', async () => snapshot(7));
  const clock = t.mock.method(desktop, 'mapNativeTimeToFrontend', () => performance.now() - 251);
  await provider.pollSnapshot();
  assert.equal(messages.at(-1).state, 'tracking-lost');
  read.mock.mockImplementation(async () => snapshot(7, 1001));
  clock.mock.mockImplementation(() => performance.now() + 101);
  await provider.pollSnapshot();
  assert.equal(messages.filter(m => m.type === 'pose').length, 0);
  read.mock.mockImplementation(async () => snapshot(7, 1002));
  clock.mock.mockImplementation(() => performance.now());
  await provider.pollSnapshot();
  assert.equal(messages.at(-2).state, 'connected');
  assert.equal(messages.at(-1).type, 'pose');
  read.mock.mockImplementation(async () => ({ ...snapshot(7, 1003), valid: false, status: 'tracking-lost' }));
  await provider.pollSnapshot();
  assert.equal(messages.at(-1).state, 'tracking-lost');
});

test('Tobii: a late read from an old session cannot control the restarted provider', async t => {
  const { provider, messages } = setup(t);
  await provider.start(7, message => messages.push(message));
  let release;
  const read = t.mock.method(desktop, 'readTobiiSnapshot', () => new Promise(resolve => { release = resolve; }));
  const pending = provider.pollSnapshot();
  read.mock.mockImplementation(async () => null);
  await provider.start(8, message => messages.push(message));
  release(snapshot(7));
  await pending;
  assert.equal(messages.filter(m => m.type === 'pose').length, 0);
  assert.equal(provider.sessionId, 8);
});

test('Tobii: stopping during startup cannot resurrect polling or publish connected', async t => {
  const { provider, messages } = setup(t);
  let release;
  t.mock.method(desktop, 'startTobii', () => new Promise(resolve => { release = resolve; }));
  const pending = provider.start(7, message => messages.push(message));
  await new Promise(resolve => setImmediate(resolve));
  await provider.stop();
  release({ success: true });
  await pending;
  assert.equal(provider.isRunning, false);
  assert.equal(provider.pollIntervalId, null);
  assert.equal(messages.some(m => m.state === 'connected'), false);
});

test('Tobii: native errors stop polling and preserve the actionable error', async t => {
  const { provider, messages } = setup(t);
  t.mock.method(desktop, 'readTobiiSnapshot', async () => ({
    sessionId: 7, valid: false, status: 'error', code: 'TOBII_DEVICE_ABSENT', message: 'Device absent'
  }));
  await provider.start(7, message => messages.push(message));
  assert.equal(provider.isRunning, false);
  assert.equal(provider.pollIntervalId, null);
  assert.equal(messages.at(-1).code, 'TOBII_DEVICE_ABSENT');
});

test('Tobii: browser preview reports unavailable without starting a stream', async t => {
  const { provider, messages } = setup(t);
  delete globalThis.window;
  await provider.start(7, message => messages.push(message));
  assert.equal(provider.isRunning, false);
  assert.equal(messages.at(-1).code, 'TOBII_HOST_UNAVAILABLE');
});

test('Tobii: every queued sample is forwarded, even when the read also reports tracking loss', async t => {
  const { provider, messages } = setup(t);
  const device = { model: 'IS5', gazePoint: true, displayArea: null };
  const deviceReads = t.mock.method(desktop, 'readTobiiDevice', async () => device);
  await provider.start(7, message => messages.push(message));
  const head = { kind: 'head', deviceTimestampUs: 10, timestampUs: 1000, valid: true, yawDeg: 1, pitchDeg: 2, rollDeg: 3,
    headX: 1, headY: 2, headZ: 600 };
  const gaze = { kind: 'gaze', deviceTimestampUs: 18, timestampUs: 1008, valid: true, gazeX: 0.5, gazeY: 0.4,
    leftEyeMm: [-30, 190, 600], rightEyeMm: null };
  t.mock.method(desktop, 'readTobiiSnapshot', async () => ({ ...snapshot(7), samples: [head, gaze], droppedSamples: 0 }));
  await provider.pollSnapshot();
  await new Promise(resolve => setImmediate(resolve));
  const batch = messages.find(m => m.type === 'samples');
  assert.equal(batch.samples.length, 2);
  assert.deepEqual(batch.samples.map(s => [s.kind, s.sequence, s.source, s.timestampSource]),
    [['head', 1, 'tobii', 'tobii-device'], ['gaze', 2, 'tobii', 'tobii-device']]);
  assert.equal(batch.samples[0].positionSpace, 'tobii-mm');
  assert.equal(batch.samples[1].positionSpace, undefined);
  assert.ok(Number.isFinite(batch.samples[1].capturedAtMs));
  // The control pose carries the number and device time of its tobii-head row, so collision rows can point at it.
  const pose = messages.find(m => m.type === 'pose').sample;
  assert.equal(pose.sequence, 1);
  assert.equal(pose.deviceTimestampUs, 10);
  assert.deepEqual(messages.find(m => m.type === 'device').device, device);

  t.mock.method(desktop, 'readTobiiSnapshot', async () => ({ ...snapshot(7, 1001), valid: false, status: 'tracking-lost',
    samples: [{ ...head, deviceTimestampUs: 40, timestampUs: 1030, valid: false, yawDeg: null }], droppedSamples: 3 }));
  await provider.pollSnapshot();
  const last = messages.filter(m => m.type === 'samples').at(-1);
  assert.equal(last.samples[0].sequence, 3);
  assert.equal(last.samples[0].valid, false);
  assert.equal(last.droppedSamples, 3);
  assert.equal(messages.at(-1).state, 'tracking-lost');
  assert.equal(deviceReads.mock.callCount(), 1);
});
