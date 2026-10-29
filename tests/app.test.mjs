import test from 'node:test';
import assert from 'node:assert/strict';
import { AppController } from '../wwwroot/app.mjs';
import { HeadControlMapper } from '../wwwroot/head-control.mjs';
import { InputManager } from '../wwwroot/input.mjs';
import { GameEngine, STEP, LIMIT_X, LIMIT_Y } from '../wwwroot/game.mjs';
import { WebcamProvider } from '../wwwroot/providers/webcam.mjs';
import { desktop } from '../wwwroot/desktop.mjs';
import { FixationStats } from '../wwwroot/gaze-target.mjs';
import { CSV_COLUMNS, SessionRecorder } from '../wwwroot/session-recorder.mjs';

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
    fixationStats: new FixationStats(), hudText: new Map(), windowGeometry: null, geometryRequestedAt: -Infinity,
    tobiiDevice: null, tobiiDroppedSamples: 0, lastEyePosition: null,
    settings: { source, webcam: { yawActive: 12, pitchActive: 10 }, tobii: {} },
    input: new InputManager(), headMapper: new HeadControlMapper(),
    webcamProvider: provider, tobiiProvider: { ...provider }, canvas: document.getElementById('game'),
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

for (const source of ['webcam', 'tobii']) {
test(`app: ${source} messages complete neutral and all four direction checks`, async t => {
  const app = createApp(t, source);
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  await app.beginGameFlow({ calibrate: true });
  assert.equal(app.state, 'calibrating');
  let sequence = 0;
  const feed = (yawDeg, pitchDeg, frames = 65) => {
    for (let i = 0; i < frames; i++) {
      now += 1000 / 30;
      app.handleProviderMessage({
        type: 'pose', sessionId: app.sessionId,
        sample: { source, sessionId: app.sessionId, sequence: ++sequence, capturedAtMs: now, yawDeg, pitchDeg }
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
}

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

for (const source of ['webcam', 'tobii']) {
test(`app: ${source} collision restart keeps the neutral point and skips calibration`, async t => {
  const app = createApp(t, source);
  app.neutralSource = source === 'webcam' ? 'webcam:' : 'tobii';
  app.headMapper.setNeutralBaseline(7, -3);
  app.handleGameOver({ mode: 'endless', reason: 'collision', runTime: 1, dodged: 0, bestTime: 1, bestDodge: 0 });
  assert.equal(app.state, 'dead');
  const calibration = t.mock.method(app.headMapper, 'startCalibration');
  const countdown = t.mock.method(app, 'startCountdown', () => { app.state = 'countdown'; });
  await app.beginGameFlow();
  assert.equal(countdown.mock.callCount(), 0);
  const now = performance.now();
  app.handleProviderMessage({ type: 'pose', sessionId: app.sessionId, sample: {
    source, sessionId: app.sessionId, sequence: 1, capturedAtMs: now, yawDeg: 9, pitchDeg: -2
  } });
  assert.equal(calibration.mock.callCount(), 0);
  assert.equal(countdown.mock.callCount(), 1);
  assert.equal(app.headMapper.neutralYaw, 7);
  assert.equal(app.headMapper.neutralPitch, -3);
});
}

test('app: direct start waits for a valid pose, establishes neutral once, and manual calibration stays available', async t => {
  const app = createApp(t, 'webcam');
  const countdown = t.mock.method(app, 'startCountdown', () => { app.state = 'countdown'; });
  await app.beginGameFlow();
  const feed = (sequence, valid, yawDeg = 8) => {
    const now = performance.now();
    app.handleProviderMessage({ type: 'pose', sessionId: app.sessionId, sample: {
      source: 'webcam', sessionId: app.sessionId, sequence, capturedAtMs: now, yawDeg, pitchDeg: -4, valid
    } });
  };
  feed(1, false);
  assert.equal(countdown.mock.callCount(), 0);
  assert.equal(app.headMapper.isCalibrated, false);
  feed(2, true);
  assert.equal(countdown.mock.callCount(), 1);
  assert.equal(app.headMapper.neutralYaw, 8);
  feed(3, true, 15);
  assert.equal(app.headMapper.neutralYaw, 8);
  await app.beginGameFlow({ calibrate: true });
  feed(1, true);
  assert.equal(app.state, 'calibrating');
  assert.equal(app.calibPhase, 'neutral');
  assert.equal(app.headMapper.isCalibrated, false);
  assert.equal(countdown.mock.callCount(), 1);
});

for (const source of ['webcam', 'tobii']) {
test(`app: a different ${source === 'webcam' ? 'camera' : 'source'} cannot inherit another device's neutral point`, async t => {
  const app = createApp(t, source);
  app.neutralSource = 'webcam:camera-a';
  if (source === 'webcam') app.settings.webcam.preferredDeviceId = 'camera-b';
  app.headMapper.setNeutralBaseline(40, 20);
  t.mock.method(app, 'startCountdown', () => { app.state = 'countdown'; });
  await app.beginGameFlow();
  assert.equal(app.headMapper.isCalibrated, false);
  app.handleProviderMessage({ type: 'pose', sessionId: app.sessionId, sample: {
    source, sessionId: app.sessionId, sequence: 1, capturedAtMs: performance.now(), yawDeg: 3, pitchDeg: -2
  } });
  assert.equal(app.headMapper.neutralYaw, 3);
  assert.equal(app.headMapper.neutralPitch, -2);
});
}

test('app: source changes update the HUD and stale sessions are ignored', async t => {
  const app = createApp(t);
  await app.handleSourceChange('webcam');
  assert.match(document.getElementById('hud-source-badge').textContent, /攝影機/);
  app.handleProviderMessage({ type: 'pose', sessionId: app.sessionId - 1, sample: {} });
  assert.equal(app.lastPoseSample, null);
  await app.handleSourceChange('tobii');
  assert.equal(app.settings.source, 'webcam');
  t.mock.getter(desktop, 'isAvailable', () => true);
  await app.handleSourceChange('tobii');
  assert.equal(app.settings.source, 'tobii');
  assert.match(document.getElementById('hud-source-badge').textContent, /Tobii/);
  await app.handleSourceChange('keyboard');
  assert.match(document.getElementById('hud-source-badge').textContent, /鍵盤/);
});

test('app: Tobii calibration uses its own readiness and records the session CSV', async t => {
  const app = createApp(t, 'tobii');
  let starts = 0, rows = 0;
  app.recorder = { async start() { starts++; }, async finish() {}, record() { rows++; } };
  app.webcamProvider.workerReady = false;
  await app.beginGameFlow();
  assert.equal(app.currentProvider, app.tobiiProvider);
  assert.equal(app.calibPhase, 'waiting');
  assert.match(document.getElementById('camera-perm-status').textContent, /Tobii 已連接/);
  app.calibPhase = 'directions';
  app.restartCalibration();
  assert.equal(app.calibPhase, 'waiting');
  // Control samples are covered by the raw tobii-head rows; other events are still recorded.
  app.recordPose({ source: 'tobii' }, performance.now(), true);
  assert.equal(starts, 1);
  assert.equal(rows, 0);
  app.recordPose({ source: 'tobii' }, performance.now(), true, '', 'collision', { id: 3 });
  assert.equal(rows, 1);
  app.handleProviderMessage({ type: 'status', sessionId: app.sessionId, state: 'error', code: 'TOBII_DEVICE_ABSENT' });
  assert.equal(app.calibPhase, 'error');
  assert.match(document.getElementById('calib-status-msg').textContent, /Eye Tracker 5/);
  assert.equal(document.getElementById('btn-calib-recenter').textContent, '重試 Tobii');
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
  await app.beginGameFlow({ calibrate: true });
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

function parseCsv(line) {
  return [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)|(?<=,)(?=,|$)/g)].map(m => m[1]?.replaceAll('""', '"') ?? '');
}

test('app: Tobii head and gaze samples become CSV rows with fixation on the cross and a session summary', async t => {
  const app = createApp(t, 'tobii');
  const calls = [];
  app.recorder = new SessionRecorder({ isAvailable: true, async invoke(command, args) {
    calls.push({ command, args });
    if (command === 'start_recording') return { id: 'tobii', path: 'tobii.csv' };
  } });
  t.after(() => clearInterval(app.recorder.timer));
  await app.recorder.start();
  app.state = 'play';
  app.sessionStartedAt = '2026-10-22T00:00:00.000Z';
  app.settings.tobii = { fixationToleranceDeg: 2 };
  // 300 × 200 mm display shown at 1500 × 1000 px; eyes 600 mm in front of its center.
  app.windowGeometry = { innerX: 0, innerY: 0, monitor: { x: 0, y: 0, width: 1500, height: 1000 } };
  app.handleProviderMessage({ type: 'device', sessionId: app.sessionId, device: {
    model: 'IS5_Large_Eyetracker_5', gazePoint: true, gazeOrigin: true, outputFrequencyHz: 33,
    displayArea: { topLeftMm: [-150, 200, 0], topRightMm: [150, 200, 0], bottomLeftMm: [-150, 0, 0] } } });
  app.getFixationTarget = () => ({ x: 750, y: 500, visible: app.state === 'play' });
  const degrees = d => 0.5 + 600 * Math.tan(d * Math.PI / 180) / 300;
  const now = performance.now();
  const gaze = (sequence, gazeX, eyes = true) => ({ kind: 'gaze', source: 'tobii', sequence, capturedAtMs: now, deviceTimestampUs: sequence,
    valid: true, gazeX, gazeY: 0.5, leftEyeMm: eyes ? [-30, 100, 600] : null, rightEyeMm: eyes ? [30, 100, 600] : null });
  app.input.setHeadDirections({ left: true });
  app.handleProviderMessage({ type: 'samples', sessionId: app.sessionId, droppedSamples: 0, samples: [
    { kind: 'head', source: 'tobii', sequence: 1, capturedAtMs: now, deviceTimestampUs: 1, valid: true,
      yawDeg: -15, pitchDeg: 0, rollDeg: 1, headX: 0, headY: 100, headZ: 600, positionSpace: 'tobii-mm' },
    gaze(2, degrees(1)),
    gaze(3, degrees(4)),
    // No eyes in this frame: the previous eye position (same capture time) is reused.
    gaze(4, degrees(1.5), false),
    { kind: 'gaze', source: 'tobii', sequence: 5, capturedAtMs: now, deviceTimestampUs: 5, valid: false, gazeX: null, gazeY: null }
  ] });
  const summary = app.fixationStats.summary();
  assert.equal(summary.gazeSamples, 4);
  assert.equal(summary.measuredSamples, 3);
  assert.equal(summary.onTargetRatio, 2 / 3);
  assert.equal(summary.headTurningOnTargetRatio, 2 / 3);
  assert.equal(document.getElementById('hud-gaze').textContent, '67%');

  app.state = 'calibrating';
  app.handleProviderMessage({ type: 'samples', sessionId: app.sessionId, droppedSamples: 2, samples: [gaze(6, degrees(1))] });
  assert.equal(app.fixationStats.summary().gazeSamples, 4, 'only flight counts toward fixation');
  assert.match(document.getElementById('gaze-check-status').textContent, /遺失 2 筆/);

  await app.finishRecording('menu');
  const rows = calls.find(c => c.command === 'append_recording').args.rows.trim().split('\r\n').map(parseCsv)
    .map(values => Object.fromEntries(CSV_COLUMNS.map((c, i) => [c, values[i]])));
  assert.deepEqual(rows.map(r => r.event), ['tobii-head', 'tobii-gaze', 'tobii-gaze', 'tobii-gaze', 'tobii-gaze', 'tobii-gaze']);
  assert.equal(rows[0].yaw_deg, '-15');
  assert.equal(rows[0].head_directions, 'left');
  assert.equal(rows[1].gaze_error_deg, '1');
  assert.equal(rows[1].gaze_on_target, 'true');
  assert.equal(rows[1].gaze_x_px, String(Math.round(degrees(1) * 15000) / 10));
  assert.equal(rows[1].target_x_px, '750');
  assert.equal(rows[1].left_eye_z_mm, '600');
  assert.equal(rows[2].gaze_error_deg, '4');
  assert.equal(rows[2].gaze_on_target, 'false');
  assert.equal(rows[3].left_eye_valid, 'false');
  assert.equal(rows[3].gaze_error_deg, '1.5');
  assert.equal(rows[4].valid, 'false');
  assert.equal(rows[4].invalid_reason, 'tobii-gaze-invalid');
  assert.equal(rows[4].gaze_on_target, '');
  assert.equal(rows[5].state, 'calibrating');
  assert.equal(rows[5].tobii_dropped_samples, '2');
  assert.equal(rows[1].fixation_tolerance_deg, '2');

  const metadata = JSON.parse(calls.find(c => c.command === 'finish_recording').args.metadata);
  assert.equal(metadata.endReason, 'menu');
  assert.equal(metadata.source, 'tobii');
  assert.equal(metadata.fixation.toleranceDeg, 2);
  assert.equal(metadata.fixation.onTargetRatio, 2 / 3);
  assert.equal(metadata.tobii.device.model, 'IS5_Large_Eyetracker_5');
  assert.equal(metadata.tobii.droppedSamples, 2);
  assert.equal(metadata.display.check.matches, true);
  assert.deepEqual(metadata.practice, { mode: 'endless', speed: 1, durationMin: 3, accelPercent: 86 });
});

test('app: practice settings from the form drive the next run, title summary and result screen', t => {
  const app = createApp(t, 'keyboard');
  app.updateSettingsModalInputs();
  document.getElementById('practice-mode-timed').checked = true;
  document.getElementById('slider-speed').value = '1.5';
  document.getElementById('slider-duration').value = '2';
  app.updatePracticeLabels();
  assert.equal(document.getElementById('val-speed-travel').textContent, '羊從出現到飛抵約 2.2 秒');
  assert.equal(document.getElementById('row-accel').classList.contains('hidden'), true);
  app.saveSettingsModal();
  assert.deepEqual(app.settings.practice, { mode: 'timed', speed: 1.5, durationMin: 2, accelPercent: 86 });
  assert.equal(document.getElementById('practice-summary').textContent, '練習模式：計時 2 分鐘 · 固定速度 1.5×');

  app.enterPlaying();
  assert.equal(app.game.practice.mode, 'timed');
  assert.equal(document.getElementById('hud-time-label').textContent, '剩餘:');
  assert.equal(document.getElementById('hud-time').textContent, '02:00.00');
  assert.equal(document.getElementById('hud-hits-row').classList.contains('hidden'), false);

  app.handleGameOver({ reason: 'time-up', mode: 'timed', runTime: 120, dodged: 9, hits: 2, speedMultiplier: 1.5,
    bestTime: 0, bestDodge: 0, isNewRecord: false });
  assert.equal(document.getElementById('dead-title').textContent, '練習完成！');
  assert.equal(document.getElementById('dead-run-label').textContent, '練習時間:');
  assert.equal(document.getElementById('dead-hits').textContent, '2 次');
  assert.equal(document.getElementById('dead-speed').textContent, '1.5×');
  assert.equal(document.getElementById('dead-best-row').classList.contains('hidden'), true);
  assert.equal(document.getElementById('dead-gaze-row').classList.contains('hidden'), true);

  app.resetSettingsToDefaults();
  assert.deepEqual(app.settings.practice, { mode: 'endless', speed: 1, durationMin: 3, accelPercent: 86 });
});
