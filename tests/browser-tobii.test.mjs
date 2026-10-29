import test from 'node:test';
import assert from 'node:assert/strict';
import { desktop } from '../wwwroot/desktop.mjs';

function setGlobal(t, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  globalThis[name] = value;
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else delete globalThis[name];
  });
}

test('browser Tobii: loopback requests keep one client identity and preserve native timestamps', async t => {
  setGlobal(t, 'window', { location: { protocol: 'https:' } });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, options, body });
    const data = body.command === 'get_native_clock' ? { timestampUs: performance.now() * 1000 } :
      { sessionId: body.sessionId, timestampUs: 123456, status: 'connected', samples: [] };
    return { ok: true, json: async () => data };
  });
  assert.equal(desktop.isAvailable, false);
  assert.equal(desktop.isTobiiAvailable, true);
  await desktop.stopTobii(0);
  assert.equal(requests.length, 0);
  assert.equal((await desktop.startTobii(9)).success, true);
  assert.equal((await desktop.readTobiiSnapshot(9)).timestampUs, 123456);
  await desktop.stopTobii(9);
  assert.ok(requests.every(r => r.url === 'http://127.0.0.1:17343/command' && r.options.cache === 'no-store'
    && r.options.credentials === 'omit' && r.body.clientId === requests[0].body.clientId));
  assert.equal(requests[0].body.clientId.length, 36);
  assert.deepEqual(requests.slice(-3).map(r => r.body.command), ['start_tobii', 'read_tobii_snapshot', 'stop_tobii']);
});

test('browser Tobii: connection failure is actionable and polling releases its in-flight lock', async t => {
  setGlobal(t, 'window', { location: { protocol: 'https:' } });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Failed to fetch'); });
  const result = await desktop.startTobii(10);
  assert.equal(result.success, false);
  assert.match(result.message, /Windows.*橋接/);
  await assert.rejects(desktop.readTobiiSnapshot(10), /Failed to fetch/);
  assert.equal(desktop.inFlightSnapshot, false);
});

test('browser gaze: unknown browser chrome is never treated as a measured target', async t => {
  setGlobal(t, 'window', { location: { protocol: 'https:' }, devicePixelRatio: 2,
    screenX: 1920, screenY: 0, innerWidth: 1280, innerHeight: 720, screen: { width: 1280, height: 720 } });
  const document = { fullscreenElement: null };
  setGlobal(t, 'document', document);
  assert.equal(await desktop.getWindowGeometry(), null);
  document.fullscreenElement = {};
  const geometry = await desktop.getWindowGeometry();
  assert.equal(geometry.innerX, 3840);
  assert.equal(geometry.innerWidth, 2560);
  assert.equal(geometry.monitor.width, 2560);
  assert.equal(geometry.fullscreen, true);
});
