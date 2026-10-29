/**
 * @file tobii.mjs
 * Tobii Stream Engine snapshots mapped to the shared head-control clock and axes.
 * The latest head pose drives control; every queued head and gaze sample is forwarded for recording.
 */

import { desktop } from '../desktop.mjs';

export class TobiiProvider {
  constructor() {
    this.sessionId = 0;
    this.onMessageCallback = null;
    this.pollIntervalId = null;
    this.isRunning = false;
    this.lastTimestampUs = -1;
    this.generation = 0;
    this.lastStatus = '';
    // One counter for every recorded sample; the control pose reuses the number of its tobii-head row.
    this.rawSequence = 0;
    this.lastHeadSample = null;
    this.droppedSamples = 0;
    this.deviceRequested = false;
  }

  /**
   * Start Tobii provider.
   * @param {number} sessionId
   * @param {(m: any) => void} onMessage
   */
  async start(sessionId, onMessage) {
    const stopping = this.stop();
    const generation = this.generation;
    await stopping;
    if (generation !== this.generation) return;

    this.sessionId = sessionId;
    this.onMessageCallback = onMessage;
    this.isRunning = true;
    this.lastTimestampUs = -1;
    this.lastStatus = '';
    this.rawSequence = 0;
    this.lastHeadSample = null;
    this.droppedSamples = 0;
    this.deviceRequested = false;

    this.dispatchStatus('starting');

    if (!desktop.isTobiiAvailable) {
      this.dispatchStatus('error', 'TOBII_HOST_UNAVAILABLE', '請透過 HTTPS 開啟網頁，並在 Windows 啟動 Tobii 本機橋接。');
      this.isRunning = false;
      return;
    }

    const startRes = await desktop.startTobii(sessionId);
    if (generation !== this.generation) {
      await desktop.stopTobii(sessionId);
      return;
    }
    if (!startRes || !startRes.success) {
      this.dispatchStatus(
        'error',
        startRes?.code || 'TOBII_RUNTIME_UNAVAILABLE',
        startRes?.message || 'Tobii 服務未就緒或未偵測到 Eye Tracker 5'
      );
      this.isRunning = false;
      return;
    }

    this.pollIntervalId = setInterval(() => {
      this.pollSnapshot();
    }, 16);
    await this.pollSnapshot();
  }

  /**
   * Poll latest snapshot from native host.
   */
  async pollSnapshot() {
    if (!this.isRunning) return;
    const generation = this.generation;
    const sessionId = this.sessionId;

    try {
      const snap = await desktop.readTobiiSnapshot(sessionId);
      if (!this.isRunning || generation !== this.generation || !snap || snap.sessionId !== sessionId) return;

      // Samples drained by this read are forwarded before any status handling can return early.
      this.forwardSamples(snap);
      if (!this.deviceRequested && (snap.status === 'connected' || snap.valid)) this.requestDevice(generation, sessionId);

      // Handle status reports from native bridge
      if (snap.status) {
        if (snap.status === 'device-absent' || snap.status === 'tracking-lost') {
          this.dispatchStatus('tracking-lost', snap.code || 'TOBII_DEVICE_ABSENT', snap.message);
          return;
        }
        if (snap.status === 'error' || snap.status === 'stopped') {
          this.dispatchStatus('error', snap.code || 'TOBII_ERROR', snap.message);
          this.isRunning = false;
          clearInterval(this.pollIntervalId);
          this.pollIntervalId = null;
          return;
        }
        if (snap.status === 'connected') this.dispatchStatus('connected');
      }

      // Check if sample is valid and new
      if (snap.valid && Number.isSafeInteger(snap.timestampUs) && snap.timestampUs > this.lastTimestampUs) {
        this.lastTimestampUs = snap.timestampUs;
        const capturedAtMs = desktop.mapNativeTimeToFrontend(snap.timestampUs);
        const age = performance.now() - capturedAtMs;
        if (![snap.yawDeg, snap.pitchDeg, snap.rollDeg, capturedAtMs].every(Number.isFinite) || age > 250 || age < -100) {
          this.dispatchStatus('tracking-lost', 'TOBII_INVALID_POSE');
          return;
        }
        this.dispatchStatus('connected');
        // The snapshot and its queued head sample come from the same native read.
        const head = this.lastHeadSample?.timestampUs === snap.timestampUs ? this.lastHeadSample : null;
        const sequence = head ? head.sequence : ++this.rawSequence;
        if (this.onMessageCallback) {
          this.onMessageCallback({
            type: 'pose',
            sessionId: this.sessionId,
            sample: {
              source: 'tobii',
              sessionId: this.sessionId,
              sequence,
              capturedAtMs,
              deviceTimestampUs: head?.deviceTimestampUs,
              timestampSource: 'tobii-device',
              yawDeg: snap.yawDeg,
              pitchDeg: snap.pitchDeg,
              rollDeg: snap.rollDeg,
              headX: snap.headX,
              headY: snap.headY,
              headZ: snap.headZ,
              positionSpace: 'tobii-mm',
              valid: true
            }
          });
        }
      }
    } catch (err) {
      if (generation === this.generation && this.isRunning) {
        this.dispatchStatus('error', 'TOBII_READ_FAILED', String(err));
        this.isRunning = false;
        clearInterval(this.pollIntervalId);
        this.pollIntervalId = null;
      }
    }
  }

