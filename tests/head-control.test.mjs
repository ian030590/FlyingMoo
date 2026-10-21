/**
 * @file head-control.test.mjs
 * Unit tests for HeadControlMapper, hysteresis, confirmation timing, and neutral calibration.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HeadControlMapper,
  unwrapAngles,
  calculateMedian,
  calculateStdDev
} from '../wwwroot/head-control.mjs';

test('head-control: unwrapAngles handles phase wraps around 180', () => {
  const angles = [179, -179, -178];
  const unwrapped = unwrapAngles(angles);
  assert.equal(unwrapped[0], 179);
  assert.equal(unwrapped[1], 181);
  assert.equal(unwrapped[2], 182);
});

test('head-control: calculateMedian and calculateStdDev', () => {
  const values = [10, 11, 10, 12, 10];
  const med = calculateMedian(values);
  assert.equal(med, 10);

  const std = calculateStdDev(values, 10);
  assert.ok(std >= 0 && std <= 1.0);
});

test('head-control: deadband neutral zone produces no direction', () => {
  const mapper = new HeadControlMapper();
  mapper.setNeutralBaseline(0, 0);

  // Small wobble within 5 degrees (< 12° yaw, < 10° pitch)
  for (let t = 0; t <= 200; t += 20) {
    const res = mapper.processSample({
      sessionId: 1,
      sequence: t / 20,
      capturedAtMs: t,
      yawDeg: 4.0,
      pitchDeg: 3.0
    }, t);
    assert.deepEqual(res.directions, { up: false, down: false, left: false, right: false });
  }
});

test('head-control: 50ms candidate confirmation timer requires sustained hold', () => {
  const mapper = new HeadControlMapper();
  mapper.setNeutralBaseline(0, 0);

  // Frame 1 at t=0: Head turns right (yaw = 15° > 12°)
  let res = mapper.processSample({
    sessionId: 1,
    sequence: 1,
    capturedAtMs: 0,
    yawDeg: 15.0,
    pitchDeg: 0
  }, 0);
  // Not yet confirmed (50 ms not elapsed)
  assert.equal(res.directions.right, false);

  // Frame 2 at t=30ms: Still holding 15°
  res = mapper.processSample({
    sessionId: 1,
    sequence: 2,
    capturedAtMs: 30,
    yawDeg: 15.0,
    pitchDeg: 0
  }, 30);
  assert.equal(res.directions.right, false);

  // Frame 3 at t=60ms: > 50ms has elapsed -> RIGHT becomes active!
  res = mapper.processSample({
    sessionId: 1,
    sequence: 3,
    capturedAtMs: 60,
    yawDeg: 15.0,
    pitchDeg: 0
  }, 60);
  assert.equal(res.directions.right, true);
});

test('head-control: hysteresis release threshold maintains direction between active and release', () => {
  const mapper = new HeadControlMapper();
  mapper.setNeutralBaseline(0, 0);

  // Activate Right (yaw = 15° held for 60ms)
  mapper.processSample({ sessionId: 1, sequence: 1, capturedAtMs: 0, yawDeg: 15.0, pitchDeg: 0 }, 0);
  mapper.processSample({ sessionId: 1, sequence: 2, capturedAtMs: 60, yawDeg: 15.0, pitchDeg: 0 }, 60);
  assert.equal(mapper.getDirections().right, true);

  // Yaw drops to 9.5° (which is < 12° activation, but > 8.0° release threshold)
  // Direction should REMAIN active!
  for (let t = 80; t <= 180; t += 20) {
    const res = mapper.processSample({
      sessionId: 1,
      sequence: t / 20,
      capturedAtMs: t,
      yawDeg: 9.5,
      pitchDeg: 0
    }, t);
    assert.equal(res.directions.right, true);
  }

  // Yaw drops below 8.0° release threshold (to 3.0°) and holds until confirmed
  let res;
  for (let t = 200; t <= 360; t += 20) {
    res = mapper.processSample({
      sessionId: 1,
      sequence: t / 20,
      capturedAtMs: t,
      yawDeg: 3.0,
      pitchDeg: 0
    }, t);
  }
  assert.equal(res.directions.right, false);
});

test('head-control: opposite direction cannot be active simultaneously', () => {
  const mapper = new HeadControlMapper();
  mapper.setNeutralBaseline(0, 0);

  // Activate Right
  mapper.processSample({ sessionId: 1, sequence: 1, capturedAtMs: 0, yawDeg: 18.0, pitchDeg: 0 }, 0);
  mapper.processSample({ sessionId: 1, sequence: 2, capturedAtMs: 60, yawDeg: 18.0, pitchDeg: 0 }, 60);
  assert.equal(mapper.getDirections().right, true);

  // Quick switch to Left (-18.0°)
  // When yaw <= 0, Right immediately releases
  mapper.processSample({ sessionId: 1, sequence: 3, capturedAtMs: 80, yawDeg: -18.0, pitchDeg: 0 }, 80);
  assert.equal(mapper.getDirections().right, false);
  assert.equal(mapper.getDirections().left, false);

  // Held until t=260ms -> Left activates
  let res;
  for (let t = 100; t <= 260; t += 20) {
    res = mapper.processSample({ sessionId: 1, sequence: t / 20, capturedAtMs: t, yawDeg: -18.0, pitchDeg: 0 }, t);
  }
  assert.equal(res.directions.left, true);
  assert.equal(res.directions.right, false);
});

test('head-control: diagonal directions operate independently', () => {
  const mapper = new HeadControlMapper();
  mapper.setNeutralBaseline(0, 0);

  // Look Up and Right simultaneously
  mapper.processSample({ sessionId: 1, sequence: 1, capturedAtMs: 0, yawDeg: 16.0, pitchDeg: 14.0 }, 0);
  const res = mapper.processSample({ sessionId: 1, sequence: 2, capturedAtMs: 60, yawDeg: 16.0, pitchDeg: 14.0 }, 60);

  assert.equal(res.directions.right, true);
  assert.equal(res.directions.up, true);
  assert.equal(res.directions.left, false);
  assert.equal(res.directions.down, false);
});

test('head-control: stale sample age > 250ms triggers stale clear', () => {
  const mapper = new HeadControlMapper();
  mapper.setNeutralBaseline(0, 0);

  mapper.processSample({ sessionId: 1, sequence: 1, capturedAtMs: 0, yawDeg: 15.0, pitchDeg: 0 }, 0);
  mapper.processSample({ sessionId: 1, sequence: 2, capturedAtMs: 60, yawDeg: 15.0, pitchDeg: 0 }, 60);
  assert.equal(mapper.getDirections().right, true);

  // Sample arrived 300 ms after its capture timestamp
  const staleRes = mapper.processSample({
    sessionId: 1,
    sequence: 3,
    capturedAtMs: 100,
    yawDeg: 15.0,
    pitchDeg: 0
  }, 450);

  assert.equal(staleRes.stale, true);
  assert.equal(staleRes.directions.right, false);
});

test('head-control: neutral calibration rejects high jitter (> 2.0 stddev)', () => {
  const mapper = new HeadControlMapper();
  mapper.startCalibration(0);

  // Feed 40 samples spanning 2000 ms with high jitter (alternating -5 and +5)
  for (let i = 0; i < 40; i++) {
    const t = i * 50;
    const yaw = (i % 2 === 0 ? 5.0 : -5.0);
    const res = mapper.updateCalibration({ yawDeg: yaw, pitchDeg: 0, capturedAtMs: t }, t);
    if (t >= 2000) {
      assert.equal(res.status, 'collecting');
      assert.ok(res.reason && res.reason.includes('晃動過大'));
    }
  }
  assert.equal(mapper.isCalibrated, false);
});

test('head-control: neutral calibration succeeds with steady gaze (<= 2.0 stddev)', () => {
  const mapper = new HeadControlMapper();
  mapper.startCalibration(0);

  let finalRes;
  for (let i = 0; i <= 45; i++) {
    const t = i * 50;
    const yaw = 2.0 + Math.sin(i) * 0.4; // Small steady fluctuation
    const pitch = -1.0 + Math.cos(i) * 0.3;
    finalRes = mapper.updateCalibration({ yawDeg: yaw, pitchDeg: pitch, capturedAtMs: t }, t);
  }

  assert.equal(finalRes.status, 'success');
  assert.equal(mapper.isCalibrated, true);
  assert.ok(Math.abs(mapper.neutralYaw - 2.0) < 0.5);
  assert.ok(Math.abs(mapper.neutralPitch - (-1.0)) < 0.5);
});

test('head-control: lower frame rates keep collecting until both duration and sample count are met', () => {
  const mapper = new HeadControlMapper();
  mapper.startCalibration(0);
  let result;
  for (let i = 0; i < 30; i++) {
    const now = i * 150;
    result = mapper.updateCalibration({ yawDeg: 2, pitchDeg: -4, capturedAtMs: now }, now);
    if (i < 29) assert.equal(result.status, 'collecting');
  }
  assert.equal(result.status, 'success');
  assert.equal(mapper.isCalibrated, true);
});
