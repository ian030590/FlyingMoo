import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('pose worker: classic worker emits session-scoped poses and releases each bitmap', async () => {
  const messages = [];
  const context = vm.createContext({
    self: { postMessage: message => messages.push(message) },
    URL, Math, performance
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

test('pose worker: direct stream drops prefetched old frames, keeps full image size, and closes every frame', async () => {
  const messages = [];
  let framesClosed = 0;
  const frames = [0, 20, 90].map(ms => ({ timestamp: ms * 1000,
    displayWidth: 640, displayHeight: 480, close: () => framesClosed++ }));
  const reader = { async read() { return frames.length ? { value: frames.shift() } : { done: true }; },
    async cancel() {}, releaseLock() {} };
  const context = vm.createContext({
    self: { postMessage: message => messages.push(message) }, URL, Math,
    performance: { timeOrigin: 1000, now: () => 100 },
    createImageBitmap: async () => { throw new Error('Stream frames must reach MediaPipe without conversion'); }
  });
  vm.runInContext(await readFile(new URL('../wwwroot/providers/pose-worker.mjs', import.meta.url), 'utf8'), context);
  vm.runInContext(`currentSessionId = 7; landmarker = { detectForVideo: () => ({
    faceLandmarks: [[]], facialTransformationMatrixes: [{data: [1,0,0,0,0,1,0,0,0,0,1,0,1,2,3,1]}]
  }) };`, context);
  await context.consumeStream({ sessionId: 7, clockOriginMs: 1000, mediaClockOffsetMs: 0,
    readable: { getReader: () => reader } });
  assert.equal(framesClosed, 3);
  assert.deepEqual(messages.map(m => m.sample.capturedAtMs), [0, 90]);
  assert.deepEqual(messages.map(m => [m.sample.frameWidth, m.sample.frameHeight]), [[640, 480], [640, 480]]);
  assert.equal(messages[1].sample.headZ, 3);
  assert.equal(messages[1].sample.timestampSource, 'video-frame');
});

test('pose worker: unsupported GPU initialization retries the same model on CPU', async () => {
  const delegates = [];
  const source = (await readFile(new URL('../wwwroot/providers/pose-worker.mjs', import.meta.url), 'utf8'))
    .replace("await import('../vendor/mediapipe/vision_bundle.mjs')", 'self.vision');
  const task = { detectForVideo() {} };
  const context = vm.createContext({ URL, Math, performance, self: {
    location: { href: 'https://tauri.localhost/providers/pose-worker.mjs' },
    vision: {
      FilesetResolver: { forVisionTasks: async () => ({}) },
      FaceLandmarker: { async createFromOptions(_fileset, options) {
        delegates.push(options.baseOptions.delegate);
        assert.equal(options.numFaces, 1);
        assert.equal(options.runningMode, 'VIDEO');
        if (options.baseOptions.delegate === 'GPU') throw new Error('GPU unavailable');
        return task;
      } }
    }
  } });
  vm.runInContext(source, context);
  assert.equal(await context.initLandmarker(), task);
  assert.deepEqual(delegates, ['GPU', 'CPU']);
  assert.equal(vm.runInContext('currentDelegate', context), 'CPU');
});

test('pose worker: GPU inference failure recreates CPU task and releases the input once', async () => {
  const messages = [];
  let closed = 0;
  let gpuClosed = 0;
  const context = vm.createContext({ URL, Math, performance, self: { postMessage: m => messages.push(m) },
    gpuClose: () => gpuClosed++ });
  vm.runInContext(await readFile(new URL('../wwwroot/providers/pose-worker.mjs', import.meta.url), 'utf8'), context);
  vm.runInContext(`currentSessionId = 7; currentDelegate = 'GPU';
    landmarker = { detectForVideo() { throw Error('Context lost'); }, close: gpuClose };
    initLandmarker = async delegate => {
      if (delegate !== 'CPU') throw Error('Must fall back to CPU');
      currentDelegate = delegate;
      landmarker = { detectForVideo: () => ({ faceLandmarks: [[]],
        facialTransformationMatrixes: [{ data: [1,0,0,0,0,1,0,0,0,0,1,0,1,2,3,1] }] }) };
    };`, context);
  await context.self.onmessage({ data: { type: 'frame', bitmap: { width: 640, height: 480, close: () => closed++ },
    sessionId: 7, sequence: 1, capturedAtMs: 50 } });
  assert.equal(closed, 1);
  assert.equal(gpuClosed, 1);
  assert.equal(messages[0].sample.valid, true);
  assert.equal(messages[0].sample.inferenceDelegate, 'CPU');
  assert.equal(messages[0].sample.headZ, 3);
});
