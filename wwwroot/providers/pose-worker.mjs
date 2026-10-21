/**
 * @file pose-worker.mjs
 * Web Worker executing MediaPipe Face Landmarker completely offline.
 * Extracts facial transformation matrix and outputs normalized yaw, pitch, roll.
 */

import { FaceLandmarker, FilesetResolver } from '../vendor/mediapipe/vision_bundle.mjs';

let landmarker = null;
let currentSessionId = 0;
let isInitializing = false;

/**
 * Extract yaw, pitch, roll (degrees) from 4x4 facial transformation matrix.
 * Coordinate convention:
 *   yawDeg > 0: user turning head to their RIGHT
 *   pitchDeg > 0: user tilting head UP
 *   rollDeg: tilt to side
 * @param {number[] | Float32Array} m 16-element matrix (column-major)
 * @returns {{ yawDeg: number, pitchDeg: number, rollDeg: number }}
 */
export function matrixToEulerDegrees(m) {
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
export function landmarksToEulerDegrees(landmarks) {
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

async function initLandmarker() {
  if (landmarker) return landmarker;
  if (isInitializing) return null;

  isInitializing = true;
  try {
    const fileset = await FilesetResolver.forVisionTasks('../vendor/mediapipe/wasm');
    landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: '../models/face_landmarker.task',
        delegate: 'CPU'
      },
      outputFacialTransformationMatrixes: true,
      outputFaceBlendshapes: false,
      runningMode: 'VIDEO',
      numFaces: 1
    });
    isInitializing = false;
    return landmarker;
  } catch (err) {
    isInitializing = false;
    throw err;
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
      const results = landmarker.detectForVideo(bitmap, Math.round(capturedAtMs));
      bitmap.close();

      if (sessionId !== currentSessionId) return;

      if (!results || !results.faceLandmarks || results.faceLandmarks.length === 0) {
        self.postMessage({
          type: 'status',
          sessionId,
          state: 'tracking-lost',
          code: 'TRACKING_LOST'
        });
        return;
      }

      let pose;
      if (
        results.facialTransformationMatrixes &&
        results.facialTransformationMatrixes.length > 0 &&
        results.facialTransformationMatrixes[0].data
      ) {
        pose = matrixToEulerDegrees(results.facialTransformationMatrixes[0].data);
      } else {
        pose = landmarksToEulerDegrees(results.faceLandmarks[0]);
      }

      self.postMessage({
        type: 'pose',
        sample: {
          source: 'webcam',
          sessionId,
          sequence,
          capturedAtMs,
          yawDeg: pose.yawDeg,
          pitchDeg: pose.pitchDeg,
          rollDeg: pose.rollDeg
        }
      });
    } catch (err) {
      if (bitmap && bitmap.close) bitmap.close();
      self.postMessage({
        type: 'status',
        sessionId,
        state: 'error',
        code: 'WORKER_FAILED',
        message: String(err)
      });
    }
  }
};
