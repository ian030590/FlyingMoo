/**
 * @file pose-worker.mjs
 * Web Worker executing MediaPipe Face Landmarker completely offline.
 * Extracts facial transformation matrix and outputs normalized yaw, pitch, roll.
 */

let landmarker = null;
let currentSessionId = 0;
let isInitializing = false;
let streamReader = null;
let currentDelegate = 'CPU';

async function inferFrame(image, capturedAtMs, sessionId, sequence, clockOriginMs, extra = {}) {
  const now = () => performance.timeOrigin + performance.now() - clockOriginMs;
  const inferenceStartedAtMs = now();
  let results;
  try {
    results = landmarker.detectForVideo(image, capturedAtMs);
  } catch (error) {
    if (currentDelegate !== 'GPU') throw error;
    try { landmarker.close(); } catch {}
    landmarker = null;
    await initLandmarker('CPU');
    results = landmarker.detectForVideo(image, capturedAtMs);
  }
  const inferenceFinishedAtMs = now();
  if (sessionId !== currentSessionId) return;
  const matrix = results?.facialTransformationMatrixes?.[0]?.data;
  const landmarks = results?.faceLandmarks?.[0];
  const pose = landmarks ? (matrix ? matrixToEulerDegrees(matrix) : landmarksToEulerDegrees(landmarks)) : {};
  const head = matrix ? { headX: matrix[12], headY: matrix[13], headZ: matrix[14], positionSpace: 'face-model' } :
    { headX: landmarks?.[1]?.x, headY: landmarks?.[1]?.y, headZ: landmarks?.[1]?.z, positionSpace: 'normalized-landmark' };
  const valid = Boolean(landmarks) && [pose.yawDeg, pose.pitchDeg, pose.rollDeg, head.headX, head.headY, head.headZ].every(Number.isFinite);
  self.postMessage({ type: 'pose', sessionId, sample: {
    source: 'webcam', sessionId, sequence, capturedAtMs, inferenceStartedAtMs, inferenceFinishedAtMs,
    frameWidth: image.displayWidth ?? image.width, frameHeight: image.displayHeight ?? image.height,
    inferenceDelegate: currentDelegate, ...extra, ...pose, ...head,
    valid, validityReason: valid ? '' : (landmarks ? 'invalid-pose' : 'no-face')
  } });
}

async function consumeStream(msg) {
  const { sessionId, clockOriginMs } = msg;
  streamReader = msg.readable.getReader();
  let sequence = 0;
  let offset = msg.mediaClockOffsetMs;
  let lastTimestamp = -Infinity;
  try {
    while (sessionId === currentSessionId) {
      const { value: frame, done } = await streamReader.read();
      if (done) break;
      try {
        const now = performance.timeOrigin + performance.now() - clockOriginMs;
        const mediaTimeMs = frame.timestamp / 1000;
        // Camera timestamp epochs differ; anchor once, retaining frame-to-frame capture times.
        if (sequence === 0 && Math.abs(mediaTimeMs + offset - now) > 1000) offset = now - mediaTimeMs;
        const capturedAtMs = Math.min(now, mediaTimeMs + offset);
        if (capturedAtMs <= lastTimestamp) continue;
        lastTimestamp = capturedAtMs;
        // Transferred streams can prefetch frames; discard backlog before running inference.
        if (sequence > 0 && now - capturedAtMs > 40) continue;
        await inferFrame(frame, capturedAtMs, sessionId, ++sequence, clockOriginMs,
          { videoTimestampUs: frame.timestamp, timestampSource: 'video-frame' });
      } finally { frame.close(); }
    }
  } catch (err) {
    if (sessionId === currentSessionId) self.postMessage({ type: 'status', sessionId, state: 'stream-fallback', message: String(err) });
  } finally {
    await streamReader.cancel().catch(() => {});
    streamReader.releaseLock();
    streamReader = null;
  }
}

/**
 * Extract yaw, pitch, roll (degrees) from 4x4 facial transformation matrix.
 * Coordinate convention:
 *   yawDeg > 0: user turning head to their RIGHT
 *   pitchDeg > 0: user tilting head UP
 *   rollDeg: tilt to side
 * @param {number[] | Float32Array} m 16-element matrix (column-major)
 * @returns {{ yawDeg: number, pitchDeg: number, rollDeg: number }}
 */
