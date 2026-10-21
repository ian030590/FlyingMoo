/**
 * @file head-control.mjs
 * Pure head-control processing module:
 * - Angle unwrap, median, standard deviation
 * - Neutral calibration & 4-cardinal direction verification
 * - Time-based EMA filtering, hysteresis, candidate confirmation (50 ms)
 * - Freshness watchdog & stale sample clearing (250 ms)
 */

export const DEFAULT_THRESHOLDS = {
  yawActive: 12.0,
  pitchActive: 10.0,
  tauMs: 60.0,
  confirmMs: 50.0,
  staleMs: 250.0,
  neutralDurationMs: 2000.0,
  neutralMinSamples: 30,
  neutralMaxStdDev: 2.0,
  directionHoldMs: 500.0,
  returnCenterMs: 500.0
};

/**
 * Unwrap angles in degrees to prevent jump around +-180.
 * @param {number[]} anglesDeg
 * @returns {number[]}
 */
export function unwrapAngles(anglesDeg) {
  if (anglesDeg.length === 0) return [];
  const unwrapped = [anglesDeg[0]];
  for (let i = 1; i < anglesDeg.length; i++) {
    let diff = anglesDeg[i] - anglesDeg[i - 1];
    while (diff > 180) diff -= 360;
    while (diff < -180) diff += 360;
    unwrapped.push(unwrapped[i - 1] + diff);
  }
  return unwrapped;
}

/**
 * Calculate median of a numeric array.
 * @param {number[]} values
 * @returns {number}
 */
