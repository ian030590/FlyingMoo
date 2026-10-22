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
