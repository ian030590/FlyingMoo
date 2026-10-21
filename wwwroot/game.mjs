/**
 * @file game.mjs
 * Core FlyingMoo game simulation with strict 60 Hz accumulator stepping,
 * Canvas 2D rendering, recorded animal calls, and procedural wind audio.
 */

// Logical resolution & simulation constants
export const STEP = 1 / 60;
export const FOV = 100;
export const CAMD = 1 / Math.tan((FOV / 2) * Math.PI / 180);
export const CAMH = 0;
export const DRAWDIST = 60;
export const SEGLEN = 400;
export const ROADW = 2600;
export const FOGD = 3.2;
export const SPEED_BASE = (SEGLEN / STEP) * 0.30;

export const LIMIT_X = 0.42;
export const LIMIT_Y = 0.42;
export const MOVE_SPEED = 0.9;
export const COW_W = 0.34;
export const COW_H = 0.34;
export const SHEEP_W = 0.14;
export const SHEEP_H = 0.14;

export const SPAWN_GAP_MIN = 90;
export const SPAWN_GAP_MAX = 150;
export const MAX_SHEEP = 4;
export const SHEEP_DIST = 0.40;

function limit(v, mn, mx) { return Math.max(mn, Math.min(v, mx)); }
function interpolate(a, b, p) { return a + (b - a) * p; }
function expFog(d, density) { return 1 / Math.pow(Math.E, d * d * density); }
function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
function randRange(a, b) { return a + Math.random() * (b - a); }
function overlap(a, ha, b, hb) { return Math.abs(a - b) < (ha + hb); }

function loadSprite(filename) {
  if (typeof Image === 'undefined') return null;
  const image = new Image();
  image.src = new URL(`./assets/animals/${filename}`, import.meta.url).href;
  return image;
}

function loadAnimalSound(filename) {
  if (typeof Audio === 'undefined') return null;
  const sound = new Audio(new URL(`./assets/audio/${filename}`, import.meta.url).href);
  sound.preload = 'auto';
  return sound;
}

export class GameEngine {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [callbacks]
   * @param {(stats: any) => void} [callbacks.onDie]
   * @param {(stats: any) => void} [callbacks.onScoreUpdate]
   */
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.callbacks = callbacks;
    this.cowSprite = loadSprite('cow-side.png');
    this.wingSprite = loadSprite('white-wing.svg');
    this.sheepSprite = loadSprite('sheep-cute.png');
    this.sheepSound = loadAnimalSound('sheep-bleat.ogg');
    this.cowSound = loadAnimalSound('cow-moo.mp3');
    this.activeAnimalSounds = new Set();

    this.W = 480;
    this.H = 360;

    // Simulation state
    this.state = 'title'; // 'title' | 'play' | 'paused' | 'dead'
    this.sheep = [];
    this.clouds = [];
    this.stars = [];

    this.position = 0;
    this.cowX = 0;
    this.cowY = 0;
    this.cowBank = 0;
    this.cowPitch = 0;
    this.flap = 0;
    this.speed = SPEED_BASE;

    this.runTime = 0;
    this.dodged = 0;
    this.spawnTimer = 20;

    this.bestTime = 0;
    this.bestDodge = 0;
    this.loadBestScores();

    this.hitFlash = 0;
    this.shake = 0;

    // Fixed-step accumulator
    this.accumulator = 0;
    this.lastFrameTime = performance.now();

    // Direction input reference
    this.currentDirections = { up: false, down: false, left: false, right: false };

    // Wind audio
    this.audioContext = null;
    this.masterGain = null;
    this.windGain = null;
    this.muted = false;
    this.cowVoiceTimer = 4;

