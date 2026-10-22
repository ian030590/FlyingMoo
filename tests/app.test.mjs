import test from 'node:test';
import assert from 'node:assert/strict';
import { AppController } from '../wwwroot/app.mjs';
import { HeadControlMapper } from '../wwwroot/head-control.mjs';
import { InputManager } from '../wwwroot/input.mjs';
import { GameEngine, STEP, LIMIT_X, LIMIT_Y } from '../wwwroot/game.mjs';
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
          getAttribute(name) { return this[name] ?? null; },
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
    hasActiveRun: false, lastPoseSample: null, lastPoseReceivedAt: null, currentProvider: null,
    headCenteredStart: 0, isHeadCenteredAndStable: false,
    settings: { source, webcam: { yawActive: 12, pitchActive: 10 }, tobii: {} },
    input: new InputManager(), headMapper: new HeadControlMapper(),
    webcamProvider: provider, canvas: document.getElementById('game'),
    game: new GameEngine({ getContext: () => ({ setTransform() {} }) })
  });
  app.input.setSource(source);
  return app;
}

test('app: calibration bounds follow applied sensitivity, source changes, and defaults', async t => {
  const app = createApp(t, 'webcam');
  const target = document.getElementById('gauge-target');
  app.applySettingsToMappers();
  assert.equal(target.style.width, '48px');
  assert.equal(target.style.height, '40px');

  app.settings.webcam.yawActive = 4;
  app.settings.webcam.pitchActive = 20;
  app.applySettingsToMappers();
  assert.equal(target.style.width, '16px');
  assert.equal(target.style.height, '80px');

  app.resetSettingsToDefaults();
  assert.equal(target.style.width, '48px');
  assert.equal(target.style.height, '40px');
  assert.equal(app.headMapper.config.yawActive, 12);
  assert.equal(app.headMapper.config.pitchActive, 10);

  Object.assign(app.settings.webcam, { leftActive: 25, rightActive: 25, upActive: 4, downActive: 4 });
  await app.handleSourceChange('keyboard');
  await app.handleSourceChange('webcam');
  assert.equal(target.style.width, '100px');
  assert.equal(target.style.height, '16px');
});

test('app: calibration boundaries match direction verification at min, default, and max sensitivity', t => {
  const app = createApp(t, 'webcam');
  app.calibPhase = 'directions';
  app.headMapper.setNeutralBaseline(7, -5);
  const target = document.getElementById('gauge-target');
  const pointer = document.getElementById('gauge-pointer');
  let now = 1000;

  for (const [yawActive, pitchActive] of [[4, 4], [12, 10], [25, 20]]) {
    Object.assign(app.settings.webcam, { yawActive, pitchActive });
    app.applySettingsToMappers();
    for (const [step, yawSign, pitchSign] of [['left', -1, 0], ['right', 1, 0], ['up', 0, 1], ['down', 0, -1]]) {
      for (const margin of [-0.25, 0, 0.25]) {
        const yaw = yawSign * (yawActive + margin);
        const pitch = pitchSign * (pitchActive + margin);
        const sample = { yawDeg: 7 + yaw, pitchDeg: -5 + pitch, capturedAtMs: now };
        app.headMapper.verificationStep = step;
        app.headMapper.stepStartTime = now;
        app.processCalibrationSample(sample, now);
        app.processCalibrationSample(sample, now + 500);

        const [, x, y] = pointer.style.transform.match(/translate\(calc\(-50% \+ ([-\d.]+)px\), calc\(-50% \+ ([-\d.]+)px\)\)/);
        const crossed = Math.abs(Number(x)) >= parseFloat(target.style.width) / 2 ||
          Math.abs(Number(y)) >= parseFloat(target.style.height) / 2;
        assert.equal(crossed, margin >= 0, `${step}, ${yawActive}/${pitchActive}, margin ${margin}`);
        assert.equal(app.headMapper.verificationStep === `return-${step}`, crossed);
        now += 1000;
      }
    }

    // A diagonal inside both axis thresholds must remain inside the visible neutral area.
    app.processCalibrationSample({ yawDeg: 7 + yawActive * 0.9, pitchDeg: -5 + pitchActive * 0.9 }, now);
    const [, x, y] = pointer.style.transform.match(/translate\(calc\(-50% \+ ([-\d.]+)px\), calc\(-50% \+ ([-\d.]+)px\)\)/);
    assert.ok(Math.abs(Number(x)) < parseFloat(target.style.width) / 2);
    assert.ok(Math.abs(Number(y)) < parseFloat(target.style.height) / 2);
  }
});

