'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const config = require('../src-tauri/tauri.conf.json');

const targetCandidates = [
  path.join(root, 'src-tauri/target/release/flyingmoo.exe'),
  path.join(root, 'src-tauri/target/x86_64-pc-windows-msvc/release/flyingmoo.exe')
];

let sourceExe = targetCandidates.find(p => fs.existsSync(p));

const destination = path.join(root, 'dist', `FlyingMoo_${config.version}_x64-portable.exe`);
fs.mkdirSync(path.dirname(destination), { recursive: true });

if (sourceExe) {
  fs.copyFileSync(sourceExe, destination);
  console.log(`Copied executable to ${destination}`);

  // Calculate SHA256
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(destination));
  const sha256 = hash.digest('hex');
  const bridgeSource = path.join(path.dirname(sourceExe), 'flyingmoo-tobii-bridge.exe');
  const bridgeName = `FlyingMoo_TobiiBridge_${config.version}_x64.exe`;
  if (!fs.existsSync(bridgeSource)) throw new Error('Tobii bridge executable missing. Run npm run build:bridge first.');
  fs.copyFileSync(bridgeSource, path.join(root, 'dist', bridgeName));
  const bridgeHash = crypto.createHash('sha256').update(fs.readFileSync(bridgeSource)).digest('hex');

  fs.writeFileSync(
    path.join(root, 'dist/SHA256SUMS.txt'),
    `${sha256}  FlyingMoo_${config.version}_x64-portable.exe\n${bridgeHash}  ${bridgeName}\n`,
    'utf8'
  );
  console.log(`Generated SHA256: ${sha256}`);
} else {
  console.warn(`[package-portable] Release executable not found in target directories (run tauri build first).`);
}

// Copy docs if present
const docs = ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'docs/SAMPLES.md', 'docs/HEAD_TRACKING.md', 'docs/TOBII.md', 'docs/PWA.md'];
for (const doc of docs) {
  const src = path.join(root, doc);
  if (fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(path.join(root, 'dist', doc)), { recursive: true });
    fs.copyFileSync(src, path.join(root, 'dist', doc));
  }
}
