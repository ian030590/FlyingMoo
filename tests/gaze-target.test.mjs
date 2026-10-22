import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FixationStats, checkDisplayMatch, clientToDisplay, displayToClient, evaluateGaze, eyeMidpoint, normalizeGazeSettings
} from '../wwwroot/gaze-target.mjs';

// A flat 300 × 200 mm display; the eye sits 600 mm in front of its center.
const area = { topLeftMm: [-150, 200, 0], topRightMm: [150, 200, 0], bottomLeftMm: [-150, 0, 0] };
const eye = [0, 100, 600];
const geometry = { innerX: 0, innerY: 0, monitor: { x: 0, y: 0, width: 1500, height: 1000 } };
const center = { x: 750, y: 500, visible: true };
const offsetForDegrees = degrees => 600 * Math.tan(degrees * Math.PI / 180) / 300;
const context = { geometry, dpr: 1, displayArea: area, target: center, toleranceDeg: 3, eye };

test('gaze: window offset, second monitor and display scaling map both ways', () => {
  const placed = { innerX: 2020, innerY: 50, monitor: { x: 1920, y: 0, width: 2000, height: 1000 } };
  const point = displayToClient(0.5, 0.5, placed, 1.25);
  assert.deepEqual(point, { x: 720, y: 360 });
  const back = clientToDisplay(point, placed, 1.25);
  assert.ok(Math.abs(back.u - 0.5) < 1e-12 && Math.abs(back.v - 0.5) < 1e-12);
  assert.equal(displayToClient(0.5, 0.5, { innerX: 0, innerY: 0, monitor: null }, 1), null);
});

test('gaze: visual angle to the cross decides fixation against the tolerance', () => {
  const near = evaluateGaze({ valid: true, gazeX: 0.5 + offsetForDegrees(2), gazeY: 0.5 }, context);
  assert.ok(Math.abs(near.errorDeg - 2) < 1e-9, String(near.errorDeg));
  assert.ok(Math.abs(near.errorMm - 600 * Math.tan(2 * Math.PI / 180)) < 1e-9);
  assert.ok(Math.abs(near.errorPx - offsetForDegrees(2) * 1500) < 1e-9);
  assert.equal(near.onTarget, true);

  const vertical = evaluateGaze({ valid: true, gazeX: 0.5, gazeY: 0.5 - offsetForDegrees(5) * 1.5 }, context);
  assert.ok(Math.abs(vertical.errorDeg - 5) < 1e-9, String(vertical.errorDeg));
  assert.equal(vertical.onTarget, false);
  assert.equal(vertical.gazeXPx, 750);
  assert.ok(vertical.gazeYPx < 500);
});

test('gaze: invalid samples and missing geometry never produce a fixation verdict', () => {
  const empty = { gazeXPx: null, gazeYPx: null, errorPx: null, errorMm: null, errorDeg: null, onTarget: null };
  assert.deepEqual(evaluateGaze({ valid: false, gazeX: 0.5, gazeY: 0.5 }, context), empty);
  assert.deepEqual(evaluateGaze({ valid: true, gazeX: NaN, gazeY: 0.5 }, context), empty);
  assert.deepEqual(evaluateGaze({ valid: true, gazeX: 0.5, gazeY: 0.5 }, { ...context, geometry: null }), empty);

  const noEye = evaluateGaze({ valid: true, gazeX: 0.6, gazeY: 0.5 }, { ...context, eye: null });
  assert.ok(Math.abs(noEye.errorMm - 30) < 1e-9);
  assert.equal(noEye.errorDeg, null);
  assert.equal(noEye.onTarget, null);

  const noArea = evaluateGaze({ valid: true, gazeX: 0.6, gazeY: 0.5 }, { ...context, displayArea: null });
  assert.ok(Math.abs(noArea.errorPx - 150) < 1e-9);
  assert.equal(noArea.errorMm, null);
  assert.equal(noArea.onTarget, null);
});

test('gaze: eye midpoint uses the valid eyes of the frame', () => {
  assert.deepEqual(eyeMidpoint({ leftEyeMm: [-30, 100, 600], rightEyeMm: [30, 110, 620] }), [0, 105, 610]);
  assert.deepEqual(eyeMidpoint({ leftEyeMm: null, rightEyeMm: [30, 110, 620] }), [30, 110, 620]);
  assert.equal(eyeMidpoint({ leftEyeMm: [NaN, 1, 2], rightEyeMm: undefined }), null);
});

test('gaze: display aspect check flags a window on a different monitor', () => {
  assert.equal(checkDisplayMatch(area, geometry).matches, true);
  const wide = checkDisplayMatch(area, { ...geometry, monitor: { x: 0, y: 0, width: 1920, height: 1080 } });
  assert.equal(wide.matches, false);
  assert.ok(Math.abs(wide.displayAspect - 1.5) < 1e-9);
  assert.equal(checkDisplayMatch(null, geometry), null);
});

test('gaze: fixation statistics separate unmeasured frames and head turns', () => {
  const stats = new FixationStats();
  stats.add({ onTarget: true, errorDeg: 1 });
  stats.add({ onTarget: false, errorDeg: 5 }, { turning: true });
  stats.add({ onTarget: true, errorDeg: 3 }, { turning: true });
  stats.add({ onTarget: null, errorDeg: null }, { turning: true });
  const summary = stats.summary();
  assert.equal(summary.gazeSamples, 4);
  assert.equal(summary.measuredSamples, 3);
  assert.equal(summary.measuredRatio, 0.75);
  assert.equal(summary.onTargetRatio, 2 / 3);
  assert.equal(summary.headTurningSamples, 2);
  assert.equal(summary.headTurningOnTargetRatio, 0.5);
  assert.equal(summary.meanErrorDeg, 3);
  stats.reset();
  assert.equal(stats.summary().onTargetRatio, null);
});

test('gaze: settings are clamped to half-degree steps', () => {
  assert.deepEqual(normalizeGazeSettings({}), { fixationToleranceDeg: 3, showGazeDot: false });
  assert.deepEqual(normalizeGazeSettings({ fixationToleranceDeg: 0.2, showGazeDot: true }), { fixationToleranceDeg: 1, showGazeDot: true });
  assert.equal(normalizeGazeSettings({ fixationToleranceDeg: 2.3 }).fixationToleranceDeg, 2.5);
  assert.equal(normalizeGazeSettings({ fixationToleranceDeg: 40, showGazeDot: 'yes' }).fixationToleranceDeg, 10);
});