test('app: calibrated preview stays live and saving sensitivity resizes bounds without moving the point', t => {
  const app = createApp(t, 'webcam');
  app.state = 'calibrating';
  app.calibPhase = 'ready';
  app.headMapper.setNeutralBaseline(5, -3);
  const now = performance.now();
  app.handleProviderMessage({
    type: 'pose', sessionId: app.sessionId,
    sample: { source: 'webcam', sessionId: app.sessionId, sequence: 1, capturedAtMs: now, yawDeg: 20, pitchDeg: -15 }
  });
  const pointer = document.getElementById('gauge-pointer');
  assert.equal(pointer.style.transform, 'translate(calc(-50% + 30px), calc(-50% + 24px))');
  for (const d of ['left', 'right']) document.getElementById(`slider-${d}`).value = '25';
  for (const d of ['up', 'down']) document.getElementById(`slider-${d}`).value = '20';
  document.getElementById('camera-select').disabled = true;
  app.saveSettingsModal();
  assert.equal(document.getElementById('gauge-target').style.width, '100px');
  assert.equal(document.getElementById('gauge-target').style.height, '80px');
  assert.equal(pointer.style.transform, 'translate(calc(-50% + 30px), calc(-50% + 24px))');
});

test('app: asymmetric thresholds keep fixation at neutral and save individual sheep selections', t => {
  const app = createApp(t, 'webcam');
  Object.assign(app.settings.webcam, { leftActive: 4, rightActive: 25, upActive: 6, downActive: 18 });
  app.applySettingsToMappers();
  const target = document.getElementById('gauge-target');
  assert.equal(target.style.width, '58px');
  assert.equal(target.style.height, '48px');
  assert.equal(target.style.left, 'calc(50% + 21px)');
  assert.equal(target.style.top, 'calc(50% + 12px)');
  app.updateSettingsModalInputs();
  app.toggleSheepDirection('left');
  app.toggleSheepDirection('down');
  app.saveSettingsModal();
  assert.deepEqual(app.game.enabledSheepDirections, ['right', 'up']);
  assert.equal(app.headMapper.config.leftActive, 4);
  assert.equal(app.headMapper.config.downActive, 18);
  app.toggleSheepDirection();
  app.toggleSheepDirection();
  app.saveSettingsModal();
  assert.deepEqual(app.game.enabledSheepDirections, []);
});

