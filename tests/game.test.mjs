/**
 * @file game.test.mjs
 * Unit tests for GameEngine fixed 60Hz accumulator stepping, speed scaling,
 * boundary clamping, and pause isolation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GameEngine,
  STEP,
  SPEED_BASE,
  LIMIT_X,
  LIMIT_Y,
  MOVE_SPEED,
  COW_W,
  COW_H,
  SHEEP_W,
  SHEEP_H,
  PRACTICE_DEFAULTS,
  normalizePractice,
  sheepTravelSeconds
} from '../wwwroot/game.mjs';

function createMockCanvas() {
  const ctx = {
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: () => {},
    setTransform: () => {},
    beginPath: () => {},
    arc: () => {},
    fill: () => {},
    stroke: () => {},
    fillRect: () => {},
    strokeRect: () => {},
    fillText: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
    globalAlpha: 1
  };
  return {
    getContext: () => ctx,
    width: 480,
    height: 360
  };
}

test('game: sheep spawn only in enabled directions and none means no obstacles', () => {
  const game = new GameEngine(createMockCanvas());
  const coordinates = { up: [0, 0.4], down: [0, -0.4], left: [-0.4, 0], right: [0.4, 0] };
  const ids = new Set();
  for (const direction of Object.keys(coordinates)) {
    game.enabledSheepDirections = [direction];
    for (let i = 0; i < 10; i++) {
      game.sheep = [];
      game.spawnSheep();
      const sheep = game.sheep[0];
      assert.equal(sheep.direction, direction);
      assert.deepEqual([sheep.x, sheep.y], coordinates[direction]);
      assert.equal(ids.has(sheep.id), false);
      ids.add(sheep.id);
    }
  }
  game.sheep = [];
  game.enabledSheepDirections = [];
  game.spawnSheep();
  assert.equal(game.sheep.length, 0);
});

test('game: collision callback captures the colliding sheep before game-over saving', () => {
  const events = [];
  const game = new GameEngine(createMockCanvas(), {
    onCollision: sheep => events.push(['collision', sheep.id]),
    onDie: () => events.push(['finished'])
  });
  game.startGame();
  game.spawnTimer = Infinity;
  game.sheep = [{ id: 7, x: 0, y: 0, z: game.speed * STEP, alive: true }];
  game.step(STEP);
  assert.deepEqual(events, [['collision', 7], ['finished']]);
  assert.equal(game.state, 'dead');
});

test('game: glow is rasterized once at full canvas resolution and rebuilt after resize', t => {
  const previous = globalThis.OffscreenCanvas;
  const surfaces = [];
  let filteredDraws = 0;
  globalThis.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; surfaces.push(this); }
    getContext() { return { scale() {}, drawImage() { filteredDraws++; } }; }
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.OffscreenCanvas;
    else globalThis.OffscreenCanvas = previous;
  });
  const canvas = createMockCanvas();
  canvas.getContext().drawImage = () => {};
  const game = new GameEngine(canvas);
  canvas.height = 1080;
  const image = { src: 'cow.png' };
  game.drawGlowingSprite(image, 0, 0, 150, 100);
  game.drawGlowingSprite(image, 0, 0, 150, 100);
  assert.equal(filteredDraws, 1);
  assert.ok(surfaces[0].width >= 150 * 3);
  assert.ok(surfaces[0].height >= 100 * 3);
  game.fitCanvas();
  game.drawGlowingSprite(image, 0, 0, 150, 100);
  assert.equal(filteredDraws, 2);
});

test('game: high-DPI rendering stays within the webcam frame budget without changing logical coordinates', t => {
  const originalWindow = globalThis.window;
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  globalThis.window = { innerWidth: 1800, innerHeight: 1200, devicePixelRatio: 2.25 };
  const canvas = createMockCanvas();
  const game = new GameEngine(canvas);
  assert.equal(canvas.height, 1080);
  assert.equal(canvas.width / canvas.height, 1.5);
  const logicalWidth = game.W;
  window.devicePixelRatio = 1;
  window.innerWidth = 900;
  window.innerHeight = 600;
  game.fitCanvas();
  assert.equal(canvas.height, 600);
  assert.equal(canvas.width, 900);
  assert.equal(game.W, logicalWidth);
});

test('game: fixed 60Hz accumulator runs identical 60 simulation steps across 30Hz, 60Hz, 120Hz', () => {
  // Test 30Hz (33.33ms frames)
  const g30 = new GameEngine(createMockCanvas());
  g30.startGame();
  let now = g30.lastFrameTime;
  for (let f = 0; f < 30; f++) {
    now += 1000 / 30;
    g30.sheep = [];
    g30.tick(now, { up: false, down: false, left: false, right: false });
  }

  // Test 60Hz (16.67ms frames)
  const g60 = new GameEngine(createMockCanvas());
  g60.startGame();
  now = g60.lastFrameTime;
  for (let f = 0; f < 60; f++) {
    now += 1000 / 60;
    g60.sheep = [];
    g60.tick(now, { up: false, down: false, left: false, right: false });
  }

  // Test 120Hz (8.33ms frames)
  const g120 = new GameEngine(createMockCanvas());
  g120.startGame();
  now = g120.lastFrameTime;
  for (let f = 0; f < 120; f++) {
    now += 1000 / 120;
    g120.sheep = [];
    g120.tick(now, { up: false, down: false, left: false, right: false });
  }

  // Check that all simulations advanced to within 1 frame (1/60s) of 1.0 second
  assert.ok(Math.abs(g30.runTime - 1.0) < 0.035, `30Hz runtime: ${g30.runTime}`);
  assert.ok(Math.abs(g60.runTime - 1.0) < 0.02, `60Hz runtime: ${g60.runTime}`);
  assert.ok(Math.abs(g120.runTime - 1.0) < 0.02, `120Hz runtime: ${g120.runTime}`);

  // Positions along the track should be almost identical
  assert.ok(Math.abs(g30.position - g60.position) < SPEED_BASE * STEP * 2);
  assert.ok(Math.abs(g60.position - g120.position) < SPEED_BASE * STEP * 2);
});

test('game: steering clamps player position strictly to LIMIT_X and LIMIT_Y', () => {
  const game = new GameEngine(createMockCanvas());
  game.startGame();

  // Fly right and up for 10 simulated seconds (far beyond bounds)
  for (let s = 0; s < 600; s++) {
    game.step(STEP);
    game.currentDirections = { up: true, down: false, left: false, right: true };
  }

  assert.ok(game.cowX <= LIMIT_X, `cowX: ${game.cowX} exceeds LIMIT_X: ${LIMIT_X}`);
  assert.ok(game.cowY <= LIMIT_Y, `cowY: ${game.cowY} exceeds LIMIT_Y: ${LIMIT_Y}`);

  // Fly left and down for 10 simulated seconds
  for (let s = 0; s < 600; s++) {
    game.step(STEP);
    game.currentDirections = { up: false, down: true, left: true, right: false };
  }

  assert.ok(game.cowX >= -LIMIT_X, `cowX: ${game.cowX} below -LIMIT_X: ${-LIMIT_X}`);
  assert.ok(game.cowY >= -LIMIT_Y, `cowY: ${game.cowY} below -LIMIT_Y: ${-LIMIT_Y}`);
});

test('game: neutral input returns both axes to exact center without overshooting', () => {
  for (const [x, y] of [[LIMIT_X, LIMIT_Y], [-LIMIT_X, -LIMIT_Y], [0.002, -0.002], [-0.002, 0.002]]) {
    const game = new GameEngine(createMockCanvas());
    game.startGame();
    game.spawnTimer = Infinity;
    game.cowX = x;
    game.cowY = y;

    for (let frame = 0; frame < 60; frame++) {
      const previousX = game.cowX;
      const previousY = game.cowY;
      game.step(STEP);
      assert.ok(Math.abs(game.cowX) <= Math.abs(previousX));
      assert.ok(Math.abs(game.cowY) <= Math.abs(previousY));
      assert.ok(game.cowX * x >= 0);
      assert.ok(game.cowY * y >= 0);
      assert.ok(Math.abs(game.cowX - previousX) <= MOVE_SPEED * STEP + 1e-12);
      assert.ok(Math.abs(game.cowY - previousY) <= MOVE_SPEED * STEP + 1e-12);
    }

    assert.equal(game.cowX, 0);
    assert.equal(game.cowY, 0);
  }
});

test('game: a neutral axis recenters while the other axis keeps moving', () => {
  const game = new GameEngine(createMockCanvas());
  game.startGame();
  game.spawnTimer = Infinity;
  game.cowX = LIMIT_X;
  game.currentDirections = { up: true, down: false, left: false, right: false };
  game.step(STEP);
  assert.equal(game.cowX, LIMIT_X - MOVE_SPEED * STEP);
  assert.equal(game.cowY, MOVE_SPEED * STEP);

  game.cowX = 0;
  game.cowY = -LIMIT_Y;
  game.currentDirections = { up: false, down: false, left: true, right: false };
  game.step(STEP);
  assert.equal(game.cowX, -MOVE_SPEED * STEP);
  assert.equal(game.cowY, -LIMIT_Y + MOVE_SPEED * STEP);
});

test('game: endless speed rises by the set percentage per minute without a cap', () => {
  const game = new GameEngine(createMockCanvas());
  game.startGame();
  assert.equal(game.speed, SPEED_BASE);

  // Default +86% of the starting speed per minute, close to the original ramp.
  for (let s = 0; s < 60 * 60; s++) {
    game.sheep = [];
    game.step(STEP);
  }
  assert.ok(Math.abs(game.speedMultiplier - 1.86) < 0.001, String(game.speedMultiplier));

  game.configurePractice({ mode: 'endless', speed: 0.5, accelPercent: 100 });
  game.startGame();
  assert.equal(game.speedMultiplier, 0.5);
  for (let s = 0; s < 5 * 60 * 60; s++) {
    game.sheep = [];
    game.step(STEP);
  }
  // The original game stopped at 2.1x; endless keeps accelerating.
  assert.equal(game.state, 'play');
  assert.ok(Math.abs(game.speedMultiplier - 0.5 * 6) < 0.001, String(game.speedMultiplier));
});

test('game: pause state completely freezes position, runTime, and obstacles', () => {
  const game = new GameEngine(createMockCanvas());
  game.startGame();

  // Run 1 second
  for (let s = 0; s < 60; s++) {
    game.step(STEP);
  }
  const savedPos = game.position;
  const savedRunTime = game.runTime;
  const savedSpawnTimer = game.spawnTimer;
  game.cowX = LIMIT_X;
  game.cowY = -LIMIT_Y;

  // Pause game
  game.pauseGame();
  assert.equal(game.state, 'paused');

  // Simulate tick while paused
  game.tick(1500, { up: true, down: false, left: false, right: true });

  assert.equal(game.position, savedPos);
  assert.equal(game.runTime, savedRunTime);
  assert.equal(game.spawnTimer, savedSpawnTimer);
  assert.equal(game.cowX, LIMIT_X);
  assert.equal(game.cowY, -LIMIT_Y);

  game.tick(1600, { up: false, down: false, left: false, right: false });
  assert.equal(game.cowX, LIMIT_X);
  assert.equal(game.cowY, -LIMIT_Y);

  // Resume game
  game.resumeGame();
  assert.equal(game.state, 'play');
});

test('game: each newly passed sheep bleats once, including simultaneous passes', () => {
  const game = new GameEngine(createMockCanvas());
  let bleats = 0;
  game.playSheepBleat = () => bleats++;
  game.startGame();
  game.spawnTimer = Infinity;
  game.sheep = [
    { z: -100, x: 0.8, y: 0, alive: true, passed: false },
    { z: -120, x: 0.8, y: 0, alive: true, passed: false },
    { z: -140, x: 0.8, y: 0, alive: true, passed: true }
  ];
  game.step(STEP);
  assert.equal(bleats, 2);
  assert.equal(game.dodged, 2);
  for (let frame = 0; frame < 10; frame++) game.step(STEP);
  assert.equal(bleats, 2);
});

test('game: cow calls retain the opening call, 4-second delay, and 6–13-second intervals', () => {
  const game = new GameEngine(createMockCanvas());
  const calls = [];
  game.playCowMoo = () => calls.push(game.runTime);
  game.startGame();
  game.spawnTimer = Infinity;
  for (let frame = 0; frame < 25 * 60; frame++) game.step(STEP);
  assert.equal(calls[0], 0);
  assert.ok(Math.abs(calls[1] - 4) <= STEP * 1.1);
  assert.ok(calls.length >= 3);
  for (let index = 2; index < calls.length; index++) {
    const interval = calls[index] - calls[index - 1];
    assert.ok(interval >= 6 - STEP && interval <= 13 + STEP);
  }
});

test('game: recorded calls can overlap and mute applies to voices already playing', () => {
  const game = new GameEngine(createMockCanvas());
  const voices = [];
  game.cowSound = {
    cloneNode() {
      const voice = { muted: false, play: () => Promise.resolve() };
      voices.push(voice);
      return voice;
    }
  };
  game.playCowMoo();
  assert.equal(voices.length, 0);
  game.audioContext = {};
  game.playCowMoo();
  game.playCowMoo();
  assert.equal(voices.length, 2);
  assert.equal(game.activeAnimalSounds.size, 2);
  game.toggleMute();
  assert.ok(voices.every(voice => voice.muted));
  game.playCowMoo();
  assert.equal(voices.length, 2);
  game.toggleMute();
  assert.ok(voices.every(voice => !voice.muted));
  for (const voice of voices) voice.onended();
  assert.equal(game.activeAnimalSounds.size, 0);
});

test('game: practice settings are clamped and applied only when a run starts', () => {
  assert.deepEqual(normalizePractice({ mode: 'timed', speed: 9, durationMin: 0, accelPercent: 1000 }),
    { mode: 'timed', speed: 3, durationMin: 1, accelPercent: 200 });
  assert.deepEqual(normalizePractice({ speed: '1.26' }), { ...PRACTICE_DEFAULTS, speed: 1.3 });
  assert.ok(Math.abs(sheepTravelSeconds(1) - 10 / 3) < 1e-9);
  assert.ok(Math.abs(sheepTravelSeconds(2) - 5 / 3) < 1e-9);

  const game = new GameEngine(createMockCanvas());
  game.configurePractice({ mode: 'timed', speed: 1.5, durationMin: 2 });
  assert.equal(game.practice.mode, 'endless');
  game.startGame();
  assert.equal(game.practice.mode, 'timed');
  assert.equal(game.speedMultiplier, 1.5);
  game.configurePractice({ mode: 'endless', speed: 0.5 });
  game.spawnTimer = Infinity;
  for (let s = 0; s < 60 * 60; s++) game.step(STEP);
  assert.equal(game.speedMultiplier, 1.5);
});

test('game: timed practice counts collisions, keeps flying and ends when time is up', () => {
  const events = [];
  const game = new GameEngine(createMockCanvas(), {
    onCollision: sheep => events.push(['collision', sheep.id]),
    onDie: stats => events.push(['end', stats])
  });
  const bestTime = game.bestTime;
  game.configurePractice({ mode: 'timed', speed: 1, durationMin: 1 });
  game.startGame();
  game.spawnTimer = Infinity;
  game.sheep = [{ id: 7, x: 0, y: 0, z: game.speed * STEP, alive: true, passed: false }];
  game.step(STEP);
  assert.deepEqual(events, [['collision', 7]]);
  assert.equal(game.state, 'play');
  assert.equal(game.hits, 1);
  assert.equal(game.sheep[0].passed, true);
  for (let s = 0; s < 60 * 60; s++) {
    game.step(STEP);
    if (game.state !== 'play') break;
  }
  assert.equal(game.state, 'finished');
  const [, stats] = events.at(-1);
  assert.equal(stats.reason, 'time-up');
  assert.equal(stats.runTime, 60);
  assert.equal(stats.hits, 1);
  assert.equal(stats.dodged, 0);
  assert.equal(stats.isNewRecord, false);
  assert.equal(game.bestTime, bestTime);
});