export function calculateMedian(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * Calculate standard deviation.
 * @param {number[]} values
 * @param {number} mean
 * @returns {number}
 */
export function calculateStdDev(values, center) {
  if (values.length <= 1) return 0;
  const mean = center !== undefined ? center : (values.reduce((sum, v) => sum + v, 0) / values.length);
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export class HeadControlMapper {
  /**
   * @param {Partial<typeof DEFAULT_THRESHOLDS>} [config]
   */
  constructor(config = {}) {
    this.config = { ...DEFAULT_THRESHOLDS, ...config };

    // Neutral baseline offsets
    this.neutralYaw = 0;
    this.neutralPitch = 0;
    this.isCalibrated = false;

    // Filter state
    this.filteredYaw = 0;
    this.filteredPitch = 0;
    this.lastSampleTime = null;
    this.lastSequence = -1;
    this.sessionId = null;

    // Axis state: 'neutral' | 'positive' | 'negative'
    this.horizState = 'neutral';
    this.vertState = 'neutral';

    // Candidate directions & timers
    this.candidateHoriz = 'neutral';
    this.candidateHorizStart = 0;
    this.activeHoriz = 'neutral';

    this.candidateVert = 'neutral';
    this.candidateVertStart = 0;
    this.activeVert = 'neutral';

    // Neutral calibration accumulator
    this.calibSamples = [];
    this.calibStartTime = 0;

    // Direction verification state
    // 'none' | 'up' | 'return-up' | 'down' | 'return-down' | 'left' | 'return-left' | 'right' | 'return-right' | 'done'
    this.verificationStep = 'none';
    this.stepStartTime = 0;
  }

  /**
   * Set user sensitivity thresholds.
   * @param {number} yawActive
   * @param {number} pitchActive
   */
  setSensitivity(yawActive, pitchActive) {
    this.config.yawActive = Math.max(4.0, Math.min(25.0, yawActive));
    this.config.pitchActive = Math.max(4.0, Math.min(20.0, pitchActive));
  }

  getYawRelease() {
    return this.config.yawActive * (2 / 3);
  }

  getPitchRelease() {
    return this.config.pitchActive * 0.6;
  }

  /**
   * Reset filter and direction states (e.g. on recenter, pause, source switch).
   */
  resetFilter() {
    this.filteredYaw = 0;
    this.filteredPitch = 0;
    this.lastSampleTime = null;
    this.lastSequence = -1;

    this.horizState = 'neutral';
    this.vertState = 'neutral';
    this.candidateHoriz = 'neutral';
    this.activeHoriz = 'neutral';
    this.candidateVert = 'neutral';
    this.activeVert = 'neutral';
  }

  /**
   * Start neutral calibration.
   * @param {number} nowMs
   */
  startCalibration(nowMs) {
    this.calibSamples = [];
    this.calibStartTime = nowMs;
    this.isCalibrated = false;
    this.verificationStep = 'none';
    this.resetFilter();
  }

  /**
   * Feed a sample during neutral calibration.
   * @param {{ yawDeg: number, pitchDeg: number, capturedAtMs: number }} sample
   * @param {number} nowMs
   * @returns {{ status: 'collecting' | 'success' | 'failed', progress: number, reason?: string, yaw0?: number, pitch0?: number }}
   */
  updateCalibration(sample, nowMs) {
    if (nowMs - this.calibStartTime > 10000) {
      return { status: 'failed', progress: 1.0, reason: '校正逾時 (10 秒)，請確認光線與臉部朝向' };
    }

    this.calibSamples.push(sample);
    const elapsed = nowMs - this.calibStartTime;
    const progress = Math.min(1.0, elapsed / this.config.neutralDurationMs);

    if (elapsed >= this.config.neutralDurationMs) {
      if (this.calibSamples.length < this.config.neutralMinSamples) {
        return { status: 'failed', progress: 1.0, reason: `取樣不足 (${this.calibSamples.length}/${this.config.neutralMinSamples})` };
      }

      const yaws = unwrapAngles(this.calibSamples.map(s => s.yawDeg));
      const pitches = unwrapAngles(this.calibSamples.map(s => s.pitchDeg));

      const yaw0 = calculateMedian(yaws);
      const pitch0 = calculateMedian(pitches);

      const yawStd = calculateStdDev(yaws, yaw0);
      const pitchStd = calculateStdDev(pitches, pitch0);

      if (yawStd > this.config.neutralMaxStdDev || pitchStd > this.config.neutralMaxStdDev) {
        // High jitter: reset accumulator to let user steady
        this.calibSamples = [];
        this.calibStartTime = nowMs;
        return {
          status: 'collecting',
          progress: 0,
          reason: `晃動過大 (標準差 yaw: ${yawStd.toFixed(1)}°, pitch: ${pitchStd.toFixed(1)}°)，請保持穩定看向螢幕`
        };
      }

      this.neutralYaw = yaw0;
      this.neutralPitch = pitch0;
      this.isCalibrated = true;
      this.resetFilter();

      return { status: 'success', progress: 1.0, yaw0, pitch0 };
    }

    return { status: 'collecting', progress };
  }

  /**
   * Set neutral baseline directly (e.g. from fast recenter).
   * @param {number} yaw0
   * @param {number} pitch0
   */
  setNeutralBaseline(yaw0, pitch0) {
    this.neutralYaw = yaw0;
    this.neutralPitch = pitch0;
    this.isCalibrated = true;
    this.resetFilter();
  }

  /**
   * Start 4-direction verification steps: up -> return -> down -> return -> left -> return -> right -> return -> done.
   * @param {number} nowMs
   */
  startVerification(nowMs) {
    this.verificationStep = 'up';
    this.stepStartTime = nowMs;
  }

  /**
   * Update direction verification step using current raw sample.
   * @param {{ yawDeg: number, pitchDeg: number, capturedAtMs: number }} sample
   * @param {number} nowMs
   * @returns {{ step: string, progress: number, completed: boolean }}
   */
  updateVerification(sample, nowMs) {
    if (this.verificationStep === 'done') {
      return { step: 'done', progress: 1.0, completed: true };
    }
    if (this.verificationStep === 'none') {
      return { step: 'none', progress: 0.0, completed: false };
    }

    const dYaw = sample.yawDeg - this.neutralYaw;
    const dPitch = sample.pitchDeg - this.neutralPitch;

    const isUp = dPitch >= this.config.pitchActive && Math.abs(dYaw) < this.config.yawActive;
    const isDown = dPitch <= -this.config.pitchActive && Math.abs(dYaw) < this.config.yawActive;
    const isLeft = dYaw <= -this.config.yawActive && Math.abs(dPitch) < this.config.pitchActive;
    const isRight = dYaw >= this.config.yawActive && Math.abs(dPitch) < this.config.pitchActive;
    const isCenter = Math.abs(dYaw) < this.getYawRelease() && Math.abs(dPitch) < this.getPitchRelease();

    let targetMet = false;
    let targetDuration = this.config.directionHoldMs;

    switch (this.verificationStep) {
      case 'up': targetMet = isUp; break;
      case 'return-up': targetMet = isCenter; targetDuration = this.config.returnCenterMs; break;
      case 'down': targetMet = isDown; break;
      case 'return-down': targetMet = isCenter; targetDuration = this.config.returnCenterMs; break;
      case 'left': targetMet = isLeft; break;
      case 'return-left': targetMet = isCenter; targetDuration = this.config.returnCenterMs; break;
      case 'right': targetMet = isRight; break;
      case 'return-right': targetMet = isCenter; targetDuration = this.config.returnCenterMs; break;
      default: break;
    }

    if (!targetMet) {
      this.stepStartTime = nowMs;
    }

    const holdElapsed = nowMs - this.stepStartTime;
    const progress = Math.min(1.0, holdElapsed / targetDuration);

    if (holdElapsed >= targetDuration) {
      this.stepStartTime = nowMs;
      // Advance to next step
      const sequence = ['up', 'return-up', 'down', 'return-down', 'left', 'return-left', 'right', 'return-right', 'done'];
      const idx = sequence.indexOf(this.verificationStep);
      this.verificationStep = sequence[idx + 1] || 'done';
      if (this.verificationStep === 'done') {
        return { step: 'done', progress: 1.0, completed: true };
      }
    }

    return { step: this.verificationStep, progress, completed: false };
  }

  /**
   * Process an incoming normalized pose sample during gameplay.
   * @param {{
   *   sessionId: number,
   *   sequence: number,
   *   capturedAtMs: number,
   *   yawDeg: number,
   *   pitchDeg: number,
   *   rollDeg?: number
   * }} sample
   * @param {number} nowMs
   * @returns {{
   *   directions: { up: boolean, down: boolean, left: boolean, right: boolean },
   *   deltaYaw: number,
   *   deltaPitch: number,
   *   filteredYaw: number,
   *   filteredPitch: number,
   *   stale: boolean
   * }}
   */
  processSample(sample, nowMs) {
    const zeroDirs = { up: false, down: false, left: false, right: false };

    // Validate numbers
    if (
      !Number.isFinite(sample.yawDeg) ||
      !Number.isFinite(sample.pitchDeg) ||
      !Number.isFinite(sample.capturedAtMs)
    ) {
      this.resetFilter();
      return { directions: zeroDirs, deltaYaw: 0, deltaPitch: 0, filteredYaw: 0, filteredPitch: 0, stale: true };
    }

    // Check session
    if (this.sessionId !== null && sample.sessionId !== this.sessionId) {
      return { directions: zeroDirs, deltaYaw: 0, deltaPitch: 0, filteredYaw: 0, filteredPitch: 0, stale: true };
    }
    this.sessionId = sample.sessionId;

    // Check sequence monotonic
    if (this.lastSequence >= 0 && sample.sequence <= this.lastSequence) {
      return {
        directions: this.getDirections(),
        deltaYaw: sample.yawDeg - this.neutralYaw,
        deltaPitch: sample.pitchDeg - this.neutralPitch,
        filteredYaw: this.filteredYaw,
        filteredPitch: this.filteredPitch,
        stale: false
      };
    }
    this.lastSequence = sample.sequence;

    // Freshness check
    const sampleAge = nowMs - sample.capturedAtMs;
    if (sampleAge > this.config.staleMs || sampleAge < -100) {
      this.resetFilter();
      return { directions: zeroDirs, deltaYaw: 0, deltaPitch: 0, filteredYaw: 0, filteredPitch: 0, stale: true };
    }

    // Angle deltas from neutral baseline
    const dYaw = sample.yawDeg - this.neutralYaw;
    const dPitch = sample.pitchDeg - this.neutralPitch;

    if (this.lastSampleTime === null) {
      this.filteredYaw = dYaw;
      this.filteredPitch = dPitch;
    } else {
      const dtMs = Math.max(1, sample.capturedAtMs - this.lastSampleTime);
      const alpha = 1 - Math.exp(-dtMs / this.config.tauMs);
      this.filteredYaw += alpha * (dYaw - this.filteredYaw);
      this.filteredPitch += alpha * (dPitch - this.filteredPitch);
    }
    this.lastSampleTime = sample.capturedAtMs;

    // Hysteresis & candidate state machine
    this.updateHorizontalAxis(this.filteredYaw, dYaw, sample.capturedAtMs);
    this.updateVerticalAxis(this.filteredPitch, dPitch, sample.capturedAtMs);

    return {
      directions: this.getDirections(),
      deltaYaw: dYaw,
      deltaPitch: dPitch,
      filteredYaw: this.filteredYaw,
      filteredPitch: this.filteredPitch,
      stale: false
    };
  }

  /**
   * Horizontal axis candidate evaluation with hysteresis.
   * @param {number} yaw
   * @param {number} timeMs
   */
  updateHorizontalAxis(yaw, rawDeltaYaw, timeMs) {
    const yawActive = this.config.yawActive;
    const yawRelease = this.getYawRelease();

    // Immediate release on reversal: when user crosses center or points opposite, release old direction
    if (this.horizState === 'positive' && (yaw <= 0 || rawDeltaYaw <= 0)) {
      this.horizState = 'neutral';
      this.activeHoriz = 'neutral';
      this.candidateHoriz = 'neutral';
      this.candidateHorizStart = timeMs;
    } else if (this.horizState === 'negative' && (yaw >= 0 || rawDeltaYaw >= 0)) {
      this.horizState = 'neutral';
      this.activeHoriz = 'neutral';
      this.candidateHoriz = 'neutral';
      this.candidateHorizStart = timeMs;
    }

    let candidate = this.horizState;

    if (this.horizState === 'neutral') {
      if (yaw >= yawActive) candidate = 'positive'; // Right
      else if (yaw <= -yawActive) candidate = 'negative'; // Left
    } else if (this.horizState === 'positive') {
      if (yaw < yawRelease) candidate = 'neutral';
    } else if (this.horizState === 'negative') {
      if (yaw > -yawRelease) candidate = 'neutral';
    }

    if (candidate !== this.candidateHoriz) {
      this.candidateHoriz = candidate;
      this.candidateHorizStart = timeMs;
    }

    // Confirmation duration check
    if (timeMs - this.candidateHorizStart >= this.config.confirmMs) {
      this.horizState = this.candidateHoriz;
      this.activeHoriz = this.candidateHoriz;
    }
  }

  /**
   * Vertical axis candidate evaluation with hysteresis.
   * @param {number} pitch Filtered pitch
   * @param {number} rawDeltaPitch Raw delta pitch
   * @param {number} timeMs
   */
  updateVerticalAxis(pitch, rawDeltaPitch, timeMs) {
    const pitchActive = this.config.pitchActive;
    const pitchRelease = this.getPitchRelease();

    // Immediate release on reversal
    if (this.vertState === 'positive' && (pitch <= 0 || rawDeltaPitch <= 0)) {
      this.vertState = 'neutral';
      this.activeVert = 'neutral';
      this.candidateVert = 'neutral';
      this.candidateVertStart = timeMs;
    } else if (this.vertState === 'negative' && (pitch >= 0 || rawDeltaPitch >= 0)) {
      this.vertState = 'neutral';
      this.activeVert = 'neutral';
      this.candidateVert = 'neutral';
      this.candidateVertStart = timeMs;
    }

    let candidate = this.vertState;

    if (this.vertState === 'neutral') {
      if (pitch >= pitchActive) candidate = 'positive'; // Up
      else if (pitch <= -pitchActive) candidate = 'negative'; // Down
    } else if (this.vertState === 'positive') {
      if (pitch < pitchRelease) candidate = 'neutral';
    } else if (this.vertState === 'negative') {
      if (pitch > -pitchRelease) candidate = 'neutral';
    }

    if (candidate !== this.candidateVert) {
      this.candidateVert = candidate;
      this.candidateVertStart = timeMs;
    }

    // Confirmation duration check
    if (timeMs - this.candidateVertStart >= this.config.confirmMs) {
      this.vertState = this.candidateVert;
      this.activeVert = this.candidateVert;
    }
  }

  /**
   * Get current confirmed directions.
   * @returns {{ up: boolean, down: boolean, left: boolean, right: boolean }}
   */
  getDirections() {
    return {
      up: this.activeVert === 'positive',
      down: this.activeVert === 'negative',
      left: this.activeHoriz === 'negative',
      right: this.activeHoriz === 'positive'
    };
  }

  /**
   * Check if current filtered pose is centered (neutral) within release boundaries.
   * @returns {boolean}
   */
  isPoseCentered() {
    return (
      Math.abs(this.filteredYaw) < this.getYawRelease() &&
      Math.abs(this.filteredPitch) < this.getPitchRelease()
    );
  }

  /**
   * Watchdog check to clear directions if samples stopped arriving.
   * @param {number} nowMs
   * @returns {boolean} true if directions were cleared due to staleness
   */
  checkStale(nowMs) {
    if (this.lastSampleTime !== null && (nowMs - this.lastSampleTime > this.config.staleMs)) {
      this.resetFilter();
      return true;
    }
    return false;
  }
}