    this.buildClouds();
    this.fitCanvas();
  }

  fitCanvas() {
    if (!this.canvas) return;
    const aspect = (typeof window !== 'undefined' && window.innerWidth && window.innerHeight)
      ? window.innerWidth / Math.max(1, window.innerHeight)
      : (480 / 360);
    this.W = Math.max(480, Math.min(960, Math.round(this.H * aspect)));
    const pixelScale = typeof window === 'undefined' ? 1
      : Math.max(1, (window.innerHeight || this.H) / this.H * (window.devicePixelRatio || 1));
    this.canvas.width = Math.round(this.W * pixelScale);
    this.canvas.height = Math.round(this.H * pixelScale);
    this.ctx.setTransform(pixelScale, 0, 0, pixelScale, 0, 0);
  }

  loadBestScores() {
    if (typeof localStorage === 'undefined') {
      this.bestTime = 0;
      this.bestDodge = 0;
      return;
    }
    try {
      this.bestTime = parseFloat(localStorage.getItem('flyingCowBestTime') || '0') || 0;
      this.bestDodge = parseInt(localStorage.getItem('flyingCowBestDodge') || '0', 10) || 0;
    } catch (e) {
      this.bestTime = 0;
      this.bestDodge = 0;
    }
  }

  saveBestScores() {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem('flyingCowBestTime', String(this.bestTime));
      localStorage.setItem('flyingCowBestDodge', String(this.bestDodge));
    } catch (e) {}
  }

  // ---- Audio -------------------------------------------------------------
  initAudio() {
    if (this.audioContext) {
      if (this.audioContext.state === 'suspended') {
        this.audioContext.resume();
      }
      return;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.audioContext = new AC();
      this.masterGain = this.audioContext.createGain();
      this.masterGain.gain.value = this.muted ? 0 : 0.9;
      this.masterGain.connect(this.audioContext.destination);

      // Procedural wind sound
      const buffer = this.audioContext.createBuffer(1, this.audioContext.sampleRate * 2, this.audioContext.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.4;

      const src = this.audioContext.createBufferSource();
      src.buffer = buffer;
      src.loop = true;

      const lp = this.audioContext.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 600;

      this.windGain = this.audioContext.createGain();
      this.windGain.gain.value = 0.03;

      src.connect(lp);
      lp.connect(this.windGain);
      this.windGain.connect(this.masterGain);
      src.start();
    } catch (e) {
      this.audioContext = null;
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.masterGain) {
      this.masterGain.gain.value = this.muted ? 0 : 0.9;
    }
    for (const sound of this.activeAnimalSounds) sound.muted = this.muted;
    return this.muted;
  }

  playAnimalSound(sound, vol) {
    if (!this.audioContext || !sound || this.muted) return;
    const voice = sound.cloneNode();
    voice.volume = Math.max(0, Math.min(1, vol * 0.5));
    voice.onended = () => this.activeAnimalSounds.delete(voice);
    this.activeAnimalSounds.add(voice);
    voice.play().catch(error => {
      this.activeAnimalSounds.delete(voice);
      console.warn('Animal sound playback failed:', error);
    });
  }

  playSheepBleat(vol = 1.0) {
    this.playAnimalSound(this.sheepSound, vol);
  }

  playCowMoo(vol = 0.8) {
    this.playAnimalSound(this.cowSound, vol);
  }

  playScoreBlip() {
    if (!this.audioContext || this.muted) return;
    try {
      const t = this.audioContext.currentTime;
      const o = this.audioContext.createOscillator();
      const g = this.audioContext.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(880, t);
      o.frequency.exponentialRampToValueAtTime(1320, t + 0.09);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.10, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      o.connect(g);
      g.connect(this.masterGain);
      o.start(t);
      o.stop(t + 0.13);
    } catch (e) {}
  }

  // ---- Clouds & Stars ----------------------------------------------------
  cloudLaneX() {
    let x = randRange(-2.4, 2.4);
    if (Math.abs(x) < 1.1) x = (x < 0 ? -1 : 1) * (1.1 + Math.random() * 1.3);
    return x;
  }

  cloudLaneY() {
    let y = randRange(-1.6, 1.6);
    if (Math.abs(y) < 0.9) y = (y < 0 ? -1 : 1) * (0.9 + Math.random() * 0.7);
    return y;
  }

  buildClouds() {
    this.clouds = [];
    for (let i = 0; i < 26; i++) {
      this.clouds.push({
        z: randRange(0, DRAWDIST * SEGLEN),
        x: this.cloudLaneX(),
        y: this.cloudLaneY(),
        size: randRange(0.22, 0.5),
        layer: Math.random() < 0.5 ? 1 : 2
      });
    }
    this.stars = [];
    for (let s = 0; s < 90; s++) {
      this.stars.push({
        x: Math.random(),
        y: Math.random() * 0.62,
        b: randRange(0.25, 1),
        tw: Math.random() * 6.28
      });
    }
  }

  spawnSheep() {
    if (this.sheep.length >= MAX_SHEEP) return;
    const z = this.position + DRAWDIST * SEGLEN;
    const dir = Math.floor(Math.random() * 4);
    let x = 0, y = 0;
    if (dir === 0) y = SHEEP_DIST;
    else if (dir === 1) y = -SHEEP_DIST;
    else if (dir === 2) x = -SHEEP_DIST;
    else x = SHEEP_DIST;

    this.sheep.push({
      z, x, y, alive: true, passed: false,
      phase: Math.random() * 6.28, bob: randRange(0, 6.28)
    });
  }

  // ---- Game State Control ------------------------------------------------
  startGame() {
    this.initAudio();
    this.position = 0;
    this.cowX = 0;
    this.cowY = 0;
    this.cowBank = 0;
    this.cowPitch = 0;
    this.runTime = 0;
    this.dodged = 0;
    this.spawnTimer = 20;
    this.sheep = [];
    this.speed = SPEED_BASE;
    this.hitFlash = 0;
    this.shake = 0;
    this.cowVoiceTimer = 4;
    this.accumulator = 0;
    this.lastFrameTime = performance.now();
    this.state = 'play';
    this.playCowMoo(0.8);
  }

  pauseGame() {
    if (this.state === 'play') {
      this.state = 'paused';
      this.accumulator = 0;
      if (this.windGain) this.windGain.gain.value = 0.01;
    }
  }

  resumeGame() {
    if (this.state === 'paused') {
      this.state = 'play';
      this.accumulator = 0;
      this.lastFrameTime = performance.now();
      if (this.windGain) this.windGain.gain.value = 0.03;
    }
  }

  die() {
    this.state = 'dead';
    this.hitFlash = 1;
    this.shake = 1;
    this.playSheepBleat(1.0);

    let isNewRecord = false;
    if (this.runTime > this.bestTime) {
      this.bestTime = this.runTime;
      isNewRecord = true;
    }
    if (this.dodged > this.bestDodge) {
      this.bestDodge = this.dodged;
      isNewRecord = true;
    }
    this.saveBestScores();

    if (this.callbacks.onDie) {
      this.callbacks.onDie({
        runTime: this.runTime,
        dodged: this.dodged,
        bestTime: this.bestTime,
        bestDodge: this.bestDodge,
        isNewRecord
      });
    }
  }

  // ---- Fixed 60Hz Step Update --------------------------------------------
  /**
   * Run one fixed simulation step of length dt (dt = STEP = 1/60).
   * @param {number} dt
   */
  step(dt) {
    if (this.state !== 'play') {
      this.flap += dt * 4;
      return;
    }

    this.runTime += dt;
    this.flap += dt * (6 + (this.speed / SPEED_BASE) * 3);

    const steer = (this.currentDirections.right ? 1 : 0) - (this.currentDirections.left ? 1 : 0);
    const climb = (this.currentDirections.up ? 1 : 0) - (this.currentDirections.down ? 1 : 0);

    const moveX = steer * MOVE_SPEED * dt;
    const moveY = climb * MOVE_SPEED * dt;

    this.cowX = limit(this.cowX + moveX, -LIMIT_X, LIMIT_X);
    this.cowY = limit(this.cowY + moveY, -LIMIT_Y, LIMIT_Y);

    this.cowBank = interpolate(this.cowBank, steer * 0.5, Math.min(1, dt * 8));
    this.cowPitch = interpolate(this.cowPitch, climb * 0.45, Math.min(1, dt * 8));

    // Survival speed ramp up
    this.speed = SPEED_BASE * (1 + Math.min(1.1, this.runTime / 70));
    this.position += this.speed * dt;

    // Obstacle spawning strictly decrements by 1 each 60Hz step
    this.spawnTimer -= 1;
    if (this.spawnTimer <= 0) {
      this.spawnSheep();
      this.spawnTimer = randInt(SPAWN_GAP_MIN, SPAWN_GAP_MAX);
    }

    // Sheep collision & passing
    for (let i = this.sheep.length - 1; i >= 0; i--) {
      const s = this.sheep[i];
      const dz = s.z - this.position;
      if (dz < -SEGLEN * 6) {
        this.sheep.splice(i, 1);
        continue;
      }

      // Collision window
      const zWin = Math.max(SEGLEN * 0.6, this.speed * STEP * 1.2);
      if (s.alive && Math.abs(dz) < zWin) {
        if (overlap(this.cowX, COW_W, s.x, SHEEP_W) && overlap(this.cowY, COW_H, s.y, SHEEP_H)) {
          s.alive = false;
          this.die();
          return;
        }
      }

      if (!s.passed && dz < -SEGLEN * 0.2) {
        s.passed = true;
        this.dodged++;
        this.playSheepBleat(0.8);
        if (this.callbacks.onScoreUpdate) {
          this.callbacks.onScoreUpdate({ runTime: this.runTime, dodged: this.dodged });
        }
      }
    }

    // Ambient moo
    this.cowVoiceTimer -= dt;
    if (this.cowVoiceTimer <= 0) {
      this.playCowMoo(0.5 + Math.random() * 0.4);
      this.cowVoiceTimer = randRange(6, 13);
    }

    if (this.windGain) {
      this.windGain.gain.value = 0.02 + Math.min(0.05, (this.speed / SPEED_BASE) * 0.02);
    }

    if (this.hitFlash > 0) this.hitFlash = Math.max(0, this.hitFlash - dt * 2);
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 3);

    // Keep clouds wrapped
    for (let c = 0; c < this.clouds.length; c++) {
      if (this.clouds[c].z - this.position < -SEGLEN * 6) {
        this.clouds[c].z = this.position + randRange(DRAWDIST * SEGLEN * 0.6, DRAWDIST * SEGLEN);
        this.clouds[c].x = this.cloudLaneX();
        this.clouds[c].y = this.cloudLaneY();
      }
    }
  }

  /**
   * Main per-frame tick with accumulator stepping.
   * @param {number} now Frame timestamp in ms
   * @param {{ up: boolean, down: boolean, left: boolean, right: boolean }} directions
   */
  tick(now, directions) {
    this.currentDirections = directions;

    if (this.state === 'play') {
      const dt = Math.min(0.05, (now - this.lastFrameTime) / 1000);
      this.lastFrameTime = now;
      this.accumulator += dt;

      let steps = 0;
      while (this.accumulator >= STEP && steps < 5) {
        this.step(STEP);
        this.accumulator -= STEP;
        steps++;
      }

      // Drop excess accumulator if lagging behind
      if (this.accumulator > STEP) {
        this.accumulator = 0;
      }
    } else {
      this.lastFrameTime = now;
      this.step(STEP);
    }

    this.render();
  }

  // ---- Rendering ---------------------------------------------------------
  project(p, camX, camY, camZ, camDepth, w, h, roadW) {
    p.camera.x = (p.world.x || 0) - camX;
    p.camera.y = (p.world.y || 0) - camY;
    p.camera.z = (p.world.z || 0) - camZ;
    p.screen.scale = camDepth / p.camera.z;
    p.screen.x = Math.round(w / 2 + (p.screen.scale * p.camera.x * w / 2));
    p.screen.y = Math.round(h / 2 - (p.screen.scale * p.camera.y * h / 2));
    p.screen.w = Math.round(p.screen.scale * roadW * w / 2);
  }

  render() {
    const ctx = this.ctx;
    const W = this.W;
    const H = this.H;

    const shakeX = this.shake > 0 ? (Math.random() - 0.5) * this.shake * 14 : 0;
    const shakeY = this.shake > 0 ? (Math.random() - 0.5) * this.shake * 14 : 0;

    ctx.save();
    ctx.translate(shakeX, shakeY);

    this.drawSky();
    this.drawClouds(2);
    this.drawClouds(1);
    this.drawSheep();
    this.drawCow();
    this.drawDodgeHint();

    ctx.restore();

    if (this.hitFlash > 0) {
      ctx.fillStyle = `rgba(255,60,60,${this.hitFlash * 0.5})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  drawSky() {
    const ctx = this.ctx;
    const W = this.W;
    const H = this.H;

    const g = ctx.createLinearGradient(0, 0, 0, H * 0.7);
    g.addColorStop(0, '#0a0f26');
    g.addColorStop(0.5, '#16224a');
    g.addColorStop(1, '#2a3f6b');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    for (let i = 0; i < this.stars.length; i++) {
      const st = this.stars[i];
      const tw = 0.6 + 0.4 * Math.sin(this.flap * 0.8 + st.tw);
      ctx.globalAlpha = st.b * tw;
      ctx.fillStyle = '#cfe0ff';
      ctx.fillRect(Math.floor(st.x * W), Math.floor(st.y * H), 1, 1);
    }
    ctx.globalAlpha = 1;

    // Moon
    ctx.fillStyle = '#e9f0ff';
    ctx.beginPath();
    ctx.arc(W * 0.82, H * 0.16, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#16224a';
    ctx.beginPath();
    ctx.arc(W * 0.79, H * 0.145, 14, 0, Math.PI * 2);
    ctx.fill();
  }

  drawClouds(layer) {
    const ctx = this.ctx;
    const camX = this.cowX * ROADW;
    const camY = CAMH + this.cowY * ROADW;
    const list = [];

    for (let i = 0; i < this.clouds.length; i++) {
      const c = this.clouds[i];
      if (c.layer !== layer) continue;
      const dz = c.z - this.position;
      if (dz < SEGLEN * 5 || dz > DRAWDIST * SEGLEN) continue;
      list.push({ c, dz });
    }
    list.sort((a, b) => b.dz - a.dz);

    for (let k = 0; k < list.length; k++) {
      const c2 = list[k].c;
      const p = { world: { x: c2.x * ROADW, y: c2.y * ROADW, z: c2.z }, camera: {}, screen: {} };
      this.project(p, camX, camY, this.position, CAMD, this.W, this.H, ROADW);
      if (p.camera.z <= CAMD) continue;
      const fog = expFog(list[k].dz / (DRAWDIST * SEGLEN), FOGD);
      const size = p.screen.scale * ROADW * this.W / 2 * c2.size;
      if (size < 2) continue;
      ctx.globalAlpha = fog * (layer === 2 ? 0.22 : 0.32);
      ctx.fillStyle = layer === 2 ? '#2b3d63' : '#35496f';
      this.puff(p.screen.x, p.screen.y, size);
    }
    ctx.globalAlpha = 1;
  }

  puff(x, y, s) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, s, 0, Math.PI * 2);
    ctx.arc(x - s * 0.7, y + s * 0.2, s * 0.7, 0, Math.PI * 2);
    ctx.arc(x + s * 0.7, y + s * 0.2, s * 0.7, 0, Math.PI * 2);
    ctx.arc(x, y - s * 0.5, s * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }

  drawSheep() {
    const camX = this.cowX * ROADW;
    const camY = CAMH + this.cowY * ROADW;
    const list = [];

    for (let i = 0; i < this.sheep.length; i++) {
      const s = this.sheep[i];
      const dz = s.z - this.position;
      if (dz < -SEGLEN * 2 || dz > DRAWDIST * SEGLEN) continue;
      list.push({ s, dz });
    }
    list.sort((a, b) => b.dz - a.dz);

    for (let k = 0; k < list.length; k++) {
      const sh = list[k].s;
      const p = { world: { x: sh.x * ROADW, y: sh.y * ROADW, z: sh.z }, camera: {}, screen: {} };
      this.project(p, camX, camY, this.position, CAMD, this.W, this.H, ROADW);
      if (p.camera.z <= CAMD) continue;
      const fog = expFog(list[k].dz / (DRAWDIST * SEGLEN), FOGD);
      const size = p.screen.scale * ROADW * this.W / 2 * 0.30;
      if (size < 2) continue;
      this.drawSheepSprite(p.screen.x, p.screen.y, size, fog, list[k].dz);
    }
  }

  drawSheepSprite(x, y, s, fog, dz) {
    const ctx = this.ctx;
    const sheep = this.sheepSprite;
    if (sheep?.complete && sheep.naturalWidth) {
      const width = s * 2.3;
      const height = width * sheep.naturalHeight / sheep.naturalWidth;
      ctx.save();
      ctx.globalAlpha = fog;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(sheep, x - width / 2, y - height / 2, width, height);
      ctx.restore();
    }

    if (dz < SEGLEN * 3 && dz > 0) {
      ctx.globalAlpha = 0.35 * (1 - dz / (SEGLEN * 3));
      ctx.strokeStyle = '#ff5a5a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, s * 0.9, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  drawCow() {
    if (this.state === 'dead') return;
    const cow = this.cowSprite;
    if (!cow?.complete || !cow.naturalWidth) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(this.W / 2, this.H / 2);
    ctx.rotate(this.cowBank * 0.35);
    ctx.scale(this.H / 360, this.H / 360);
    ctx.imageSmoothingEnabled = true;
    const glowScale = this.canvas.height / 360;
    ctx.filter = `drop-shadow(0 0 ${1.2 * glowScale}px #fffef2) drop-shadow(0 0 ${3.5 * glowScale}px #fff6a0) drop-shadow(0 0 ${7 * glowScale}px #ffe14a)`;

    const wing = this.wingSprite;
    const flap = Math.sin(this.flap * 2.2) * 0.25;
    const drawWing = (angle, alpha) => {
      if (!wing?.complete || !wing.naturalWidth) return;
      ctx.save();
      ctx.translate(26, -20);
      ctx.rotate(angle);
      ctx.globalAlpha = alpha;
      ctx.drawImage(wing, -2, -56, 68, 98);
      ctx.restore();
    };
    drawWing(-2.35 - flap, 0.8);
    const width = 150;
    ctx.drawImage(cow, -width / 2, -32, width, width * cow.naturalHeight / cow.naturalWidth);
    drawWing(-1.8 + flap, 1);
    ctx.restore();
  }

  drawDodgeHint() {
    if (this.state !== 'play') return;

    let nearest = null;
    let ndz = Infinity;
    for (let i = 0; i < this.sheep.length; i++) {
      const s = this.sheep[i];
      const dz = s.z - this.position;
      if (dz > 0 && dz < ndz) {
        ndz = dz;
        nearest = s;
      }
    }
    if (!nearest) return;

    let dx = 0, dy = 0;
    if (nearest.x > 0.01) dx = -1; else if (nearest.x < -0.01) dx = 1;
    if (nearest.y > 0.01) dy = 1; else if (nearest.y < -0.01) dy = -1;
    if (dx === 0 && dy === 0) return;

    const cx = this.W / 2;
    const cy = this.H / 2;
    const dist = Math.min(this.W, this.H) * 0.22;
    const ax = cx + dx * dist;
    const ay = cy + dy * dist;

    const pulse = 0.55 + 0.45 * Math.sin(this.flap * 6);
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.45 + 0.45 * pulse;
    ctx.fillStyle = '#5effa0';
    ctx.strokeStyle = '#0b3a1e';
    ctx.lineWidth = 2;

    ctx.translate(ax, ay);
    const ang = Math.atan2(dy, dx);
    ctx.rotate(ang);
    const t = 12;
    ctx.beginPath();
    ctx.moveTo(t, 0);
    ctx.lineTo(-t * 0.7, t * 0.8);
    ctx.lineTo(-t * 0.7, -t * 0.8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}
