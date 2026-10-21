import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('pose worker: classic worker emits session-scoped poses and releases each bitmap', async () => {
  const messages = [];
  const context = vm.createContext({
    self: { postMessage: message => messages.push(message) },
    URL, Math
  });
  const source = await readFile(new URL('../wwwroot/providers/pose-worker.mjs', import.meta.url), 'utf8');
  vm.runInContext(source, context);
  vm.runInContext(`
    currentSessionId = 7;
    landmarker = { detectForVideo: () => ({
      faceLandmarks: [[]],
      facialTransformationMatrixes: [{ data: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1] }]
    }) };
  `, context);
  let closed = 0;
  await context.self.onmessage({ data: { type: 'frame', bitmap: { close: () => closed++ }, sessionId: 7, sequence: 1, capturedAtMs: 50 } });
  assert.equal(closed, 1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'pose');
  assert.equal(messages[0].sessionId, 7);
  assert.equal(messages[0].sample.sessionId, 7);
  assert.equal(messages[0].sample.sequence, 1);
  assert.equal(Math.abs(messages[0].sample.yawDeg), 0);
  assert.equal(Math.abs(messages[0].sample.pitchDeg), 0);
  await context.self.onmessage({ data: { type: 'frame', bitmap: { close: () => closed++ }, sessionId: 6 } });
  assert.equal(closed, 2);
  assert.equal(messages.length, 1);
});