for (const source of ['keyboard', 'webcam', 'tobii']) {
  test(`app: ${source} returns the cow to center when input returns to neutral`, t => {
    const app = createApp(t, source);
    let now = 100;
    let sequence = 0;
    t.mock.method(performance, 'now', () => now);
    app.state = 'play';
    app.headMapper.setNeutralBaseline(5, -3);

    const advance = (yaw, pitch) => {
      for (let frame = 0; frame < 60; frame++) {
        now += STEP * 1000;
        if (source !== 'keyboard') {
          app.handleProviderMessage({
            type: 'pose', sessionId: app.sessionId,
            sample: {
              source, sessionId: app.sessionId, sequence: ++sequence, capturedAtMs: now,
              yawDeg: 5 + yaw, pitchDeg: -3 + pitch
            }
          });
        }
        app.game.currentDirections = app.input.getSnapshot();
        app.game.step(STEP);
      }
    };

    for (const sign of [1, -1]) {
      app.game.startGame();
      app.game.spawnTimer = Infinity;
      const codes = sign > 0 ? ['KeyD', 'KeyW'] : ['KeyA', 'KeyS'];
      if (source === 'keyboard') {
        for (const code of codes) app.input.handleKeyDown({ code });
      }
      advance(sign * 18, sign * 15);
      assert.equal(app.game.cowX, sign * LIMIT_X);
      assert.equal(app.game.cowY, sign * LIMIT_Y);

      for (const code of codes) app.input.handleKeyUp({ code });
      advance(0, 0);
      assert.equal(app.game.state, 'play');
      assert.equal(app.game.cowX, 0);
      assert.equal(app.game.cowY, 0);
    }
  });
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

test('app: delayed but fresh webcam poses survive countdown and flight, then pause when delivery stops', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const app = createApp(t, 'webcam');
  let now = 1000;
  let sequence = 0;
  t.mock.method(performance, 'now', () => now);
  const frames = [];
  const originalRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => frames.push(callback);
  t.after(() => {
    if (originalRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRaf;
  });
  t.mock.method(app.game, 'tick', () => {});
  app.calibPhase = 'ready';
  app.headMapper.setNeutralBaseline(3, -4);
  const feed = () => app.handleProviderMessage({
    type: 'pose', sessionId: app.sessionId,
    sample: { source: 'webcam', sessionId: app.sessionId, sequence: ++sequence,
      capturedAtMs: now - 180, yawDeg: 3, pitchDeg: -4 }
  });
  feed();
  app.startCountdown();
  app.startMainLoop();
  for (let elapsed = 20; elapsed <= 4200; elapsed += 20) {
    now += 20;
    if (elapsed % 200 === 0) feed();
    frames.shift()(now);
    assert.notEqual(app.state, 'paused', `False interruption ${elapsed} ms into countdown/flight`);
    t.mock.timers.tick(20);
  }
  assert.equal(app.state, 'play');

  now += 251;
  frames.shift()(now);
  assert.equal(app.state, 'paused');
  assert.equal(app.game.state, 'paused');
  assert.equal(document.getElementById('btn-pause-resume').disabled, true);
});

test('app: expired or duplicate poses cannot refresh stream liveness', t => {
  const app = createApp(t, 'webcam');
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  app.state = 'paused';
  const send = (sequence, capturedAtMs) => app.handleProviderMessage({
    type: 'pose', sessionId: app.sessionId,
    sample: { source: 'webcam', sessionId: app.sessionId, sequence, capturedAtMs, yawDeg: 0, pitchDeg: 0 }
  });
  send(1, now - 180);
  assert.equal(app.lastPoseReceivedAt, 1000);
  now = 1200;
  send(1, now);
  assert.equal(app.lastPoseReceivedAt, 1000);
  send(2, now - 300);
  assert.equal(app.lastPoseReceivedAt, 1000);
  now = 1251;
  assert.equal(app.hasFreshHeadPose(), false);
  app.isHeadCenteredAndStable = true;
  app.resumeGameIfAllowed();
  assert.equal(app.state, 'paused');
});

test('app: recently received centered poses allow resume and recenter despite inference time', t => {
  const app = createApp(t, 'webcam');
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  app.state = 'paused';
  app.headMapper.setNeutralBaseline(3, -4);
  for (let sequence = 1; sequence <= 4; sequence++) {
    app.handleProviderMessage({
      type: 'pose', sessionId: app.sessionId,
      sample: { source: 'webcam', sessionId: app.sessionId, sequence,
        capturedAtMs: now - 180, yawDeg: 3, pitchDeg: -4 }
    });
    now += 200;
  }
  assert.equal(app.isHeadCenteredAndStable, true);
  assert.equal(document.getElementById('btn-pause-resume').disabled, false);
  t.mock.method(app, 'startCountdown', () => {});
  app.resumeGameIfAllowed();
  assert.equal(app.startCountdown.mock.callCount(), 1);

  app.headMapper.setNeutralBaseline(0, 0);
  app.handleRecenter();
  assert.equal(app.headMapper.neutralYaw, 3);
  assert.equal(app.headMapper.neutralPitch, -4);
});

test('webcam: worker results start the next frame without waiting for rendering or queueing duplicates', async t => {
  const originalMediaElement = globalThis.HTMLMediaElement;
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  globalThis.HTMLMediaElement = { HAVE_CURRENT_DATA: 2 };
  globalThis.createImageBitmap = async () => ({ close() {} });
  t.after(() => {
    if (originalMediaElement === undefined) delete globalThis.HTMLMediaElement;
    else globalThis.HTMLMediaElement = originalMediaElement;
    if (originalCreateImageBitmap === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = originalCreateImageBitmap;
  });
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
  await Promise.resolve();
  assert.equal(messages.at(-1), message);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, 'frame');
  assert.equal(provider.isProcessingFrame, true);
  await provider.processCurrentVideoFrame();
  assert.equal(frames.length, 1);
  provider.handleWorkerMessage({ data: { ...message, sessionId: 2 } });
  assert.equal(messages.length, 2);
  assert.equal(provider.isProcessingFrame, true);
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
