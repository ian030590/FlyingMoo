/**
 * @file gaze-target.mjs
 * Places Tobii gaze in the game window and measures its distance to the fixation cross.
 *
 * Tobii gaze is normalized to the display configured in Tobii Experience: (0, 0) top-left,
 * (1, 1) bottom-right. Window geometry comes from the host in physical screen pixels, and
 * the display area gives the same display's corners in mm (tracker coordinates).
 */

export const GAZE_DEFAULTS = { fixationToleranceDeg: 3, showGazeDot: false };
/** Eye position from an earlier frame may stand in for a frame without one (e.g. one eye lost). */
export const EYE_POSITION_MAX_AGE_MS = 1000;
const ASPECT_TOLERANCE = 0.03;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = a => Math.hypot(a[0], a[1], a[2]);
const finite = (...values) => values.every(Number.isFinite);
const isVector = v => Array.isArray(v) && v.length === 3 && finite(...v);

export function normalizeGazeSettings(config = {}) {
  const tolerance = Number(config.fixationToleranceDeg);
  return {
    fixationToleranceDeg: Number.isFinite(tolerance)
      ? Math.round(Math.min(10, Math.max(1, tolerance)) * 2) / 2 : GAZE_DEFAULTS.fixationToleranceDeg,
    showGazeDot: config.showGazeDot === true
  };
}

export function isDisplayArea(area) {
  return Boolean(area && isVector(area.topLeftMm) && isVector(area.topRightMm) && isVector(area.bottomLeftMm));
}

/** Point on the physical display (mm) for normalized display coordinates. */
export function displayPoint(area, u, v) {
  const across = sub(area.topRightMm, area.topLeftMm);
  const down = sub(area.bottomLeftMm, area.topLeftMm);
  return add(area.topLeftMm, add(scale(across, u), scale(down, v)));
}

export function displaySizeMm(area) {
  return {
    widthMm: length(sub(area.topRightMm, area.topLeftMm)),
    heightMm: length(sub(area.bottomLeftMm, area.topLeftMm))
  };
}

/** Game window client point (CSS px) to normalized coordinates of the window's monitor. */
export function clientToDisplay(point, geometry, dpr) {
  const monitor = geometry?.monitor;
  if (!monitor?.width || !monitor?.height || !(dpr > 0) || !finite(geometry.innerX, geometry.innerY)) return null;
  return {
    u: (geometry.innerX + point.x * dpr - monitor.x) / monitor.width,
    v: (geometry.innerY + point.y * dpr - monitor.y) / monitor.height
  };
}

/** Normalized monitor coordinates to the game window client point (CSS px). */
export function displayToClient(u, v, geometry, dpr) {
  const monitor = geometry?.monitor;
  if (!monitor?.width || !monitor?.height || !(dpr > 0) || !finite(geometry.innerX, geometry.innerY)) return null;
  return {
    x: (monitor.x + u * monitor.width - geometry.innerX) / dpr,
    y: (monitor.y + v * monitor.height - geometry.innerY) / dpr
  };
}

/** Midpoint of the valid eye positions of one gaze frame (mm), or null. */
export function eyeMidpoint(sample) {
  const eyes = [sample?.leftEyeMm, sample?.rightEyeMm].filter(isVector);
  if (eyes.length === 0) return null;
  return scale(eyes.reduce(add, [0, 0, 0]), 1 / eyes.length);
}

/** Visual angle (degrees) between two display points seen from the eye. */
export function visualAngleDeg(eye, a, b) {
  const p = sub(a, eye);
  const q = sub(b, eye);
  return Math.atan2(length(cross(p, q)), dot(p, q)) * 180 / Math.PI;
}

/**
 * Compares the Tobii display with the monitor that holds the game window.
 * A different aspect ratio means gaze cannot be placed on the window reliably.
 */
export function checkDisplayMatch(area, geometry) {
  const monitor = geometry?.monitor;
  if (!isDisplayArea(area) || !monitor?.width || !monitor?.height) return null;
  const { widthMm, heightMm } = displaySizeMm(area);
  const displayAspect = widthMm / heightMm;
  const monitorAspect = monitor.width / monitor.height;
  return {
    widthMm, heightMm, displayAspect, monitorAspect,
    matches: Math.abs(displayAspect - monitorAspect) / monitorAspect <= ASPECT_TOLERANCE
  };
}

/**
 * @param {{ valid?: boolean, gazeX?: number, gazeY?: number }} sample Tobii gaze frame
 * @param {{ geometry: any, dpr: number, displayArea: any, target: { x: number, y: number } | null,
 *   toleranceDeg: number, eye: number[] | null }} context
 */
export function evaluateGaze(sample, { geometry, dpr, displayArea, target, toleranceDeg, eye }) {
  const result = { gazeXPx: null, gazeYPx: null, errorPx: null, errorMm: null, errorDeg: null, onTarget: null };
  if (!sample?.valid || !finite(sample.gazeX, sample.gazeY)) return result;
  const gaze = displayToClient(sample.gazeX, sample.gazeY, geometry, dpr);
  if (!gaze) return result;
  result.gazeXPx = gaze.x;
  result.gazeYPx = gaze.y;
  if (!target || !finite(target.x, target.y)) return result;
  result.errorPx = Math.hypot(gaze.x - target.x, gaze.y - target.y);
  const targetOnDisplay = clientToDisplay(target, geometry, dpr);
  if (!isDisplayArea(displayArea) || !targetOnDisplay) return result;
  const gazeMm = displayPoint(displayArea, sample.gazeX, sample.gazeY);
  const targetMm = displayPoint(displayArea, targetOnDisplay.u, targetOnDisplay.v);
  result.errorMm = length(sub(gazeMm, targetMm));
  if (isVector(eye)) {
    result.errorDeg = visualAngleDeg(eye, gazeMm, targetMm);
    result.onTarget = result.errorDeg <= toleranceDeg;
  }
  return result;
}

/** Fixation on the cross during flight. Only frames with a measurable angle count toward ratios. */
export class FixationStats {
  constructor() {
    this.reset();
  }

  reset() {
    this.samples = 0;
    this.measured = 0;
    this.onTarget = 0;
    this.errorSumDeg = 0;
    this.turningMeasured = 0;
    this.turningOnTarget = 0;
  }

  add(evaluation, { turning = false } = {}) {
    this.samples++;
    if (evaluation.onTarget === null || !Number.isFinite(evaluation.errorDeg)) return;
    this.measured++;
    this.errorSumDeg += evaluation.errorDeg;
    if (evaluation.onTarget) this.onTarget++;
    if (turning) {
      this.turningMeasured++;
      if (evaluation.onTarget) this.turningOnTarget++;
    }
  }

  summary() {
    const ratio = (part, total) => total > 0 ? part / total : null;
    return {
      gazeSamples: this.samples,
      measuredSamples: this.measured,
      measuredRatio: ratio(this.measured, this.samples),
      onTargetRatio: ratio(this.onTarget, this.measured),
      headTurningSamples: this.turningMeasured,
      headTurningOnTargetRatio: ratio(this.turningOnTarget, this.turningMeasured),
      meanErrorDeg: ratio(this.errorSumDeg, this.measured)
    };
  }
}
