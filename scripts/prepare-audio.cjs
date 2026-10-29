'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'assets/processed');
const gameAudio = path.join(root, 'wwwroot/assets/audio');
const clips = [
  { name: 'pig-grunt', source: 'New Recording 21.m4a', start: 1.60, end: 4.90, noiseStart: 0.43, noiseEnd: 0.73 },
  { name: 'cow-moo-take-2', source: 'New Recording 21.m4a', start: 5.27, end: 7.34, noiseStart: 0.43, noiseEnd: 0.73 },
  { name: 'sheep-bleat', source: 'New Recording 21.m4a', start: 8.62, end: 10.06, noiseStart: 0.43, noiseEnd: 0.73, game: true },
  { name: 'cow-moo', source: '哞.m4a', start: 2.64, end: 4.06, noiseStart: 0.12, noiseEnd: 0.48, game: true }
];

function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stderr;
}

function loudness(input, filter = '') {
  const log = ffmpeg(['-i', input, '-af', [filter, 'loudnorm=I=-14:TP=-1.5:LRA=7:print_format=json'].filter(Boolean).join(','), '-f', 'null', '-']);
  const match = log.match(/\{\s*"input_i"[\s\S]*?\}/);
  if (!match) throw new Error(`Loudness measurement missing: ${input}`);
  return JSON.parse(match[0]);
}

fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(gameAudio, { recursive: true });
const report = [];
for (const clip of clips) {
  const input = path.join(root, 'assets', clip.source);
  const duration = clip.end - clip.start;
  const trim = `atrim=start=${clip.start}:end=${clip.end},asetpts=PTS-STARTPTS`;
  const compressor = clip.name === 'pig-grunt' ? 'acompressor=threshold=0.06:ratio=6:attack=0.2:release=60:knee=4' :
    'acompressor=threshold=0.15:ratio=3:attack=3:release=100:knee=4';
  const cleanup = `highpass=f=70,lowpass=f=8000,asendcmd=c='${clip.noiseStart} afftdn sn start;${clip.noiseEnd} afftdn sn stop',afftdn=nr=10:nf=-45:gs=5,${trim},${compressor},afade=t=in:d=0.012,afade=t=out:st=${duration - 0.06}:d=0.06`;
  const before = loudness(input, trim);
  const measured = loudness(input, cleanup);
  const normalize = `loudnorm=I=-14:TP=-1.5:LRA=7:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`;
  const wav = path.join(output, `${clip.name}.wav`);
  ffmpeg(['-i', input, '-af', `${cleanup},${normalize}`, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s24le', '-map_metadata', '-1', wav]);
  const after = loudness(wav);
  const entry = { name: clip.name, source: clip.source, startSec: clip.start, endSec: clip.end,
    noiseProfileSec: [clip.noiseStart, clip.noiseEnd], sourceLufs: Number(before.input_i),
    processedLufs: Number(after.input_i), processedTruePeakDb: Number(after.input_tp) };
  if (clip.game) {
    const mp3 = path.join(gameAudio, `${clip.name}.mp3`);
    ffmpeg(['-i', wav, '-ar', '48000', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', '-map_metadata', '-1', mp3]);
    const encoded = loudness(mp3);
    entry.gameFile = `assets/audio/${clip.name}.mp3`;
    entry.gameLufs = Number(encoded.input_i);
    entry.gameTruePeakDb = Number(encoded.input_tp);
    if (entry.gameTruePeakDb > -0.5 || !Number.isFinite(entry.gameLufs)) throw new Error(`Encoded audio needs review: ${clip.name}`);
  }
  report.push(entry);
  console.log(`${clip.name}: ${entry.sourceLufs} -> ${entry.processedLufs} LUFS, peak ${entry.processedTruePeakDb} dBTP`);
}
fs.writeFileSync(path.join(output, 'audio-report.json'), JSON.stringify({ targetLufs: -14, targetTruePeakDb: -1.5,
  processing: '70 Hz high-pass, 8 kHz low-pass, sampled-noise FFT denoising (10 dB), compression (pig 6:1, others 3:1), 12/60 ms fades, two-pass loudness normalization', clips: report }, null, 2) + '\n');
