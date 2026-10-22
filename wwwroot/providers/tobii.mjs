/**
 * @file tobii.mjs
 * Tobii Stream Engine snapshots mapped to the shared head-control clock and axes.
 */

import { desktop } from '../desktop.mjs';

export class TobiiProvider {
  constructor() {
    this.sessionId = 0;
    this.sequence = 0;
    this.onMessageCallback = null;
    this.pollIntervalId = null;
    this.isRunning = false;
    this.lastTimestampUs = -1;
    this.generation = 0;
    this.lastStatus = '';
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
    this.sequence = 0;
    this.onMessageCallback = onMessage;
    this.isRunning = true;
    this.lastTimestampUs = -1;
    this.lastStatus = '';

    this.dispatchStatus('starting');

    if (!desktop.isAvailable) {
      this.dispatchStatus('error', 'TOBII_HOST_UNAVAILABLE', 'Tobii 僅能在 Windows 桌面程式中執行');
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
        this.sequence++;
        if (this.onMessageCallback) {
          this.onMessageCallback({
            type: 'pose',
            sessionId: this.sessionId,
            sample: {
              source: 'tobii',
              sessionId: this.sessionId,
              sequence: this.sequence,
              capturedAtMs,
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
    if (desktop.isAvailable) await desktop.stopTobii(sessionId);
  }
}