  /**
   * Forward every head and gaze sample drained from the native queue, mapped to the frontend clock.
   * @param {any} snap
   */
  forwardSamples(snap) {
    const samples = Array.isArray(snap.samples) ? snap.samples : [];
    const dropped = Number.isSafeInteger(snap.droppedSamples) ? snap.droppedSamples : this.droppedSamples;
    if (samples.length === 0 && dropped === this.droppedSamples) return;
    this.droppedSamples = dropped;
    const mapped = samples.filter(s => s && Number.isSafeInteger(s.timestampUs)).map(s => ({
      ...s,
      source: 'tobii',
      sessionId: this.sessionId,
      sequence: ++this.rawSequence,
      capturedAtMs: desktop.mapNativeTimeToFrontend(s.timestampUs),
      timestampSource: 'tobii-device',
      positionSpace: s.kind === 'head' ? 'tobii-mm' : undefined
    }));
    const head = mapped.findLast(s => s.kind === 'head');
    if (head) this.lastHeadSample = { timestampUs: head.timestampUs, sequence: head.sequence, deviceTimestampUs: head.deviceTimestampUs };
    this.onMessageCallback?.({ type: 'samples', sessionId: this.sessionId, samples: mapped, droppedSamples: dropped });
  }

  /**
   * Fetch device model and display area once the stream is connected.
   * @param {number} generation
   * @param {number} sessionId
   */
  async requestDevice(generation, sessionId) {
    this.deviceRequested = true;
    try {
      const device = await desktop.readTobiiDevice(sessionId);
      if (generation !== this.generation) return;
      if (!device) {
        this.deviceRequested = false;
        return;
      }
      this.onMessageCallback?.({ type: 'device', sessionId, device });
    } catch {
      if (generation === this.generation) this.deviceRequested = false;
    }
  }

  /**
   * Dispatch status event.
   * @param {'starting' | 'connected' | 'tracking-lost' | 'error' | 'stopped'} state
   * @param {string} [code]
   * @param {string} [message]
   */
  dispatchStatus(state, code, message) {
    const key = JSON.stringify([state, code, message]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    if (this.onMessageCallback) {
      this.onMessageCallback({
        type: 'status',
        sessionId: this.sessionId,
        state,
        code,
        message
      });
    }
  }

  /**
   * Stop Tobii provider and native stream.
   */
  async stop() {
    this.generation++;
    this.isRunning = false;
    if (this.pollIntervalId) {
      clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }
    const sessionId = this.sessionId;
    this.dispatchStatus('stopped');
    this.onMessageCallback = null;
    if (desktop.isTobiiAvailable) await desktop.stopTobii(sessionId);
  }
}