function matrixToEulerDegrees(m) {
  // Normalize 3x3 columns to remove any scale factor
  let r00 = m[0], r10 = m[1], r20 = m[2];
  let r01 = m[4], r11 = m[5], r21 = m[6];
  let r02 = m[8], r12 = m[9], r22 = m[10];

  const s0 = Math.hypot(r00, r10, r20) || 1;
  const s1 = Math.hypot(r01, r11, r21) || 1;
  const s2 = Math.hypot(r02, r12, r22) || 1;

  r00 /= s0; r10 /= s0; r20 /= s0;
  r01 /= s1; r11 /= s1; r21 /= s1;
  r02 /= s2; r12 /= s2; r22 /= s2;

  // Decompose rotation matrix into Euler angles
  // MediaPipe camera frame: X right, Y down (or up), Z pointing out of screen towards user
  // Pitch (X-axis): head nodding up/down
  // Yaw (Y-axis): head turning left/right
  // Roll (Z-axis): head tilting shoulder-to-shoulder
  const pitchRad = Math.asin(Math.max(-1, Math.min(1, -r12)));
  let yawRad, rollRad;

  if (Math.abs(r12) < 0.9999) {
    yawRad = Math.atan2(r02, r22);
    rollRad = Math.atan2(r10, r11);
  } else {
    // Gimbal lock
    yawRad = Math.atan2(-r20, r00);
    rollRad = 0;
  }

  const rad2deg = 180 / Math.PI;

  // MediaPipe coordinate convention alignment:
  // Turning to user's right produces positive yaw
  // Tilting head up produces positive pitch
  const yawDeg = -yawRad * rad2deg;
  const pitchDeg = -pitchRad * rad2deg;
  const rollDeg = rollRad * rad2deg;

  return { yawDeg, pitchDeg, rollDeg };
}

/**
 * Fallback geometry pose calculation from key 3D face landmarks:
 * nose tip (1), chin (152), forehead (10), left face (234), right face (454).
 * @param {Array<{ x: number, y: number, z: number }>} landmarks
 */
function landmarksToEulerDegrees(landmarks) {
  const nose = landmarks[1];
  const chin = landmarks[152];
  const forehead = landmarks[10];
  const leftCheek = landmarks[234];
  const rightCheek = landmarks[454];

  if (!nose || !chin || !forehead || !leftCheek || !rightCheek) {
    return { yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
  }

  // Horizontal asymmetry gives yaw
  const midFaceX = (leftCheek.x + rightCheek.x) / 2;
  const faceWidth = Math.abs(rightCheek.x - leftCheek.x) || 0.001;
  const yawOffset = (nose.x - midFaceX) / faceWidth;
  const yawDeg = yawOffset * 65.0; // Scaled to degree estimation

  // Vertical asymmetry gives pitch
  const midFaceY = (chin.y + forehead.y) / 2;
  const faceHeight = Math.abs(chin.y - forehead.y) || 0.001;
  // In screen space, y increases downwards, so nose above midface means looking up
  const pitchOffset = (midFaceY - nose.y) / faceHeight;
  const pitchDeg = pitchOffset * 70.0;

  // Roll from eye/cheek tilt
  const rollRad = Math.atan2(rightCheek.y - leftCheek.y, rightCheek.x - leftCheek.x);
  const rollDeg = rollRad * (180 / Math.PI);

  return { yawDeg, pitchDeg, rollDeg };
}

async function initLandmarker(preferredDelegate = 'GPU') {
  if (landmarker) return landmarker;
  if (isInitializing) return null;

  isInitializing = true;
  try {
    const { FaceLandmarker, FilesetResolver } = await import('../vendor/mediapipe/vision_bundle.mjs');
    const fileset = await FilesetResolver.forVisionTasks(new URL('../vendor/mediapipe/wasm', self.location.href).href);
    const options = {
      baseOptions: {
        modelAssetPath: new URL('../models/face_landmarker.task', self.location.href).href,
        delegate: preferredDelegate
      },
      outputFacialTransformationMatrixes: true,
      outputFaceBlendshapes: false,
      runningMode: 'VIDEO',
      numFaces: 1
    };
    try {
      landmarker = await FaceLandmarker.createFromOptions(fileset, options);
      currentDelegate = preferredDelegate;
    } catch (error) {
      if (preferredDelegate !== 'GPU') throw error;
      options.baseOptions.delegate = 'CPU';
      landmarker = await FaceLandmarker.createFromOptions(fileset, options);
      currentDelegate = 'CPU';
    }
    return landmarker;
  } finally {
    isInitializing = false;
  }
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg) return;

  if (msg.type === 'init') {
    currentSessionId = msg.sessionId;
    try {
      await initLandmarker();
      self.postMessage({
        type: 'status',
        sessionId: currentSessionId,
        state: 'ready'
      });
    } catch (err) {
      self.postMessage({
        type: 'status',
        sessionId: currentSessionId,
        state: 'error',
        code: 'MODEL_LOAD_FAILED',
        message: String(err)
      });
    }
    return;
  }

  if (msg.type === 'stream') {
    if (msg.sessionId === currentSessionId && landmarker && !streamReader) void consumeStream(msg);
    return;
  }

  if (msg.type === 'frame') {
    const { bitmap, capturedAtMs, sessionId, sequence } = msg;

    if (sessionId !== currentSessionId) {
      if (bitmap && bitmap.close) bitmap.close();
      return;
    }

    if (!landmarker) {
      if (bitmap && bitmap.close) bitmap.close();
      return;
    }

    try {
      await inferFrame(bitmap, capturedAtMs, sessionId, sequence, msg.clockOriginMs ?? performance.timeOrigin,
        { timestampSource: 'video-element' });
    } catch (err) {
      self.postMessage({
        type: 'status',
        sessionId,
        state: 'error',
        code: 'WORKER_FAILED',
        message: String(err)
      });
    } finally {
      bitmap.close();
    }
  }
};
