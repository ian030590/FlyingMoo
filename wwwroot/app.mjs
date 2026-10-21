import { InputManager } from './input.mjs';
import { HeadControlMapper } from './head-control.mjs';
import { GameEngine } from './game.mjs';
import { WebcamProvider } from './providers/webcam.mjs';
import { TobiiProvider } from './providers/tobii.mjs';

const SETTINGS_KEY = 'flyingMooSettings_v1';

export class AppController {
  constructor() {
    this.canvas = document.getElementById('game');
    this.input = new InputManager();
    this.headMapper = new HeadControlMapper();

    this.webcamProvider = new WebcamProvider();
    this.tobiiProvider = new TobiiProvider();
    this.currentProvider = null;
    this.countdownTimer = null;
    this.hasActiveRun = false;
    this.lastPoseSample = null;
    this.modalReturnFocus = null;

    this.sessionId = 1;
    this.state = 'title'; // 'title' | 'calibrating' | 'countdown' | 'play' | 'paused' | 'dead'
    this.calibPhase = 'neutral'; // 'starting' | 'waiting' | 'neutral' | 'directions' | 'ready' | 'error'
    this.calibPhaseStartedAt = 0;

    this.settings = this.loadSettings();

    this.game = new GameEngine(this.canvas, {
      onDie: (stats) => this.handleGameOver(stats),
      onScoreUpdate: (stats) => this.handleScoreUpdate(stats)
    });

    this.headCenteredStart = 0;
    this.isHeadCenteredAndStable = false;
    this.pauseReasonText = '玩家主動暫停';

    this.bindEvents();
    this.initUi();
    this.applySettingsToMappers();
    this.input.setSource(this.settings.source);

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
          return {
            ...defaults,
            source: parsed.source === 'webcam' ? 'webcam' : 'keyboard',
            webcam: { ...defaults.webcam, ...parsed.webcam },
            tobii: { ...defaults.tobii, ...parsed.tobii }
          };
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

    const radios = document.querySelectorAll('input[name="inputSource"]');
    radios.forEach(r => {
      if (r.value === this.settings.source) r.checked = true;
      r.addEventListener('change', () => this.handleSourceChange(r.value));
    });

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
    const hudSource = document.getElementById('hud-source-badge');
    if (hudSource) hudSource.textContent = `來源: ${s === 'webcam' ? '攝影機' : '鍵盤'}`;
    document.getElementById('btn-hud-recenter')?.classList.toggle('hidden', s === 'keyboard');
    document.getElementById('btn-pause-recenter')?.classList.toggle('hidden', s === 'keyboard');
    const status = document.getElementById('hud-status-badge');
    if (status) status.textContent = s === 'keyboard' ? '鍵盤就緒' : '等待頭部追蹤';
    if (!stEl) return;

    if (s === 'keyboard') {
      stEl.textContent = '來源就緒：使用鍵盤方向控制 (WASD 或 方向鍵)';
      stEl.style.color = 'var(--accent-green)';
    } else if (s === 'webcam') {
      stEl.textContent = '頭部追蹤：使用筆電鏡頭/Webcam，點擊開始進入校正';
      stEl.style.color = 'var(--border-cyan)';
    }
  }

