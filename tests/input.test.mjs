/**
 * @file input.test.mjs
 * Unit tests for InputManager arbitration and per-axis takeover.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { InputManager } from '../wwwroot/input.mjs';

test('InputManager: initial state produces all false directions', () => {
  const input = new InputManager();
  const snap = input.getSnapshot();
  assert.deepEqual(snap, { up: false, down: false, left: false, right: false });
});

test('InputManager: arrow keys activate corresponding directions', () => {
  const input = new InputManager();

  input.handleKeyDown({ code: 'ArrowUp' });
  assert.deepEqual(input.getSnapshot(), { up: true, down: false, left: false, right: false });

  input.handleKeyDown({ code: 'ArrowRight' });
  assert.deepEqual(input.getSnapshot(), { up: true, down: false, left: false, right: true });

  input.handleKeyUp({ code: 'ArrowUp' });
  assert.deepEqual(input.getSnapshot(), { up: false, down: false, left: false, right: true });
});

test('InputManager: WASD keys act as aliases', () => {
  const input = new InputManager();

  input.handleKeyDown({ code: 'KeyW' });
  assert.equal(input.getSnapshot().up, true);

  input.handleKeyDown({ code: 'KeyA' });
  assert.equal(input.getSnapshot().left, true);

  input.handleKeyUp({ code: 'KeyW' });
  assert.equal(input.getSnapshot().up, false);
  assert.equal(input.getSnapshot().left, true);
});

test('InputManager: simultaneous opposite keys cancel out to neutral', () => {
  const input = new InputManager();

  // Press both Up and Down
  input.handleKeyDown({ code: 'ArrowUp' });
  input.handleKeyDown({ code: 'ArrowDown' });
  let snap = input.getSnapshot();
  assert.equal(snap.up, false);
  assert.equal(snap.down, false);

  // Release Down, Up should immediately become active
  input.handleKeyUp({ code: 'ArrowDown' });
  snap = input.getSnapshot();
  assert.equal(snap.up, true);
  assert.equal(snap.down, false);

  // Press both Left and Right
  input.handleKeyDown({ code: 'KeyA' });
  input.handleKeyDown({ code: 'KeyD' });
  snap = input.getSnapshot();
  assert.equal(snap.left, false);
  assert.equal(snap.right, false);
});

test('InputManager: alias key release does not clobber other held key', () => {
  const input = new InputManager();

  // Hold both ArrowUp and KeyW
  input.handleKeyDown({ code: 'ArrowUp' });
  input.handleKeyDown({ code: 'KeyW' });
  assert.equal(input.getSnapshot().up, true);

  // Release KeyW; ArrowUp is still held
  input.handleKeyUp({ code: 'KeyW' });
  assert.equal(input.getSnapshot().up, true);

  // Release ArrowUp
  input.handleKeyUp({ code: 'ArrowUp' });
  assert.equal(input.getSnapshot().up, false);
});

test('InputManager: per-axis takeover between keyboard and head control', () => {
  const input = new InputManager();
  input.setSource('webcam');

  // Head control indicates moving right and up
  input.setHeadDirections({ up: true, down: false, left: false, right: true });
  let snap = input.getSnapshot();
  assert.deepEqual(snap, { up: true, down: false, left: false, right: true });

  // Player presses KeyA (left) on keyboard -> overrides horizontal axis to LEFT,
  // but vertical axis remains UP from head control!
  input.handleKeyDown({ code: 'KeyA' });
  snap = input.getSnapshot();
  assert.deepEqual(snap, { up: true, down: false, left: true, right: false });

  // Release KeyA -> horizontal returns to head control (right)
  input.handleKeyUp({ code: 'KeyA' });
  snap = input.getSnapshot();
  assert.deepEqual(snap, { up: true, down: false, left: false, right: true });
});

test('InputManager: reset clears all directions', () => {
  const input = new InputManager();
  input.setSource('tobii');
  input.handleKeyDown({ code: 'ArrowUp' });
  input.setHeadDirections({ up: false, down: false, left: true, right: false });

  input.reset();
  const snap = input.getSnapshot();
  assert.deepEqual(snap, { up: false, down: false, left: false, right: false });
});
