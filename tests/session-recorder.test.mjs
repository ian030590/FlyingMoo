import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionRecorder, CSV_COLUMNS } from '../wwwroot/session-recorder.mjs';
import { HeadControlMapper } from '../wwwroot/head-control.mjs';

function parseCsv(line) {
  return [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)|(?<=,)(?=,|$)/g)].map(m => m[1]?.replaceAll('""', '"') ?? '');
}

test('recorder: every valid/invalid sample and collision is saved with the scene at capture time', async t => {
  const calls = [];
  const bridge = { isAvailable: true, async invoke(command, args) {
    calls.push({ command, args });
    if (command === 'start_recording') return { id: 'test', path: 'test.csv' };
  } };
  const recorder = new SessionRecorder(bridge);
  t.after(() => clearInterval(recorder.timer));
  await recorder.start();
  const game = { cowX: 0, cowY: 0, position: 100, sheep: [{ id: 1, direction: 'up', x: 0, y: 0.4, z: 500 }] };
  const mapper = new HeadControlMapper();
  recorder.captureScene(100, game);
  game.cowX = 0.3;
  game.sheep[0].y = -0.4;
  recorder.captureScene(133, game);
  const sample = { source: 'webcam', sequence: 1, capturedAtMs: 110, yawDeg: 15, pitchDeg: 0,
    headX: 1, headY: 2, headZ: 3, inferenceDelegate: 'GPU' };
  const context = { state: 'play', game, mapper, valid: true };
  recorder.record(sample, 160, context);
  recorder.record({ ...sample, sequence: 2, capturedAtMs: 140 }, 170, { ...context, valid: false, reason: 'no-face' });
  recorder.record(sample, 180, { ...context, event: 'collision', collision: game.sheep[0] });
  await Promise.all([recorder.finish(), recorder.finish()]);
  assert.deepEqual(calls.map(c => c.command), ['start_recording', 'append_recording', 'finish_recording']);
  const rows = calls[1].args.rows.trim().split('\r\n').map(parseCsv).map(values => Object.fromEntries(CSV_COLUMNS.map((c, i) => [c, values[i]])));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].scene_at_ms, '100');
  assert.equal(rows[0].cow_x, '0');
  assert.equal(JSON.parse(rows[0].sheep_positions_json)[0].y, 0.4);
  assert.equal(rows[0].head_z, '3');
  assert.equal(rows[0].inference_delegate, 'GPU');
  assert.equal(rows[1].valid, 'false');
  assert.equal(rows[1].invalid_reason, 'no-face');
  assert.equal(rows[2].collision, 'true');
  assert.equal(rows[2].collided_sheep_id, '1');
  assert.equal(rows[2].cow_x, '0.3');
});

test('recorder: disk failure is visible and unsaved rows are retained', async t => {
  const statuses = [];
  const recorder = new SessionRecorder({ isAvailable: true, async invoke(command) {
    if (command === 'start_recording') return { id: 'test', path: 'test.csv' };
    throw new Error('disk full');
  } }, (...status) => statuses.push(status));
  t.after(() => clearInterval(recorder.timer));
  await recorder.start();
  recorder.pending.push('unsaved\r\n');
  await assert.rejects(recorder.finish(), /disk full/);
  assert.deepEqual(recorder.pending, ['unsaved\r\n']);
  assert.equal(recorder.active, false);
  assert.equal(statuses.at(-1)[1], true);
});

test('recorder: Tobii head and gaze rows keep their own columns and the summary goes to finish', async t => {
  const calls = [];
  const bridge = { isAvailable: true, async invoke(command, args) {
    calls.push({ command, args });
    if (command === 'start_recording') return { id: 'test', path: 'test.csv' };
  } };
  const recorder = new SessionRecorder(bridge);
  t.after(() => clearInterval(recorder.timer));
  await recorder.start();
  const game = { cowX: 0, cowY: 0, position: 10, sheep: [], runTime: 12.5, speedMultiplier: 1.4, dodged: 3, hits: 1,
    practice: { mode: 'timed' } };
  const mapper = new HeadControlMapper();
  mapper.setNeutralBaseline(2, -1);
  recorder.captureScene(100, game);
  const context = { state: 'play', game, mapper };
  recorder.record({ source: 'tobii', kind: 'head', sequence: 1, capturedAtMs: 105, yawDeg: null, pitchDeg: 4,
    positionSpace: 'tobii-mm', timestampSource: 'tobii-device' }, 110,
    { ...context, valid: false, reason: 'tobii-head-invalid', event: 'tobii-head', extra: { device_timestamp_us: 99 } });
  recorder.record({ source: 'tobii', kind: 'gaze', sequence: 2, capturedAtMs: 108 }, 112,
    { ...context, valid: true, event: 'tobii-gaze', extra: { head_directions: 'up+left', gaze_x_norm: 0.5,
      left_eye_valid: true, left_eye_z_mm: 600, gaze_error_deg: 1.25, gaze_on_target: true, fixation_tolerance_deg: 3 } });
  await recorder.finish({ source: 'tobii', fixation: { onTargetRatio: 1 } });
  assert.match(calls[0].args.header, /gaze_error_deg,gaze_on_target,fixation_tolerance_deg/);
  const rows = calls[1].args.rows.trim().split('\r\n').map(parseCsv).map(values => Object.fromEntries(CSV_COLUMNS.map((c, i) => [c, values[i]])));
  assert.equal(rows[0].event, 'tobii-head');
  assert.equal(rows[0].yaw_deg, '');
  assert.equal(rows[0].delta_yaw_deg, '');
  assert.equal(rows[0].delta_pitch_deg, '5');
  assert.equal(rows[0].device_timestamp_us, '99');
  assert.equal(rows[0].game_mode, 'timed');
  assert.equal(rows[0].run_time_s, '12.5');
  assert.equal(rows[0].speed_multiplier, '1.4');
  assert.equal(rows[0].hit_count, '1');
  assert.equal(rows[1].event, 'tobii-gaze');
  assert.equal(rows[1].head_directions, 'up+left');
  assert.equal(rows[1].gaze_x_norm, '0.5');
  assert.equal(rows[1].left_eye_z_mm, '600');
  assert.equal(rows[1].gaze_on_target, 'true');
  assert.equal(rows[1].right_eye_valid, '');
  const finish = calls.find(c => c.command === 'finish_recording');
  assert.deepEqual(JSON.parse(finish.args.metadata), { source: 'tobii', fixation: { onTargetRatio: 1 } });
});
