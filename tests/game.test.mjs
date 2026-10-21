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
  COW_W,
  COW_H,
  SHEEP_W,
  SHEEP_H
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

test('game: speed ramp formula scales with survival time', () => {
  const game = new GameEngine(createMockCanvas());
  game.startGame();

  // At start
  assert.equal(game.speed, SPEED_BASE);

  // Advance 70 seconds (clear sheep so collision does not stop runTime)
  for (let s = 0; s < 70 * 60; s++) {
    game.sheep = [];
    game.step(STEP);
  }

  // At 70s, speed should be SPEED_BASE * (1 + 1.0) = 2 * SPEED_BASE
  assert.ok(Math.abs(game.speed - SPEED_BASE * 2.0) < 5.0);
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

  // Pause game
  game.pauseGame();
  assert.equal(game.state, 'paused');

  // Simulate tick while paused
  game.tick(1500, { up: true, down: false, left: false, right: true });

  assert.equal(game.position, savedPos);
  assert.equal(game.runTime, savedRunTime);
  assert.equal(game.spawnTimer, savedSpawnTimer);

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
