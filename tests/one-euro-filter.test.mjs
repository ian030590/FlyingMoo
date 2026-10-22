import test from 'node:test';
import assert from 'node:assert/strict';
import { OneEuroFilter } from '../wwwroot/one-euro-filter.mjs';
import { HeadControlMapper } from '../wwwroot/head-control.mjs';

test('One Euro: timestamp intervals determine cutoff; repeated samples leave state unchanged', () => {
  const filter = new OneEuroFilter({ minCutoffHz: 1, beta: 0 });
  assert.equal(filter.filter(10, 0), 10);
  const expected = 10 + 2 / (1 + 1 / (2 * Math.PI * 0.1));
  assert.ok(Math.abs(filter.filter(12, 100) - expected) < 1e-12);
  assert.equal(filter.filter(100, 100), expected);
  assert.equal(filter.filter(-100, 99), expected);
  filter.reset();
  assert.equal(filter.filter(-20, 101), -20);
  assert.throws(() => filter.filter(NaN, 102), TypeError);
  assert.throws(() => new OneEuroFilter({ minCutoffHz: 0 }), RangeError);
});

test('One Euro: less stationary jitter and fast-motion error than 20ms EMA at 20, 30 and 60Hz', () => {
  const rms = values => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
  for (const hz of [20, 30, 60]) {
    for (const moving of [false, true]) {
      const filter = new OneEuroFilter();
      let ema = 0;
      const adaptiveError = [], fixedError = [];
      for (let i = 0; i < hz * 10; i++) {
        const t = i / hz;
        const input = moving ? 18 * Math.sin(2 * Math.PI * 1.5 * t) :
          0.6 * Math.sin(2 * Math.PI * 7 * t) + 0.3 * Math.sin(2 * Math.PI * 9.3 * t);
        const output = filter.filter(input, t * 1000);
        ema += (1 - Math.exp(-1000 / hz / 20)) * (input - ema);
        if (i > hz) {
          adaptiveError.push(moving ? input - output : output);
          fixedError.push(moving ? input - ema : ema);
        }
      }
      assert.ok(rms(adaptiveError) < rms(fixedError), `${hz}Hz, moving=${moving}`);
    }
  }
});

test('head mapper: recenter, stale clear and irregular sample rates reset adaptive filter history', () => {
  const mapper = new HeadControlMapper();
  let sequence = 0;
  const sample = (yawDeg, now) => mapper.processSample({ yawDeg, pitchDeg: 0,
    capturedAtMs: now, sessionId: 1, sequence: ++sequence }, now);
  sample(0, 0);
  for (const now of [33, 83, 100, 150]) assert.equal(sample(18, now).directions.right, true);
  mapper.setNeutralBaseline(18, 0);
  assert.equal(sample(18, 183).filteredYaw, 0);
  assert.equal(sample(-18, 216).directions.right, false);
  mapper.checkStale(500);
  assert.equal(mapper.yawFilter.lastTimeMs, null);
  assert.equal(sample(18, 510).filteredYaw, 0);
});
