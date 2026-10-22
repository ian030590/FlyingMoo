import { desktop } from './desktop.mjs';

export const CSV_COLUMNS = [
  'sample_index', 'event', 'source', 'state', 'sequence', 'captured_at_ms', 'received_at_ms', 'unix_time_ms',
  'scene_at_ms', 'scene_valid', 'yaw_deg', 'pitch_deg', 'roll_deg', 'head_x', 'head_y', 'head_z', 'position_space',
  'delta_yaw_deg', 'delta_pitch_deg', 'filtered_yaw_deg', 'filtered_pitch_deg', 'cow_x', 'cow_y', 'cow_z',
  'sheep_positions_json', 'collision', 'collided_sheep_id', 'valid', 'invalid_reason',
  'inference_started_at_ms', 'inference_finished_at_ms', 'video_timestamp_us', 'timestamp_source',
  'frame_width', 'frame_height', 'left_threshold_deg', 'right_threshold_deg', 'up_threshold_deg', 'down_threshold_deg',
  'inference_delegate'
];

function csvCell(value) {
  if (value === undefined || value === null || (typeof value === 'number' && !Number.isFinite(value))) return '';
  return `"${String(value).replaceAll('"', '""')}"`;
}

export class SessionRecorder {
  constructor(bridge = desktop, onStatus = () => {}) {
    this.bridge = bridge;
    this.onStatus = onStatus;
    this.active = false;
    this.pending = [];
    this.history = [];
    this.writeChain = Promise.resolve();
    this.error = null;
  }

  async start() {
    if (this.destination) await this.finish();
    this.finishPromise = null;
    this.error = null;
    this.index = 0;
    this.history = [];
    this.pending = [];
    this.browserChunks = [];
    this.header = '\uFEFF' + CSV_COLUMNS.join(',') + '\r\n';
    this.destination = this.bridge.isAvailable ? await this.bridge.invoke('start_recording', { header: this.header }) :
      { id: String(Date.now()), path: '瀏覽器下載資料夾' };
    this.active = true;
    this.timer = setInterval(() => this.flush(), 200);
    this.onStatus(`紀錄中：${this.destination.path}`);
  }

  captureScene(now, game) {
    if (!this.active) return;
    this.history.push({ at: now, cowX: game.cowX, cowY: game.cowY, position: game.position,
      sheep: game.sheep.map(s => ({ id: s.id, direction: s.direction, x: s.x, y: s.y, z: s.z,
        relativeZ: s.z - game.position, alive: s.alive, passed: s.passed })) });
    if (this.history.length > 180) this.history.shift();
  }

  record(sample, now, { valid, reason = '', state, game, mapper, event = 'sample', collision = null }) {
    if (!this.active) return;
    const captured = sample?.capturedAtMs ?? now;
    const scene = event === 'collision' ? null : this.history.findLast(s => s.at <= captured);
    const current = { at: now, cowX: game.cowX, cowY: game.cowY, position: game.position,
      sheep: game.sheep.map(s => ({ id: s.id, direction: s.direction, x: s.x, y: s.y, z: s.z,
        relativeZ: s.z - game.position, alive: s.alive, passed: s.passed })) };
    const snapshot = scene ?? current;
    const values = [
      ++this.index, event, sample?.source ?? 'keyboard', state, sample?.sequence, captured, now,
      performance.timeOrigin + captured, snapshot.at, event === 'collision' || Boolean(scene && captured - scene.at <= 100),
      sample?.yawDeg, sample?.pitchDeg, sample?.rollDeg, sample?.headX, sample?.headY, sample?.headZ, sample?.positionSpace,
      sample ? sample.yawDeg - mapper.neutralYaw : null, sample ? sample.pitchDeg - mapper.neutralPitch : null,
      mapper.filteredYaw, mapper.filteredPitch, snapshot.cowX, snapshot.cowY, snapshot.position,
      JSON.stringify(snapshot.sheep), Boolean(collision), collision?.id, valid, reason,
      sample?.inferenceStartedAtMs, sample?.inferenceFinishedAtMs, sample?.videoTimestampUs, sample?.timestampSource,
      sample?.frameWidth, sample?.frameHeight,
      mapper.config.leftActive, mapper.config.rightActive, mapper.config.upActive, mapper.config.downActive,
      sample?.inferenceDelegate
    ];
    this.pending.push(values.map(csvCell).join(',') + '\r\n');
    if (this.pending.length >= 64) this.flush();
  }

  flush() {
    if (this.error || this.pending.length === 0) return this.writeChain;
    const rows = this.pending.splice(0).join('');
    const id = this.destination.id;
    this.writeChain = this.writeChain.then(async () => {
      if (this.error) { this.pending.push(rows); return; }
      try {
        if (this.bridge.isAvailable) await this.bridge.invoke('append_recording', { id, rows });
        else this.browserChunks.push(rows);
      } catch (error) {
        this.pending.unshift(rows);
        this.error = error;
        this.active = false;
        clearInterval(this.timer);
        this.onStatus(`紀錄儲存失敗：${String(error)}；訓練已暫停`, true);
      }
    });
    return this.writeChain;
  }

  finish() {
    if (!this.finishPromise) this.finishPromise = this.close();
    return this.finishPromise;
  }

  async close() {
    clearInterval(this.timer);
    if (!this.destination) return;
    this.active = false;
    await this.flush();
    if (this.error) throw this.error;
    if (this.bridge.isAvailable) await this.bridge.invoke('finish_recording', { id: this.destination.id });
    else {
      const url = URL.createObjectURL(new Blob([this.header, ...this.browserChunks], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `FlyingMoo_${this.destination.id}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    this.onStatus(`已儲存：${this.destination.path}`);
    this.destination = null;
  }
}