  bindEvents() {
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

    window.addEventListener('keydown', (e) => {
      if (this.isModalOpen()) {
        if (e.code === 'Escape') {
          e.preventDefault();
          this.handleUserAction('escape');
        } else if (e.code === 'Tab') {
          this.trapModalFocus(e);
        }
        return;
      }
      if (this.input.handleKeyDown(e)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      this.input.handleKeyUp(e);
    });

    this.input.setOnAction((action) => {
      this.handleUserAction(action);
    });

    // Canvas click to start/restart
    this.canvas.addEventListener('click', () => {
      if (this.state === 'title' || this.state === 'dead') {
        this.handleUserAction('space');
      }
    });

    document.getElementById('btn-title-start')?.addEventListener('click', () => this.handleUserAction('space'));
    document.getElementById('btn-title-settings')?.addEventListener('click', () => this.openSettingsModal());
    document.getElementById('btn-title-help')?.addEventListener('click', () => this.openHelpModal());

    document.getElementById('btn-calib-recenter')?.addEventListener('click', () => this.restartCalibration());
    document.getElementById('btn-calib-settings')?.addEventListener('click', () => this.openSettingsModal());
    document.getElementById('btn-calib-cancel')?.addEventListener('click', () => this.fallbackToKeyboard());
    document.getElementById('btn-calib-start')?.addEventListener('click', () => this.startCountdown());

    document.getElementById('btn-pause-resume')?.addEventListener('click', () => this.resumeGameIfAllowed());
    document.getElementById('btn-pause-recenter')?.addEventListener('click', () => this.handleRecenter());
    document.getElementById('btn-pause-switch')?.addEventListener('click', () => {
      this.returnToTitle();
      document.querySelector('input[name="inputSource"]:checked')?.focus();
    });
    document.getElementById('btn-pause-menu')?.addEventListener('click', () => this.returnToTitle());

    document.getElementById('btn-dead-restart')?.addEventListener('click', () => this.handleUserAction('space'));
    document.getElementById('btn-dead-menu')?.addEventListener('click', () => this.returnToTitle());

    document.getElementById('btn-hud-pause')?.addEventListener('click', () => this.pauseGameWithReason('玩家主動暫停'));
    document.getElementById('btn-hud-recenter')?.addEventListener('click', () => this.handleRecenter());
    document.getElementById('btn-hud-mute')?.addEventListener('click', () => this.handleMuteToggle());

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

    document.getElementById('btn-help-close')?.addEventListener('click', () => this.closeHelpModal());
    document.getElementById('btn-help-ok')?.addEventListener('click', () => this.closeHelpModal());
  }

  async handleSourceChange(newSource) {
    if (newSource !== 'keyboard' && newSource !== 'webcam') return;
    this.sessionId++;
    this.input.reset();
    this.headMapper.sessionId = null;
    this.headMapper.resetFilter();
    this.lastPoseSample = null;
    if (this.currentProvider) {
      await this.currentProvider.stop();
      this.currentProvider = null;
    }
    this.settings.source = newSource;
    this.input.setSource(newSource);
    this.saveSettings();
    this.applySettingsToMappers();
    this.updateSourceStatusDisplay();

  }

  async handleUserAction(action) {
    if (this.isModalOpen() && action !== 'escape') return;
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
    const sample = this.lastPoseSample;
    if (!sample || performance.now() - sample.capturedAtMs > 250) return;
    this.headMapper.setNeutralBaseline(sample.yawDeg, sample.pitchDeg);
    this.input.clearHeadDirections();
    if (this.state === 'paused') {
      this.headCenteredStart = 0;
      this.isHeadCenteredAndStable = false;
      this.updatePauseScreenCenterStatus(false);
    }
  }

  isModalOpen() {
    return !document.getElementById('settings-modal').classList.contains('hidden') ||
           !document.getElementById('help-modal').classList.contains('hidden');
  }

  async beginGameFlow() {
    this.cancelCountdown();
    this.hasActiveRun = false;
    this.input.reset();
    this.lastPoseSample = null;
    this.headMapper.sessionId = null;
    this.sessionId++;
    const sessionId = this.sessionId;
    const source = this.settings.source;

    if (source === 'keyboard') {
      this.startCountdown();
      return;
    }

    this.showScreen('calib-screen');
    this.calibPhase = 'starting';
    this.calibPhaseStartedAt = performance.now();
    this.headMapper.startCalibration(this.calibPhaseStartedAt);
    this.updateCalibrationUi('starting', 0, '正在開啟攝影機…');
    document.getElementById('camera-perm-status').textContent = '正在請求相機';
    document.getElementById('camera-perm-status').style.color = 'var(--text-dim)';
    document.getElementById('btn-calib-recenter').textContent = '重新採集';
    document.getElementById('btn-calib-recenter').disabled = true;

    const btnStart = document.getElementById('btn-calib-start');
    if (btnStart) btnStart.classList.add('hidden');

    try {
      if (source === 'webcam') {
        this.currentProvider = this.webcamProvider;
        await this.webcamProvider.start(
          sessionId,
          (msg) => this.handleProviderMessage(msg),
          this.settings.webcam.preferredDeviceId
        );
      } else if (source === 'tobii') {
        this.currentProvider = this.tobiiProvider;
        await this.tobiiProvider.start(
          this.sessionId,
          (msg) => this.handleProviderMessage(msg)
        );
      }
    } catch (err) {
      if (sessionId === this.sessionId) this.showCalibrationError(`無法啟動攝影機：${err.message || err}`);
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
    if (this.calibPhase === 'error' || !this.currentProvider?.isRunning) {
      this.beginGameFlow();
      return;
    }
    if (!this.webcamProvider.workerReady) return;
    this.waitForCalibrationSample(performance.now(), '請平視螢幕，等待穩定的臉部追蹤資料');
    const btnStart = document.getElementById('btn-calib-start');
    if (btnStart) btnStart.classList.add('hidden');
  }

  fallbackToKeyboard() {
    this.cancelCountdown();
    this.sessionId++;
    this.hasActiveRun = false;
    this.lastPoseSample = null;
    this.input.reset();
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

  cancelCountdown() {
    if (this.countdownTimer !== null) clearInterval(this.countdownTimer);
    this.countdownTimer = null;
  }

  startCountdown(resume = false) {
    this.cancelCountdown();
    this.input.reset();
    this.showScreen('countdown-screen');
    const countEl = document.getElementById('countdown-number');
    let count = 3;

    if (countEl) countEl.textContent = String(count);
    this.game.initAudio();
    this.game.playScoreBlip();

    this.countdownTimer = setInterval(() => {
      count--;
      if (count > 0) {
        if (countEl) countEl.textContent = String(count);
        this.game.playScoreBlip();
      } else if (count === 0) {
        if (countEl) countEl.textContent = 'GO!';
        this.game.playCowMoo(0.6);
      } else {
        this.cancelCountdown();
        if (this.state === 'countdown') this.enterPlaying(resume);
      }
    }, 900);
  }

  enterPlaying(resume = false) {
    this.showScreen('hud');
    this.state = 'play';
    if (resume) this.game.resumeGame();
    else this.game.startGame();
    this.hasActiveRun = true;
  }

  pauseGameWithReason(reason) {
    if (this.state !== 'play' && this.state !== 'countdown') return;
    this.cancelCountdown();

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
    if (this.state !== 'paused') return;
    if (this.settings.source !== 'keyboard' && (!this.isHeadCenteredAndStable ||
        !this.lastPoseSample || performance.now() - this.lastPoseSample.capturedAtMs > 250)) {
      return;
    }
    this.startCountdown(this.hasActiveRun);
  }

  returnToTitle() {
    this.cancelCountdown();
    this.sessionId++;
    this.hasActiveRun = false;
    this.lastPoseSample = null;
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

    this.state = {
      'title-screen': 'title',
      'calib-screen': 'calibrating',
      'countdown-screen': 'countdown',
      'pause-screen': 'paused',
      'dead-screen': 'dead',
      hud: 'play'
    }[screenId];
    const screen = screenId === 'hud' ? this.canvas : document.getElementById(screenId);
    if (!this.isModalOpen()) {
      const target = screen.querySelector?.('.btn-primary:not(:disabled), button:not(:disabled)') || screen;
      target.setAttribute('tabindex', '-1');
      if (target.tagName === 'BUTTON') target.removeAttribute('tabindex');
      target.focus({ preventScroll: true });
    }
  }

  handleProviderMessage(msg) {
    if (!msg || msg.sessionId !== this.sessionId) return;
    const now = performance.now();

    if (msg.type === 'status') {
      const statusBadge = document.getElementById('hud-status-badge');
      if (statusBadge) {
        const labels = { starting: '裝置啟動中', 'camera-ready': '攝影機已開啟，模型載入中', connected: '模型已就緒，等待臉部', 'tracking-lost': '未偵測到頭部', error: '裝置發生錯誤', stopped: '裝置已停止' };
        statusBadge.textContent = labels[msg.state] || '等待頭部追蹤';
      }

      if (msg.state === 'camera-ready') {
        const permission = document.getElementById('camera-perm-status');
        permission.textContent = '已允許相機存取';
        permission.style.color = 'var(--accent-green)';
        if (this.state === 'calibrating' && this.calibPhase === 'starting') {
          this.calibPhaseStartedAt = now;
          this.updateCalibrationUi('starting', 0, '攝影機已開啟，正在載入頭部追蹤模型…');
          this.setupPipVideo(this.webcamProvider.video);
        }
      } else if (msg.state === 'connected' && this.state === 'calibrating' && this.calibPhase === 'starting') {
        this.waitForCalibrationSample(now, '模型已就緒，請將臉部置於鏡頭中央並平視螢幕');
      } else if (msg.state === 'tracking-lost') {
        this.input.clearHeadDirections();
        this.isHeadCenteredAndStable = false;
        if (this.state === 'play' || this.state === 'countdown') {
          this.pauseGameWithReason('追蹤中斷：請確認坐姿或相機視角');
        } else if (this.state === 'calibrating') {
          this.waitForCalibrationSample(now, '攝影機已開啟，但未偵測到臉部。請回到鏡頭前並平視螢幕');
        } else if (this.state === 'paused') {
          this.updatePauseScreenCenterStatus(false);
        }
      } else if (msg.state === 'error') {
        this.input.clearHeadDirections();
        this.isHeadCenteredAndStable = false;
        const errors = {
          CAMERA_PERMISSION_DENIED: '相機權限遭拒絕。請至系統設定允許存取後按「重試攝影機」，或改用鍵盤。',
          CAMERA_NOT_FOUND: '找不到攝影機。請接上裝置後重試，或改用鍵盤。',
          CAMERA_BUSY: '攝影機無法使用。請關閉其他使用相機的程式後重試。',
          MODEL_LOAD_FAILED: '頭部追蹤模型載入失敗。請重新啟動遊戲，或改用鍵盤。',
          WORKER_FAILED: '頭部追蹤已停止。請重試攝影機，或改用鍵盤。'
        };
        const message = errors[msg.code] || '追蹤裝置無法使用，請重新連接或改用鍵盤。';
        if (msg.code?.startsWith('CAMERA_')) {
          const permission = document.getElementById('camera-perm-status');
          permission.textContent = msg.code === 'CAMERA_PERMISSION_DENIED' ? '相機存取被拒絕' : '攝影機無法使用';
          permission.style.color = 'var(--danger-red)';
        }
        if (this.state === 'play' || this.state === 'countdown') {
          this.pauseGameWithReason(message);
        } else if (this.state === 'calibrating') {
          this.showCalibrationError(message);
        } else if (this.state === 'paused') {
          this.updatePauseScreenCenterStatus(false);
        }
      }
      return;
    }

    if (msg.type === 'pose') {
      const sample = msg.sample;
      if (!sample || sample.sessionId !== this.sessionId || sample.source !== this.settings.source) return;
      if (!Number.isSafeInteger(sample.sequence) || sample.sequence < 1 ||
          (this.lastPoseSample && sample.sequence <= this.lastPoseSample.sequence)) return;
      const age = now - sample.capturedAtMs;
      if (![sample.yawDeg, sample.pitchDeg, sample.capturedAtMs].every(Number.isFinite) || age > 250 || age < -100) {
        this.input.clearHeadDirections();
        if (this.state === 'play' || this.state === 'countdown') this.pauseGameWithReason('追蹤資料已過期，請重新置中');
        else if (this.state === 'calibrating' && this.calibPhase !== 'error') {
          this.waitForCalibrationSample(now, '攝影機已開啟，但頭部辨識延遲過高。請關閉其他程式後重試');
        }
        return;
      }
      this.lastPoseSample = sample;

      if (this.state === 'calibrating' && this.calibPhase === 'error') return;
      document.getElementById('hud-status-badge').textContent = '頭部追蹤中';
      if (this.state === 'calibrating' && ['starting', 'waiting'].includes(this.calibPhase)) {
        this.calibPhase = 'neutral';
        this.calibPhaseStartedAt = now;
        this.headMapper.startCalibration(now);
      }
      if (this.state === 'calibrating' && this.calibPhase !== 'ready') {
        this.processCalibrationSample(sample, now);
        return;
      }

      const result = this.headMapper.processSample(sample, now);

      if (result.stale) {
        if (this.state === 'play' || this.state === 'countdown') {
          this.pauseGameWithReason('姿態訊號過期 (超過 250ms 未收到新資料)');
        }
        return;
      }

      this.input.setHeadDirections(result.directions);

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

  waitForCalibrationSample(now, message) {
    if (this.calibPhase !== 'waiting') {
      this.calibPhaseStartedAt = now;
      this.headMapper.startCalibration(now);
    }
    this.calibPhase = 'waiting';
    this.input.clearHeadDirections();
    document.getElementById('btn-calib-recenter').disabled = false;
    document.getElementById('btn-calib-start').classList.add('hidden');
    this.updateCalibrationUi('waiting', 0, message);
  }

  checkCalibrationTimeout(now) {
    if (this.state !== 'calibrating' || ['ready', 'error'].includes(this.calibPhase)) return;
    const limits = { starting: 30000, waiting: 10000, neutral: 10000, directions: 60000 };
    const messages = {
      starting: '攝影機或辨識模型啟動時間過長，請重試攝影機或改用鍵盤。',
      waiting: '攝影機已開啟，但未取得有效頭部姿態。請確認臉部位於鏡頭中央、光線充足，或關閉其他程式後重試。',
      neutral: '已偵測到臉部，但未取得足夠的穩定姿態。請保持平視後重新採集。',
      directions: '方向驗證等待時間過長，請重新採集後依畫面提示轉頭。'
    };
    const startedAt = this.calibPhase === 'neutral' ? this.headMapper.calibStartTime : this.calibPhaseStartedAt;
    if (now - startedAt > limits[this.calibPhase]) this.showCalibrationError(messages[this.calibPhase]);
  }

  showCalibrationError(message) {
    this.calibPhase = 'error';
    this.updateCalibrationUi('error', 0, message);
    document.getElementById('btn-calib-start').classList.add('hidden');
    document.getElementById('btn-calib-recenter').textContent = '重試攝影機';
    document.getElementById('btn-calib-recenter').disabled = false;
    this.currentProvider?.stop();
    this.currentProvider = null;
    document.getElementById('pip-container').classList.add('hidden');
  }

  processCalibrationSample(sample, now) {
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
        this.calibPhaseStartedAt = now;
        this.headMapper.startVerification(now);
        this.updateCalibrationUi('directions', 0, '中立點已校正。請向上抬頭並維持…', '▲');
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
    fill?.parentElement?.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
    if (msgEl) msgEl.textContent = msg;
    if (pIcon) pIcon.textContent = icon;
    if (pText) pText.textContent = msg;
  }

  startMainLoop() {
    const loop = (now) => {
      if (['play', 'countdown', 'paused'].includes(this.state) && this.settings.source !== 'keyboard') {
        const isStale = !this.lastPoseSample || now - this.lastPoseSample.capturedAtMs > 250 || this.headMapper.checkStale(now);
        if (isStale) {
          this.input.clearHeadDirections();
          this.isHeadCenteredAndStable = false;
          this.updatePauseScreenCenterStatus(false);
          this.pauseGameWithReason('姿態訊號中斷，請確認鏡頭並重新置中');
        }
      }
      this.checkCalibrationTimeout(now);

      const snapshot = this.input.getSnapshot();

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

      this.game.tick(now, snapshot);

      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  async openSettingsModal() {
    this.updateSettingsModalInputs();
    this.openModal('settings-modal');
    await this.refreshCameraList();
  }

  async refreshCameraList() {
    const select = document.getElementById('camera-select');
    select.disabled = true;
    select.innerHTML = '<option value="">正在尋找攝影機…</option>';
    const cameras = await WebcamProvider.getAvailableCameras();
    if (select) {
      select.innerHTML = cameras.length ? '<option value="">使用預設攝影機</option>' : '<option value="">未找到攝影機，請先啟用權限</option>';
      select.disabled = cameras.length === 0;
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
    this.closeModal('settings-modal');
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
      if (select && !select.disabled) this.settings.webcam.preferredDeviceId = select.value;
      if (chkPip) this.settings.webcam.showPip = chkPip.checked;
      if (chkMirror) this.settings.webcam.mirror = chkMirror.checked;
    }

    this.saveSettings();
    this.applySettingsToMappers();
    if (this.currentProvider === this.webcamProvider) this.setupPipVideo(this.webcamProvider.video);
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
      await this.refreshCameraList();
    } catch (e) {
      if (permStatus) {
        permStatus.textContent = '相機存取被拒絕或無可用裝置';
        permStatus.style.color = 'var(--danger-red)';
      }
    }
  }

  openHelpModal() {
    this.openModal('help-modal');
  }

  closeHelpModal() {
    this.closeModal('help-modal');
  }

  openModal(id) {
    if (this.isModalOpen()) return;
    if (this.state === 'play' || this.state === 'countdown') this.pauseGameWithReason('開啟設定已暫停');
    this.input.reset();
    this.modalReturnFocus = document.activeElement;
    document.querySelectorAll('.ui-screen, .hud-overlay, .pip-container').forEach(el => { el.inert = true; });
    const modal = document.getElementById(id);
    modal.classList.remove('hidden');
    modal.querySelector('button:not(:disabled)').focus();
  }

  closeModal(id) {
    const modal = document.getElementById(id);
    if (modal.classList.contains('hidden')) return;
    modal.classList.add('hidden');
    document.querySelectorAll('.ui-screen, .hud-overlay, .pip-container').forEach(el => { el.inert = false; });
    this.modalReturnFocus?.focus({ preventScroll: true });
    this.modalReturnFocus = null;
  }

  trapModalFocus(event) {
    const modal = document.querySelector('.modal-dialog:not(.hidden)');
    const controls = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')]
      .filter(el => el.getClientRects().length > 0);
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    window.flyingMoo = new AppController();
  });
}
