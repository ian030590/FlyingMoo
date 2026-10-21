import test from 'node:test';
import assert from 'node:assert/strict';
import { AppController } from '../wwwroot/app.mjs';
import { HeadControlMapper } from '../wwwroot/head-control.mjs';
import { InputManager } from '../wwwroot/input.mjs';
import { GameEngine } from '../wwwroot/game.mjs';
import { WebcamProvider } from '../wwwroot/providers/webcam.mjs';

function createApp(t, source = 'keyboard') {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        const classes = new Set(id.includes('modal') ? ['hidden'] : []);
        elements.set(id, {
          id, textContent: '', style: {}, disabled: false,
          classList: {
            add: name => classes.add(name),
            remove: name => classes.delete(name),
            contains: name => classes.has(name),
            toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }
          },
          setAttribute(name, value) { this[name] = value; if (name === 'disabled') this.disabled = true; },
          removeAttribute(name) { delete this[name]; if (name === 'disabled') this.disabled = false; },
          querySelector: () => null,
          focus() { document.activeElement = this; }
        });
      }
      return elements.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => []
  };
  globalThis.document = document;
  t.after(() => { delete globalThis.document; });
  const app = Object.create(AppController.prototype);
  const provider = {
    isRunning: false,
    async start(sessionId, onMessage) {
      this.isRunning = true;
      this.workerReady = true;
      onMessage({ type: 'status', state: 'connected', sessionId });
    },
    async stop() { this.isRunning = false; }
  };
  Object.assign(app, {
    sessionId: 1, state: 'title', calibPhase: 'neutral', calibPhaseStartedAt: 0, countdownTimer: null,
    hasActiveRun: false, lastPoseSample: null, currentProvider: null,
    headCenteredStart: 0, isHeadCenteredAndStable: false,
    settings: { source, webcam: { yawActive: 12, pitchActive: 10 }, tobii: {} },
    input: new InputManager(), headMapper: new HeadControlMapper(),
    webcamProvider: provider, canvas: document.getElementById('game'),
    game: new GameEngine({ getContext: () => ({ setTransform() {} }) })
  });
  app.input.setSource(source);
  return app;
}

test('app: resume keeps the current run, score, position, and obstacles', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const app = createApp(t);
  app.game.startGame();
  Object.assign(app.game, { runTime: 20, dodged: 7, position: 500, sheep: [{ z: 900 }] });
  app.hasActiveRun = true;
  app.state = 'play';
  app.pauseGameWithReason('test');
  app.resumeGameIfAllowed();
  t.mock.timers.tick(3600);
  assert.equal(app.state, 'play');
  assert.equal(app.game.runTime, 20);
  assert.equal(app.game.dodged, 7);
  assert.equal(app.game.position, 500);
  assert.deepEqual(app.game.sheep, [{ z: 900 }]);
});

test('app: cancelled countdown cannot start after returning to the menu', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const app = createApp(t);
  app.startCountdown();
  t.mock.timers.tick(900);
  app.pauseGameWithReason('cancel');
  assert.equal(app.state, 'paused');
  app.returnToTitle();
  t.mock.timers.tick(10000);
  assert.equal(app.state, 'title');
  assert.notEqual(app.game.state, 'play');
  assert.equal(app.countdownTimer, null);
});

test('app: webcam messages complete neutral and all four direction checks', async t => {
  const app = createApp(t, 'webcam');
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  await app.beginGameFlow();
  assert.equal(app.state, 'calibrating');
  let sequence = 0;
  const feed = (yawDeg, pitchDeg, frames = 65) => {
    for (let i = 0; i < frames; i++) {
      now += 1000 / 30;
      app.handleProviderMessage({
        type: 'pose', sessionId: app.sessionId,
        sample: { source: 'webcam', sessionId: app.sessionId, sequence: ++sequence, capturedAtMs: now, yawDeg, pitchDeg }
      });
    }
  };
  feed(0, 0);
  assert.equal(app.calibPhase, 'directions');
  for (const [yaw, pitch] of [[0, 15], [0, 0], [0, -15], [0, 0], [-15, 0], [0, 0], [15, 0], [0, 0]]) feed(yaw, pitch, 18);
  assert.equal(app.calibPhase, 'ready');
  assert.equal(document.getElementById('btn-calib-start').classList.contains('hidden'), false);
  assert.equal(app.headMapper.isCalibrated, true);
});

test('app: camera failure is visible and retry starts a new session', async t => {
  const app = createApp(t, 'webcam');
  await app.beginGameFlow();
  const failedSession = app.sessionId;
  app.handleProviderMessage({ type: 'status', sessionId: failedSession, state: 'error', code: 'CAMERA_PERMISSION_DENIED' });
  assert.equal(app.state, 'calibrating');
  assert.equal(app.calibPhase, 'error');
  assert.match(document.getElementById('calib-status-msg').textContent, /權限.*拒絕/);
  assert.equal(app.currentProvider, null);
  app.restartCalibration();
  await Promise.resolve();
  assert.equal(app.calibPhase, 'waiting');
  assert.ok(app.sessionId > failedSession);
  app.fallbackToKeyboard();
  assert.equal(app.state, 'title');
  assert.equal(app.settings.source, 'keyboard');
});

