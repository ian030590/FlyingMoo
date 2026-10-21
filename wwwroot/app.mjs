/**
 * @file app.mjs
 * Main UI orchestrator, lifecycle coordinator, and state machine manager.
 */

import { InputManager } from './input.mjs';
import { HeadControlMapper, DEFAULT_THRESHOLDS } from './head-control.mjs';
import { GameEngine, STEP } from './game.mjs';
import { WebcamProvider } from './providers/webcam.mjs';
import { TobiiProvider } from './providers/tobii.mjs';
import { desktop } from './desktop.mjs';

const SETTINGS_KEY = 'flyingMooSettings_v1';

class AppController {
  constructor() {
    this.canvas = document.getElementById('game');
    this.input = new InputManager();
    this.headMapper = new HeadControlMapper();

    this.webcamProvider = new WebcamProvider();
    this.tobiiProvider = new TobiiProvider();
    this.currentProvider = null;

    this.sessionId = 1;
    this.state = 'title'; // 'title' | 'calibrating' | 'countdown' | 'play' | 'paused' | 'dead'
    this.calibPhase = 'neutral'; // 'neutral' | 'directions' | 'ready'

    this.settings = this.loadSettings();

    // Game engine
    this.game = new GameEngine(this.canvas, {
      onDie: (stats) => this.handleGameOver(stats),
      onScoreUpdate: (stats) => this.handleScoreUpdate(stats)
    });

    // Tracking & pause health check
    this.headCenteredStart = 0;
    this.isHeadCenteredAndStable = false;
    this.pauseReasonText = '玩家主動暫停';

    this.bindEvents();
    this.initUi();
    this.applySettingsToMappers();

    // Start requestAnimationFrame loop
    this.startMainLoop();
  }

