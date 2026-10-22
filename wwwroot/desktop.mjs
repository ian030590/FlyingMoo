/**
 * @file desktop.mjs
 * Single Tauri adapter bridge and monotonic clock synchronization.
 * Handles graceful web preview fallback when not running inside Tauri host.
 */

class DesktopBridge {
  constructor() {
    this.inFlightSnapshot = false;
    this.clockOffsetMs = 0;
    this.clockSyncRttMs = 0;
    this.hasClockSynced = false;
    this.tobiiLifecycle = Promise.resolve();
  }

  /**
   * Check if running inside Tauri host.
   * @returns {boolean}
   */
  get isAvailable() {
    return Boolean(
      typeof window !== 'undefined' &&
      window.__TAURI__ &&
      (window.__TAURI__.core?.invoke || window.__TAURI__.invoke)
    );
  }

  /**
   * Internal invoke wrapper.
   * @param {string} cmd
   * @param {Record<string, any>} [args]
   * @returns {Promise<any>}
   */
  async invoke(cmd, args = {}) {
    if (!this.isAvailable) {
      throw new Error(`Desktop host not available for command: ${cmd}`);
    }
    const invoker = window.__TAURI__.core?.invoke || window.__TAURI__.invoke;
    return invoker(cmd, args);
  }

  /**
   * Sync native monotonic clock with frontend performance.now().
   * Performs 5 rounds of ping, picks sample with lowest RTT, sets offset with RTT/2 precision.
   * @returns {Promise<{ offsetMs: number, rttMs: number }>}
   */
  async syncClock() {
    if (!this.isAvailable) {
      this.clockOffsetMs = 0;
      this.hasClockSynced = true;
      return { offsetMs: 0, rttMs: 0 };
    }

    let bestRtt = Infinity;
    let bestOffset = 0;

    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const res = await this.invoke('get_native_clock');
      const t1 = performance.now();

      const rtt = t1 - t0;
      // res.timestampUs is microseconds, convert to ms
      const nativeMs = (typeof res === 'number' ? res : res.timestampUs) / 1000;
      const midpoint = (t0 + t1) / 2;
      const offset = midpoint - nativeMs;

      if (rtt < bestRtt) {
        bestRtt = rtt;
        bestOffset = offset;
      }
    }

    this.clockSyncRttMs = bestRtt;
    this.clockOffsetMs = bestOffset;
    this.hasClockSynced = true;

    return { offsetMs: bestOffset, rttMs: bestRtt };
  }

  /**
   * Map native SDK timestamp to frontend performance.now() clock.
   * @param {number} nativeTimestampUs
   * @returns {number}
   */
  mapNativeTimeToFrontend(nativeTimestampUs) {
    const nativeMs = nativeTimestampUs / 1000;
    return nativeMs + this.clockOffsetMs;
  }

  /**
   * Start Tobii streaming in native host.
   * @param {number} sessionId
   * @returns {Promise<{ success: boolean, code?: string, message?: string }>}
   */
  async startTobii(sessionId) {
    if (!this.isAvailable) {
      return { success: false, code: 'TOBII_HOST_UNAVAILABLE', message: 'Tobii 僅能在 Windows 桌面程式中執行' };
    }
    try {
      return await this.queueTobiiOperation(async () => {
        await this.syncClock();
        const snapshot = await this.invoke('start_tobii', { sessionId });
        return { success: snapshot?.sessionId === sessionId && snapshot.status !== 'error',
          code: snapshot?.code, message: snapshot?.message };
      });
    } catch (err) {
      return { success: false, code: 'TOBII_START_FAILED', message: String(err) };
    }
  }

  queueTobiiOperation(operation) {
    const pending = this.tobiiLifecycle.then(operation);
    this.tobiiLifecycle = pending.catch(() => {});
    return pending;
  }

  /**
   * Read latest Tobii head pose snapshot from native host with single in-flight guarantee.
   * @param {number} sessionId
   * @returns {Promise<any | null>}
   */
  async readTobiiSnapshot(sessionId) {
    if (!this.isAvailable || this.inFlightSnapshot) {
      return null;
    }
    this.inFlightSnapshot = true;
    try {
      const snapshot = await this.invoke('read_tobii_snapshot', { sessionId });
      return snapshot;
    } finally {
      this.inFlightSnapshot = false;
    }
  }

  /**
   * Tobii device model, display area (mm) and available gaze streams; null until connected.
   * @param {number} sessionId
   * @returns {Promise<any | null>}
   */
  async readTobiiDevice(sessionId) {
    if (!this.isAvailable) return null;
    return (await this.invoke('read_tobii_device', { sessionId })) ?? null;
  }

  /**
   * Game window client area and its monitor in physical screen pixels.
   * @returns {Promise<any | null>}
   */
  async getWindowGeometry() {
    if (!this.isAvailable) return null;
    return (await this.invoke('get_window_geometry')) ?? null;
  }

  /**
   * Stop Tobii streaming in native host.
   * @param {number} sessionId
   * @returns {Promise<void>}
   */
  async stopTobii(sessionId) {
    if (!this.isAvailable) return;
    try {
      await this.queueTobiiOperation(() => this.invoke('stop_tobii', { sessionId }));
    } catch (e) {
      console.warn('stop_tobii warning:', e);
    }
  }

  /**
   * Set window fullscreen.
   * @param {boolean} fullscreen
   * @returns {Promise<void>}
   */
  async setFullscreen(fullscreen) {
    if (!this.isAvailable) return;
    try {
      await this.invoke('set_fullscreen', { fullscreen });
    } catch (e) {
      console.warn('set_fullscreen warning:', e);
    }
  }
}

export const desktop = new DesktopBridge();