test('app: source changes update the HUD and stale sessions are ignored', async t => {
  const app = createApp(t);
  await app.handleSourceChange('webcam');
  assert.match(document.getElementById('hud-source-badge').textContent, /攝影機/);
  app.handleProviderMessage({ type: 'pose', sessionId: app.sessionId - 1, sample: {} });
  assert.equal(app.lastPoseSample, null);
  await app.handleSourceChange('tobii');
  assert.equal(app.settings.source, 'webcam');
  await app.handleSourceChange('keyboard');
  assert.match(document.getElementById('hud-source-badge').textContent, /鍵盤/);
});

test('app: stale head pose cannot unlock resume or overwrite the neutral point', t => {
  const app = createApp(t, 'webcam');
  app.state = 'paused';
  app.hasActiveRun = true;
  app.isHeadCenteredAndStable = true;
  app.lastPoseSample = { capturedAtMs: performance.now() - 1000, yawDeg: 20, pitchDeg: 10 };
  app.handleRecenter();
  assert.equal(app.headMapper.neutralYaw, 0);
  app.resumeGameIfAllowed();
  assert.equal(app.state, 'paused');
});

test('webcam: worker pose reaches the controller and waits for model readiness', async t => {
  const provider = new WebcamProvider();
  const messages = [];
  const frames = [];
  provider.sessionId = 3;
  provider.isRunning = true;
  provider.video = { readyState: 2, currentTime: 1 };
  provider.worker = { postMessage: message => frames.push(message) };
  provider.onMessageCallback = message => messages.push(message);
  await provider.processCurrentVideoFrame();
  assert.equal(frames.length, 0);
  provider.handleWorkerMessage({ data: { type: 'status', state: 'ready', sessionId: 3 } });
  assert.equal(provider.workerReady, true);
  const message = { type: 'pose', sessionId: 3, sample: { sessionId: 3 } };
  provider.isProcessingFrame = true;
  provider.handleWorkerMessage({ data: message });
  assert.equal(messages.at(-1), message);
  assert.equal(provider.isProcessingFrame, false);
  provider.handleWorkerMessage({ data: { ...message, sessionId: 2 } });
  assert.equal(messages.length, 2);
});

test('app: camera acquisition updates permission and model-ready replaces the permission prompt', async t => {
  const app = createApp(t, 'webcam');
  await app.beginGameFlow();
  app.handleProviderMessage({ type: 'status', state: 'camera-ready', sessionId: app.sessionId });
  assert.match(document.getElementById('camera-perm-status').textContent, /已允許/);
  app.handleProviderMessage({ type: 'status', state: 'connected', sessionId: app.sessionId });
  assert.doesNotMatch(document.getElementById('calib-status-msg').textContent, /允許相機存取/);
});

test('app: neutral collection starts at the first valid face sample after slow startup', async t => {
  const app = createApp(t, 'webcam');
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  await app.beginGameFlow();
  now = 9000;
  app.handleProviderMessage({
    type: 'pose', sessionId: app.sessionId,
    sample: { source: 'webcam', sessionId: app.sessionId, sequence: 1, capturedAtMs: now, yawDeg: 2, pitchDeg: -4 }
  });
  assert.equal(app.headMapper.calibStartTime, now);
  assert.equal(app.headMapper.calibSamples.length, 1);
  assert.doesNotMatch(document.getElementById('calib-status-msg').textContent, /校正失敗|取樣不足/);
});

test('webcam: capture continues when video-frame callbacks do not fire', t => {
  const callbacks = [];
  globalThis.requestAnimationFrame = callback => { callbacks.push(callback); return callbacks.length; };
  t.after(() => { delete globalThis.requestAnimationFrame; });
  const provider = new WebcamProvider();
  provider.isRunning = true;
  provider.video = { requestVideoFrameCallback: () => 1 };
  let captured = 0;
  provider.processCurrentVideoFrame = () => { captured++; };
  provider.scheduleNextFrame();
  assert.equal(callbacks.length, 1);
  callbacks.shift()(0);
  callbacks.shift()(16);
  assert.equal(captured, 2);
  provider.isRunning = false;
});

test('app: model startup and direction verification do not consume the neutral sampling timeout', async t => {
  const app = createApp(t, 'webcam');
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  app.webcamProvider.start = async () => { app.webcamProvider.isRunning = true; };
  await app.beginGameFlow();
  app.checkCalibrationTimeout(15100);
  assert.equal(app.calibPhase, 'starting');
  now = 15100;
  app.handleProviderMessage({ type: 'status', state: 'connected', sessionId: app.sessionId });
  app.checkCalibrationTimeout(17100);
  assert.equal(app.calibPhase, 'waiting');
  app.calibPhase = 'directions';
  app.calibPhaseStartedAt = now;
  app.checkCalibrationTimeout(30100);
  assert.equal(app.calibPhase, 'directions');
});
