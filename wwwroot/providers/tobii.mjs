/**
 * @file tobii.mjs
 * HeadProvider implementation for Tobii Eye Tracker 5 (TGI head pose stream).
 * Polls native snapshot at ~30 Hz, maps monotonic clock, and emits normalized pose samples.
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
  }

  /**
   * Start Tobii provider.
   * @param {number} sessionId
   * @param {(m: any) => void} onMessage
   */
  async start(sessionId, onMessage) {
    await this.stop();

    this.sessionId = sessionId;
    this.sequence = 0;
    this.onMessageCallback = onMessage;
    this.isRunning = true;
    this.lastTimestampUs = -1;

    this.dispatchStatus('starting');

    if (!desktop.isAvailable) {
      this.dispatchStatus('error', 'TOBII_HOST_UNAVAILABLE', 'Tobii 僅能在 Windows 桌面程式中執行');
      return;
    }

    const startRes = await desktop.startTobii(sessionId);
    if (!startRes || !startRes.success) {
      this.dispatchStatus(
        'error',
        startRes?.code || 'TOBII_RUNTIME_UNAVAILABLE',
        startRes?.message || 'Tobii 服務未就緒或未偵測到 Eye Tracker 5'
      );
      return;
    }

    this.dispatchStatus('connected');

    // Start snapshot polling loop (~30 Hz, 33 ms)
    this.pollIntervalId = setInterval(() => {
      this.pollSnapshot();
    }, 33);
  }

  /**
   * Poll latest snapshot from native host.
   */
  async pollSnapshot() {
    if (!this.isRunning) return;

    try {
      const snap = await desktop.readTobiiSnapshot(this.sessionId);
      if (!this.isRunning || !snap) return;

      // Handle status reports from native bridge
      if (snap.status) {
        if (snap.status === 'device-absent' || snap.status === 'tracking-lost') {
          this.dispatchStatus('tracking-lost', snap.code || 'TOBII_DEVICE_ABSENT');
          return;
        }
        if (snap.status === 'error') {
          this.dispatchStatus('error', snap.code || 'TOBII_ERROR', snap.message);
          return;
        }
      }

      // Check if sample is valid and new
      if (snap.valid && snap.timestampUs !== undefined && snap.timestampUs !== this.lastTimestampUs) {
        this.lastTimestampUs = snap.timestampUs;
        this.sequence++;

        const capturedAtMs = desktop.mapNativeTimeToFrontend(snap.timestampUs);

        // TGI orientation:
        // yaw: positive right
        // pitch: positive up
        // roll: positive tilt
        if (this.onMessageCallback) {
          this.onMessageCallback({
            type: 'pose',
            sample: {
              source: 'tobii',
              sessionId: this.sessionId,
              sequence: this.sequence,
              capturedAtMs,
              yawDeg: Number(snap.yawDeg) || 0,
              pitchDeg: Number(snap.pitchDeg) || 0,
              rollDeg: Number(snap.rollDeg) || 0
            }
          });
        }
      }
    } catch (err) {
      console.warn('Tobii poll error:', err);
    }
  }

  /**
   * Dispatch status event.
   * @param {'starting' | 'connected' | 'tracking-lost' | 'error' | 'stopped'} state
   * @param {string} [code]
   * @param {string} [message]
   */
  dispatchStatus(state, code, message) {
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
    this.isRunning = false;
    if (this.pollIntervalId) {
      clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }
    if (desktop.isAvailable) {
      await desktop.stopTobii(this.sessionId);
    }
    this.dispatchStatus('stopped');
  }
}
