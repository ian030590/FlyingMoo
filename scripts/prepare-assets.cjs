'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const VENDOR_SRC = path.join(ROOT, 'node_modules/@mediapipe/tasks-vision');
const VENDOR_DEST = path.join(ROOT, 'wwwroot/vendor/mediapipe');
const MODEL_DEST = path.join(ROOT, 'wwwroot/models/face_landmarker.task');

const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const buffer = fs.readFileSync(filePath);
  hash.update(buffer);
  return hash.digest('hex');
}

async function prepare() {
  console.log('[prepare-assets] Preparing offline MediaPipe assets...');

  // 1. Copy MediaPipe JS / WASM vendor files
  if (!fs.existsSync(VENDOR_SRC)) {
    throw new Error('node_modules/@mediapipe/tasks-vision not found. Run npm install first.');
  }

  fs.mkdirSync(path.join(VENDOR_DEST, 'wasm'), { recursive: true });

  const filesToCopy = [
    { src: 'vision_bundle.mjs', dest: 'vision_bundle.mjs' },
    { src: 'wasm/vision_wasm_internal.js', dest: 'wasm/vision_wasm_internal.js' },
    { src: 'wasm/vision_wasm_internal.wasm', dest: 'wasm/vision_wasm_internal.wasm' },
    { src: 'wasm/vision_wasm_nosimd_internal.js', dest: 'wasm/vision_wasm_nosimd_internal.js' },
    { src: 'wasm/vision_wasm_nosimd_internal.wasm', dest: 'wasm/vision_wasm_nosimd_internal.wasm' }
  ];

  for (const item of filesToCopy) {
    const srcPath = path.join(VENDOR_SRC, item.src);
    const destPath = path.join(VENDOR_DEST, item.dest);
    if (!fs.existsSync(srcPath)) {
      throw new Error(`Missing expected source asset: ${srcPath}`);
    }
    fs.copyFileSync(srcPath, destPath);
    const stats = fs.statSync(destPath);
    console.log(`  Copied: ${item.dest} (${(stats.size / 1024).toFixed(1)} KiB)`);
  }

  // 2. Fetch / verify face_landmarker.task model
  fs.mkdirSync(path.dirname(MODEL_DEST), { recursive: true });
  if (!fs.existsSync(MODEL_DEST) || fs.statSync(MODEL_DEST).size === 0) {
    console.log(`[prepare-assets] Downloading face_landmarker.task model from ${MODEL_URL}...`);
    const res = await fetch(MODEL_URL);
    if (!res.ok) {
      throw new Error(`Failed to download model: HTTP ${res.status}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    fs.writeFileSync(MODEL_DEST, Buffer.from(arrayBuffer));
    console.log(`[prepare-assets] Saved face_landmarker.task (${(arrayBuffer.byteLength / (1024 * 1024)).toFixed(2)} MiB)`);
  }

  const modelHash = sha256File(MODEL_DEST);
  const modelStats = fs.statSync(MODEL_DEST);
  console.log(`[prepare-assets] Verified face_landmarker.task:`);
  console.log(`  Size: ${modelStats.size} bytes`);
  console.log(`  SHA-256: ${modelHash}`);

  // 3. Write asset manifest for offline integrity verification
  const manifest = {
    updatedAt: new Date().toISOString(),
    files: filesToCopy.map(f => {
      const p = path.join(VENDOR_DEST, f.dest);
      return { path: `vendor/mediapipe/${f.dest}`, size: fs.statSync(p).size, sha256: sha256File(p) };
    }).concat([
      { path: 'models/face_landmarker.task', size: modelStats.size, sha256: modelHash }
    ])
  };

  fs.writeFileSync(path.join(ROOT, 'wwwroot/assets-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  console.log('[prepare-assets] Asset preparation complete.');
}

prepare().catch((err) => {
  console.error('[prepare-assets] Error:', err);
  process.exit(1);
});