  loadSettings() {
    const defaults = {
      schemaVersion: 1,
      source: 'keyboard',
      webcam: {
        yawActive: 12,
        pitchActive: 10,
        preferredDeviceId: '',
        showPip: true,
        mirror: true
      },
      tobii: {
        yawActive: 12,
        pitchActive: 10
      }
    };
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.schemaVersion === 1) {
          return { ...defaults, ...parsed };
        }
      }
    } catch (e) {}
    return defaults;
  }

  saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch (e) {}
  }

  applySettingsToMappers() {
    const s = this.settings.source;
    if (s === 'webcam') {
      this.headMapper.setSensitivity(this.settings.webcam.yawActive, this.settings.webcam.pitchActive);
    } else if (s === 'tobii') {
      this.headMapper.setSensitivity(this.settings.tobii.yawActive, this.settings.tobii.pitchActive);
    }
  }

  initUi() {
    this.updateBestScoreDisplays();

    // Source radios
    const radios = document.querySelectorAll('input[name="inputSource"]');
    radios.forEach(r => {
      if (r.value === this.settings.source) r.checked = true;
      r.addEventListener('change', () => this.handleSourceChange(r.value));
    });

    // If Tobii is not available (e.g. standard browser), indicate clearly
    const tobiiContainer = document.getElementById('tobii-option-container');
    if (!desktop.isAvailable && tobiiContainer) {
      tobiiContainer.classList.add('disabled');
      const radio = tobiiContainer.querySelector('input');
      if (radio && radio.value === 'tobii' && this.settings.source === 'tobii') {
        this.settings.source = 'keyboard';
        const kbRadio = document.querySelector('input[name="inputSource"][value="keyboard"]');
        if (kbRadio) kbRadio.checked = true;
      }
    }

    this.updateSourceStatusDisplay();
    this.updateSettingsModalInputs();
  }

  updateBestScoreDisplays() {
    const fmt = (t) => {
      const m = Math.floor(t / 60);
      const s = Math.floor(t % 60);
      const cs = Math.floor((t * 100) % 100);
      return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}.${cs < 10 ? '0' : ''}${cs}`;
    };
    const t = fmt(this.game.bestTime);
    const d = this.game.bestDodge;

    const elTime = document.getElementById('title-best-time');
    const elDodge = document.getElementById('title-best-dodge');
    const elHudBest = document.getElementById('hud-best');
    const elDeadBest = document.getElementById('dead-best');

    if (elTime) elTime.textContent = t;
    if (elDodge) elDodge.textContent = String(d);
    if (elHudBest) elHudBest.textContent = `${t} / ${d}羊`;
    if (elDeadBest) elDeadBest.textContent = `${t} / ${d} 隻`;
  }

  updateSourceStatusDisplay() {
    const stEl = document.getElementById('source-status-text');
    const s = this.settings.source;
    if (!stEl) return;

    if (s === 'keyboard') {
      stEl.textContent = '來源就緒：使用鍵盤方向控制 (WASD 或 方向鍵)';
      stEl.style.color = 'var(--accent-green)';
    } else if (s === 'webcam') {
      stEl.textContent = '頭部追蹤：使用筆電鏡頭/Webcam，點擊開始進入校正';
      stEl.style.color = 'var(--border-cyan)';
    } else if (s === 'tobii') {
      if (desktop.isAvailable) {
        stEl.textContent = '頭部追蹤：使用 Tobii Eye Tracker 5 (TGI)';
        stEl.style.color = 'var(--border-cyan)';
      } else {
        stEl.textContent = 'Tobii 僅能在 Windows 桌面程式環境中執行';
        stEl.style.color = 'var(--warning-amber)';
      }
    }
  }

  // ---- Event Bindings ----------------------------------------------------
  bindEvents() {
    // Window resize
    window.addEventListener('resize', () => {
      if (this.game) this.game.fitCanvas();
    });

    // Window focus / blur / visibility
    window.addEventListener('blur', () => {
      if (this.state === 'play' || this.state === 'countdown') {
        this.pauseGameWithReason('視窗失焦已暫停');
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden && (this.state === 'play' || this.state === 'countdown')) {
        this.pauseGameWithReason('視窗最小化或切換分頁已暫停');
      }
    });

    // Keyboard handling
    window.addEventListener('keydown', (e) => {
      this.input.handleKeyDown(e);
    });
    window.addEventListener('keyup', (e) => {
      this.input.handleKeyUp(e);
    });

    // Input actions
    this.input.setOnAction((action) => {
      this.handleUserAction(action);
    });

    // Canvas click to start/restart
    this.canvas.addEventListener('click', () => {
      if (this.state === 'title' || this.state === 'dead') {
        this.handleUserAction('space');
      }
    });

    // Buttons: Title screen
    document.getElementById('btn-title-start')?.addEventListener('click', () => this.handleUserAction('space'));
    document.getElementById('btn-title-settings')?.addEventListener('click', () => this.openSettingsModal());
    document.getElementById('btn-title-help')?.addEventListener('click', () => this.openHelpModal());

    // Buttons: Calibration screen
    document.getElementById('btn-calib-recenter')?.addEventListener('click', () => this.restartCalibration());
    document.getElementById('btn-calib-settings')?.addEventListener('click', () => this.openSettingsModal());
    document.getElementById('btn-calib-cancel')?.addEventListener('click', () => this.fallbackToKeyboard());
    document.getElementById('btn-calib-start')?.addEventListener('click', () => this.startCountdown());

    // Buttons: Pause screen
    document.getElementById('btn-pause-resume')?.addEventListener('click', () => this.resumeGameIfAllowed());
    document.getElementById('btn-pause-recenter')?.addEventListener('click', () => this.handleRecenter());
    document.getElementById('btn-pause-switch')?.addEventListener('click', () => this.openSettingsModal());
    document.getElementById('btn-pause-menu')?.addEventListener('click', () => this.returnToTitle());

    // Buttons: Dead screen
    document.getElementById('btn-dead-restart')?.addEventListener('click', () => this.handleUserAction('space'));
    document.getElementById('btn-dead-menu')?.addEventListener('click', () => this.returnToTitle());

    // Buttons: HUD
    document.getElementById('btn-hud-pause')?.addEventListener('click', () => this.pauseGameWithReason('玩家主動暫停'));
    document.getElementById('btn-hud-recenter')?.addEventListener('click', () => this.handleRecenter());
    document.getElementById('btn-hud-mute')?.addEventListener('click', () => this.handleMuteToggle());

    // Settings Modal
    document.getElementById('btn-settings-close')?.addEventListener('click', () => this.closeSettingsModal());
    document.getElementById('btn-settings-save')?.addEventListener('click', () => this.saveSettingsModal());
    document.getElementById('btn-settings-reset')?.addEventListener('click', () => this.resetSettingsToDefaults());
    document.getElementById('btn-enable-camera')?.addEventListener('click', () => this.requestCameraPermission());

    // Sliders live readout
    const sliderYaw = document.getElementById('slider-yaw');
    const sliderPitch = document.getElementById('slider-pitch');
    sliderYaw?.addEventListener('input', (e) => {
      const v = Number(e.target.value);
      document.getElementById('val-yaw').textContent = `${v}°`;
      document.getElementById('val-yaw-release').textContent = `${(v * (2 / 3)).toFixed(1)}°`;
    });
    sliderPitch?.addEventListener('input', (e) => {
      const v = Number(e.target.value);
      document.getElementById('val-pitch').textContent = `${v}°`;
      document.getElementById('val-pitch-release').textContent = `${(v * 0.6).toFixed(1)}°`;
    });

    // Help Modal
    document.getElementById('btn-help-close')?.addEventListener('click', () => this.closeHelpModal());
    document.getElementById('btn-help-ok')?.addEventListener('click', () => this.closeHelpModal());
  }

  // ---- State Transitions -------------------------------------------------
  async handleSourceChange(newSource) {
    if (this.currentProvider) {
      await this.currentProvider.stop();
      this.currentProvider = null;
    }
    this.settings.source = newSource;
    this.input.setSource(newSource);
    this.saveSettings();
    this.applySettingsToMappers();
    this.updateSourceStatusDisplay();

    // Recenter HUD button display
    const btnRecenter = document.getElementById('btn-hud-recenter');
    if (btnRecenter) {
      if (newSource === 'keyboard') btnRecenter.classList.add('hidden');
      else btnRecenter.classList.remove('hidden');
    }
  }

  async handleUserAction(action) {
    if (action === 'mute') {
      this.handleMuteToggle();
      return;
    }

    if (action === 'recenter') {
      this.handleRecenter();
      return;
    }

    if (action === 'escape') {
      if (this.isModalOpen()) {
        this.closeSettingsModal();
        this.closeHelpModal();
        return;
      }
      if (this.state === 'play' || this.state === 'countdown') {
        this.pauseGameWithReason('玩家主動暫停');
        return;
      }
      if (this.state === 'calibrating') {
        this.fallbackToKeyboard();
        return;
      }
      if (this.state === 'paused') {
        this.returnToTitle();
        return;
      }
    }

    if (action === 'space') {
      if (this.state === 'title') {
        this.beginGameFlow();
      } else if (this.state === 'calibrating' && this.calibPhase === 'ready') {
        this.startCountdown();
      } else if (this.state === 'paused') {
        this.resumeGameIfAllowed();
      } else if (this.state === 'dead') {
        this.beginGameFlow();
      }
    }
  }

  handleMuteToggle() {
    const isMuted = this.game.toggleMute();
    const btn = document.getElementById('btn-hud-mute');
    if (btn) btn.textContent = isMuted ? '音效: 靜音' : '音效: 開';
  }

  handleRecenter() {
    if (this.settings.source === 'keyboard') return;
    // Fast recenter: take current filtered angles as baseline
    this.headMapper.setNeutralBaseline(this.headMapper.filteredYaw, this.headMapper.filteredPitch);
    if (this.state === 'paused') {
      this.isHeadCenteredAndStable = true;
      this.updatePauseScreenCenterStatus(true);
    }
  }

  isModalOpen() {
    return !document.getElementById('settings-modal').classList.contains('hidden') ||
           !document.getElementById('help-modal').classList.contains('hidden');
  }

  async beginGameFlow() {
    this.sessionId++;
    const source = this.settings.source;

    if (source === 'keyboard') {
      this.startCountdown();
      return;
    }

    // Head tracking source
    this.showScreen('calib-screen');
    this.calibPhase = 'neutral';
    this.headMapper.startCalibration(performance.now());
    this.updateCalibrationUi('neutral', 0, '採集數據中... (0%)');

    const btnStart = document.getElementById('btn-calib-start');
    if (btnStart) btnStart.classList.add('hidden');

    try {
      if (source === 'webcam') {
        this.currentProvider = this.webcamProvider;
        await this.webcamProvider.start(
          this.sessionId,
          (msg) => this.handleProviderMessage(msg),
          this.settings.webcam.preferredDeviceId
        );
        this.setupPipVideo(this.webcamProvider.video);
      } else if (source === 'tobii') {
        this.currentProvider = this.tobiiProvider;
        await this.tobiiProvider.start(
          this.sessionId,
          (msg) => this.handleProviderMessage(msg)
        );
      }
    } catch (err) {
      alert(`啟動來源失敗: ${err.message || err}`);
      this.fallbackToKeyboard();
    }
  }

  setupPipVideo(videoEl) {
    const pip = document.getElementById('pip-container');
    const pipVideo = document.getElementById('pip-video');
    if (!pip || !pipVideo) return;

    if (this.settings.webcam.showPip && videoEl && videoEl.srcObject) {
      pipVideo.srcObject = videoEl.srcObject;
      pip.classList.remove('hidden');
      if (this.settings.webcam.mirror) {
        pipVideo.classList.remove('no-mirror');
      } else {
        pipVideo.classList.add('no-mirror');
      }
    } else {
      pip.classList.add('hidden');
    }
  }

  restartCalibration() {
    this.calibPhase = 'neutral';
    this.headMapper.startCalibration(performance.now());
    this.updateCalibrationUi('neutral', 0, '重新採集中立數據...');
    const btnStart = document.getElementById('btn-calib-start');
    if (btnStart) btnStart.classList.add('hidden');
  }

  fallbackToKeyboard() {
    if (this.currentProvider) {
      this.currentProvider.stop();
      this.currentProvider = null;
    }
    const pip = document.getElementById('pip-container');
    if (pip) pip.classList.add('hidden');

    this.settings.source = 'keyboard';
    this.input.setSource('keyboard');
    this.saveSettings();
    this.showScreen('title-screen');
    const kbRadio = document.querySelector('input[name="inputSource"][value="keyboard"]');
    if (kbRadio) kbRadio.checked = true;
    this.updateSourceStatusDisplay();
  }

  startCountdown() {
    this.showScreen('countdown-screen');
    const countEl = document.getElementById('countdown-number');
    let count = 3;

    if (countEl) countEl.textContent = String(count);
    this.game.playScoreBlip();

    const timer = setInterval(() => {
      count--;
      if (count > 0) {
        if (countEl) countEl.textContent = String(count);
        this.game.playScoreBlip();
      } else if (count === 0) {
        if (countEl) countEl.textContent = 'GO!';
        this.game.playCowMoo(0.6);
      } else {
        clearInterval(timer);
        this.enterPlaying();
      }
    }, 900);
  }

  enterPlaying() {
    this.showScreen('hud');
    this.state = 'play';
    this.game.startGame();
  }

  pauseGameWithReason(reason) {
    if (this.state !== 'play' && this.state !== 'countdown') return;

    this.pauseReasonText = reason;
    this.state = 'paused';
    this.game.pauseGame();
    this.input.reset();

    const reasonEl = document.getElementById('pause-reason');
    if (reasonEl) reasonEl.textContent = `暫停原因: ${reason}`;

    this.isHeadCenteredAndStable = false;
    this.headCenteredStart = 0;
    this.updatePauseScreenCenterStatus(false);

    this.showScreen('pause-screen');
  }

  updatePauseScreenCenterStatus(isCentered) {
    const dot = document.getElementById('pause-center-dot');
    const text = document.getElementById('pause-center-text');
    const btnResume = document.getElementById('btn-pause-resume');

    if (this.settings.source === 'keyboard') {
      if (dot) dot.classList.add('centered');
      if (text) text.textContent = '鍵盤模式：可直接繼續';
      if (btnResume) btnResume.removeAttribute('disabled');
      return;
    }

    if (isCentered) {
      if (dot) dot.classList.add('centered');
      if (text) text.textContent = '頭部已回正穩定，可繼續遊戲！';
      if (btnResume) btnResume.removeAttribute('disabled');
    } else {
      if (dot) dot.classList.remove('centered');
      if (text) text.textContent = '請將頭部回正螢幕中央 (需穩定 0.5 秒)...';
      if (btnResume) btnResume.setAttribute('disabled', 'true');
    }
  }

  resumeGameIfAllowed() {
    if (this.settings.source !== 'keyboard' && !this.isHeadCenteredAndStable) {
      return;
    }
    this.startCountdown();
  }

  returnToTitle() {
    if (this.currentProvider) {
      this.currentProvider.stop();
      this.currentProvider = null;
    }
    const pip = document.getElementById('pip-container');
    if (pip) pip.classList.add('hidden');

    this.input.reset();
    this.game.pauseGame();
    this.showScreen('title-screen');
    this.updateBestScoreDisplays();
  }

  handleGameOver(stats) {
    this.state = 'dead';
    this.input.reset();

    const fmt = (t) => {
      const m = Math.floor(t / 60);
      const s = Math.floor(t % 60);
      const cs = Math.floor((t * 100) % 100);
      return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}.${cs < 10 ? '0' : ''}${cs}`;
    };

    const runEl = document.getElementById('dead-run-time');
    const dodgedEl = document.getElementById('dead-dodged');
    const bestEl = document.getElementById('dead-best');
    const recordBanner = document.getElementById('new-record-banner');

    if (runEl) runEl.textContent = fmt(stats.runTime);
    if (dodgedEl) dodgedEl.textContent = `${stats.dodged} 隻`;
    if (bestEl) bestEl.textContent = `${fmt(stats.bestTime)} / ${stats.bestDodge} 隻`;

    if (recordBanner) {
      if (stats.isNewRecord) recordBanner.classList.remove('hidden');
      else recordBanner.classList.add('hidden');
    }

    this.showScreen('dead-screen');
  }

  handleScoreUpdate(stats) {
    const fmt = (t) => {
      const m = Math.floor(t / 60);
      const s = Math.floor(t % 60);
      const cs = Math.floor((t * 100) % 100);
      return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}.${cs < 10 ? '0' : ''}${cs}`;
    };

    const timeEl = document.getElementById('hud-time');
    const dodgedEl = document.getElementById('hud-dodged');
    if (timeEl) timeEl.textContent = fmt(stats.runTime);
    if (dodgedEl) dodgedEl.textContent = String(stats.dodged);
  }

  showScreen(screenId) {
    const screens = ['title-screen', 'calib-screen', 'countdown-screen', 'pause-screen', 'dead-screen'];
    screens.forEach(s => {
      const el = document.getElementById(s);
      if (el) {
        if (s === screenId) el.classList.remove('hidden');
        else el.classList.add('hidden');
      }
    });

    const hud = document.getElementById('hud');
    if (hud) {
      if (screenId === 'hud' || screenId === 'countdown-screen') {
        hud.classList.remove('hidden');
      } else {
        hud.classList.add('hidden');
      }
    }

    this.state = screenId === 'hud' ? 'play' : screenId.replace('-screen', '');
  }

  // ---- Provider Message Dispatcher ---------------------------------------
  handleProviderMessage(msg) {
    if (!msg || msg.sessionId !== this.sessionId) return;
    const now = performance.now();

    if (msg.type === 'status') {
      const statusBadge = document.getElementById('hud-status-badge');
      if (statusBadge) {
        statusBadge.textContent = `狀態: ${msg.state}`;
      }

      if (msg.state === 'tracking-lost') {
        if (this.state === 'play' || this.state === 'countdown') {
          this.pauseGameWithReason('追蹤中斷：請確認坐姿或相機視角');
        }
      } else if (msg.state === 'error') {
        if (this.state === 'play' || this.state === 'countdown') {
          this.pauseGameWithReason(`裝置異常: ${msg.code || '未知錯誤'}`);
        }
      }
      return;
    }

    if (msg.type === 'pose') {
      const sample = msg.sample;

      // 1. Update calibration screen if calibrating
      if (this.state === 'calibrating') {
        this.processCalibrationSample(sample, now);
        return;
      }

      // 2. Gameplay mapper
      const result = this.headMapper.processSample(sample, now);

      if (result.stale) {
        if (this.state === 'play') {
          this.pauseGameWithReason('姿態訊號過期 (超過 250ms 未收到新資料)');
        }
        return;
      }

      // Feed confirmed directions to input manager
      this.input.setHeadDirections(result.directions);

      // Check return-to-center during pause screen
      if (this.state === 'paused') {
        const isCentered = this.headMapper.isPoseCentered();
        if (isCentered) {
          if (this.headCenteredStart === 0) this.headCenteredStart = now;
          if (now - this.headCenteredStart >= 500) {
            this.isHeadCenteredAndStable = true;
            this.updatePauseScreenCenterStatus(true);
          }
        } else {
          this.headCenteredStart = 0;
          this.isHeadCenteredAndStable = false;
          this.updatePauseScreenCenterStatus(false);
        }
      }
    }
  }

  processCalibrationSample(sample, now) {
    // Update visual crosshair gauge
    const pointer = document.getElementById('gauge-pointer');
    if (pointer) {
      const dYaw = sample.yawDeg - this.headMapper.neutralYaw;
      const dPitch = sample.pitchDeg - this.headMapper.neutralPitch;
      // Clamp to gauge circle (-60px to +60px)
      const x = Math.max(-60, Math.min(60, dYaw * 3.5));
      const y = Math.max(-60, Math.min(60, -dPitch * 3.5));
      pointer.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
    }

    if (this.calibPhase === 'neutral') {
      const calibRes = this.headMapper.updateCalibration(sample, now);
      const percent = Math.round(calibRes.progress * 100);

      this.updateCalibrationUi(
        'neutral',
        calibRes.progress,
        calibRes.reason || `採集數據中... (${percent}%)`
      );

      if (calibRes.status === 'success') {
        this.calibPhase = 'directions';
        this.headMapper.startVerification(now);
      } else if (calibRes.status === 'failed') {
        this.updateCalibrationUi('neutral', 1.0, `校正失敗: ${calibRes.reason || '請重新採集'}`);
      }
    } else if (this.calibPhase === 'directions') {
      const verifRes = this.headMapper.updateVerification(sample, now);

      let stepText = '';
      let stepIcon = '●';
      switch (verifRes.step) {
        case 'up': stepText = '請向上抬頭並維持...'; stepIcon = '▲'; break;
        case 'return-up': stepText = '很好！請回正平視中央...'; stepIcon = '●'; break;
        case 'down': stepText = '請向下低頭並維持...'; stepIcon = '▼'; break;
        case 'return-down': stepText = '很好！請回正平視中央...'; stepIcon = '●'; break;
        case 'left': stepText = '請向左轉頭並維持...'; stepIcon = '◀'; break;
        case 'return-left': stepText = '很好！請回正平視中央...'; stepIcon = '●'; break;
        case 'right': stepText = '請向右轉頭並維持...'; stepIcon = '▶'; break;
        case 'return-right': stepText = '很好！請回正平視中央...'; stepIcon = '●'; break;
        default: break;
      }

      this.updateCalibrationUi(
        'directions',
        verifRes.progress,
        stepText,
        stepIcon
      );

      if (verifRes.completed) {
        this.calibPhase = 'ready';
        this.updateCalibrationUi('ready', 1.0, '校正完成！方向驗證通過！', '✓');
        const btnStart = document.getElementById('btn-calib-start');
        if (btnStart) {
          btnStart.classList.remove('hidden');
          btnStart.focus();
        }
      }
    }
  }

  updateCalibrationUi(phase, progress, msg, icon = '●') {
    const fill = document.getElementById('calib-progress-fill');
    const msgEl = document.getElementById('calib-status-msg');
    const pIcon = document.getElementById('prompt-icon');
    const pText = document.getElementById('prompt-text');

    if (fill) fill.style.width = `${Math.min(100, Math.round(progress * 100))}%`;
    if (msgEl) msgEl.textContent = msg;
    if (pIcon) pIcon.textContent = icon;
    if (pText) pText.textContent = msg;
  }

  // ---- Main Game Loop ----------------------------------------------------
  startMainLoop() {
    const loop = (now) => {
      // 1. Check stale pose watchdog
      if (this.state === 'play' && this.settings.source !== 'keyboard') {
        const isStale = this.headMapper.checkStale(now);
        if (isStale) {
          this.pauseGameWithReason('姿態訊號中斷 (超時未更新)');
        }
      }

      // 2. Snapshot current directions
      const snapshot = this.input.getSnapshot();

      // 3. Update HUD directional lights
      if (this.state === 'play') {
        const upEl = document.getElementById('dir-up');
        const downEl = document.getElementById('dir-down');
        const leftEl = document.getElementById('dir-left');
        const rightEl = document.getElementById('dir-right');
        const centerEl = document.getElementById('dir-center');

        if (upEl) upEl.className = `dir-indicator dir-up ${snapshot.up ? 'active' : ''}`;
        if (downEl) downEl.className = `dir-indicator dir-down ${snapshot.down ? 'active' : ''}`;
        if (leftEl) leftEl.className = `dir-indicator dir-left ${snapshot.left ? 'active' : ''}`;
        if (rightEl) rightEl.className = `dir-indicator dir-right ${snapshot.right ? 'active' : ''}`;
        if (centerEl) {
          const isNeutral = !snapshot.up && !snapshot.down && !snapshot.left && !snapshot.right;
          centerEl.className = `dir-center-dot ${isNeutral ? 'active' : ''}`;
        }
      }

      // 4. Tick game engine
      this.game.tick(now, snapshot);

      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ---- Settings Modal Logic ----------------------------------------------
  async openSettingsModal() {
    this.updateSettingsModalInputs();
    document.getElementById('settings-modal')?.classList.remove('hidden');

    // Populate camera list
    const cameras = await WebcamProvider.getAvailableCameras();
    const select = document.getElementById('camera-select');
    if (select) {
      select.innerHTML = '<option value="">預設相機</option>';
      cameras.forEach(cam => {
        const opt = document.createElement('option');
        opt.value = cam.deviceId;
        opt.textContent = cam.label;
        if (cam.deviceId === this.settings.webcam.preferredDeviceId) {
          opt.selected = true;
        }
        select.appendChild(opt);
      });
    }
  }

  updateSettingsModalInputs() {
    const s = this.settings.source;
    const sourceLabel = document.getElementById('settings-active-source');
    if (sourceLabel) {
      sourceLabel.textContent = s === 'tobii' ? 'Tobii ET5' : s === 'webcam' ? '攝影機' : '鍵盤 (不需調整)';
    }

    const conf = s === 'tobii' ? this.settings.tobii : this.settings.webcam;
    const sliderYaw = document.getElementById('slider-yaw');
    const sliderPitch = document.getElementById('slider-pitch');
    const valYaw = document.getElementById('val-yaw');
    const valPitch = document.getElementById('val-pitch');
    const valYawRel = document.getElementById('val-yaw-release');
    const valPitchRel = document.getElementById('val-pitch-release');

    if (sliderYaw) sliderYaw.value = conf.yawActive;
    if (sliderPitch) sliderPitch.value = conf.pitchActive;
    if (valYaw) valYaw.textContent = `${conf.yawActive}°`;
    if (valPitch) valPitch.textContent = `${conf.pitchActive}°`;
    if (valYawRel) valYawRel.textContent = `${(conf.yawActive * (2 / 3)).toFixed(1)}°`;
    if (valPitchRel) valPitchRel.textContent = `${(conf.pitchActive * 0.6).toFixed(1)}°`;

    const chkPip = document.getElementById('chk-show-pip');
    const chkMirror = document.getElementById('chk-mirror-preview');
    if (chkPip) chkPip.checked = this.settings.webcam.showPip;
    if (chkMirror) chkMirror.checked = this.settings.webcam.mirror;
  }

  closeSettingsModal() {
    document.getElementById('settings-modal')?.classList.add('hidden');
  }

  saveSettingsModal() {
    const s = this.settings.source;
    const sliderYaw = document.getElementById('slider-yaw');
    const sliderPitch = document.getElementById('slider-pitch');
    const chkPip = document.getElementById('chk-show-pip');
    const chkMirror = document.getElementById('chk-mirror-preview');
    const select = document.getElementById('camera-select');

    const yawActive = Number(sliderYaw?.value) || 12;
    const pitchActive = Number(sliderPitch?.value) || 10;

    if (s === 'tobii') {
      this.settings.tobii.yawActive = yawActive;
      this.settings.tobii.pitchActive = pitchActive;
    } else {
      this.settings.webcam.yawActive = yawActive;
      this.settings.webcam.pitchActive = pitchActive;
      if (select) this.settings.webcam.preferredDeviceId = select.value;
      if (chkPip) this.settings.webcam.showPip = chkPip.checked;
      if (chkMirror) this.settings.webcam.mirror = chkMirror.checked;
    }

    this.saveSettings();
    this.applySettingsToMappers();
    this.closeSettingsModal();
  }

  resetSettingsToDefaults() {
    const s = this.settings.source;
    if (s === 'tobii') {
      this.settings.tobii.yawActive = 12;
      this.settings.tobii.pitchActive = 10;
    } else {
      this.settings.webcam.yawActive = 12;
      this.settings.webcam.pitchActive = 10;
      this.settings.webcam.showPip = true;
      this.settings.webcam.mirror = true;
    }
    this.updateSettingsModalInputs();
  }

  async requestCameraPermission() {
    const permStatus = document.getElementById('camera-perm-status');
    try {
      if (permStatus) permStatus.textContent = '請求中...';
      const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      s.getTracks().forEach(t => t.stop());
      if (permStatus) {
        permStatus.textContent = '已允許相機存取';
        permStatus.style.color = 'var(--accent-green)';
      }
      this.openSettingsModal(); // Refresh camera dropdown
    } catch (e) {
      if (permStatus) {
        permStatus.textContent = '相機存取被拒絕或無可用裝置';
        permStatus.style.color = 'var(--danger-red)';
      }
    }
  }

  openHelpModal() {
    document.getElementById('help-modal')?.classList.remove('hidden');
  }

  closeHelpModal() {
    document.getElementById('help-modal')?.classList.add('hidden');
  }
}

// Instantiate controller on DOM load
window.addEventListener('DOMContentLoaded', () => {
  window.flyingMoo = new AppController();
});
