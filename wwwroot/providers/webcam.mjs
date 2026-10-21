/**
 * @file webcam.mjs
 * HeadProvider implementation for Webcam using Web Worker with MediaPipe Face Landmarker.
 * Manages camera acquisition, transferable ImageBitmap scheduling, and lifecycle.
 */

export class WebcamProvider {
  constructor() {
    /** @type {MediaStream | null} */
    this.stream = null;
    /** @type {HTMLVideoElement | null} */
    this.video = null;
    /** @type {Worker | null} */
    this.worker = null;

    this.sessionId = 0;
    this.sequence = 0;
    this.onMessageCallback = null;

    this.isProcessingFrame = false;
    this.isRunning = false;
    this.animFrameId = null;
    this.lastVideoTime = -1;

    this.activeDeviceId = null;
  }

  /**
   * Enumerate available video input devices.
   * @returns {Promise<Array<{ deviceId: string, label: string }>>}
   */
  static async getAvailableCameras() {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        return [];
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter(d => d.kind === 'videoinput')
        .map((d, idx) => ({
          deviceId: d.deviceId,
          label: d.label || `攝影機 ${idx + 1}`
        }));
    } catch (e) {
      console.warn('Failed to enumerate cameras:', e);
      return [];
    }
  }

  /**
   * Start camera acquisition and pose worker.
   * @param {number} sessionId
   * @param {(m: any) => void} onMessage
   * @param {string} [deviceId]
   */
  async start(sessionId, onMessage, deviceId) {
    await this.stop();

    this.sessionId = sessionId;
    this.sequence = 0;
    this.onMessageCallback = onMessage;
    this.isRunning = true;
    this.isProcessingFrame = false;
    this.activeDeviceId = deviceId || null;

    this.dispatchStatus('starting');

    try {
      // 1. Setup video element
      if (!this.video) {
        this.video = document.createElement('video');
        this.video.setAttribute('playsinline', '');
        this.video.setAttribute('muted', '');
        this.video.style.display = 'none';
        document.body.appendChild(this.video);
      }

      // 2. Request user media
      const videoConstraints = {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 }
      };
      if (deviceId) {
        videoConstraints.deviceId = { exact: deviceId };
      }

      this.stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false
      });

      // User might have stopped during permission prompt
      if (!this.isRunning || this.sessionId !== sessionId) {
        this.stopStreamTracks();
        return;
      }

      this.video.srcObject = this.stream;
      await this.video.play();

      // Listen for unexpected track ending (e.g. camera unplugged)
      this.stream.getVideoTracks().forEach(track => {
        track.onended = () => {
          if (this.isRunning && this.sessionId === sessionId) {
            this.dispatchStatus('tracking-lost', 'CAMERA_DISCONNECTED');
          }
        };
      });

      // 3. Setup Web Worker
      this.worker = new Worker(new URL('./pose-worker.mjs', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this.handleWorkerMessage(e);
      this.worker.onerror = (err) => {
        console.error('Pose worker error:', err);
        this.dispatchStatus('error', 'WORKER_FAILED', err.message);
      };

      // Send init command to worker
      this.worker.postMessage({ type: 'init', sessionId });

      // 4. Start frame scheduler
      this.scheduleNextFrame();
    } catch (err) {
      this.stopStreamTracks();
      const code = err.name === 'NotAllowedError' ? 'CAMERA_PERMISSION_DENIED' :
        err.name === 'NotFoundError' ? 'CAMERA_NOT_FOUND' :
        err.name === 'NotReadableError' ? 'CAMERA_BUSY' : 'CAMERA_ERROR';
      this.dispatchStatus('error', code, err.message);
    }
  }

  /**
   * Handle incoming messages from Web Worker.
   * @param {MessageEvent} e
   */
  handleWorkerMessage(e) {
    const msg = e.data;
    if (!msg || msg.sessionId !== this.sessionId || !this.isRunning) return;

    this.isProcessingFrame = false;

    if (msg.type === 'status') {
      if (msg.state === 'ready') {
        this.dispatchStatus('connected');
      } else {
        this.dispatchStatus(msg.state, msg.code, msg.message);
      }
      return;
    }

    if (msg.type === 'pose') {
      if (this.onMessageCallback) {
        this.onMessageCallback(msg);
      }
    }
  }

  /**
   * Schedule frame grab using requestVideoFrameCallback if available, otherwise rAF.
   */
  scheduleNextFrame() {
    if (!this.isRunning || !this.video) return;

    if ('requestVideoFrameCallback' in this.video) {
      this.video.requestVideoFrameCallback(() => {
        this.processCurrentVideoFrame();
        this.scheduleNextFrame();
      });
    } else {
      this.animFrameId = requestAnimationFrame(() => {
        this.processCurrentVideoFrame();
        this.scheduleNextFrame();
      });
    }
  }

  /**
   * Grab image bitmap from current video frame and forward to worker.
   */
  async processCurrentVideoFrame() {
    if (!this.isRunning || !this.video || this.isProcessingFrame || !this.worker) return;
    if (this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    // Check if new frame arrived
    if (this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;

    this.isProcessingFrame = true;
    const captureTimestamp = performance.now();
    this.sequence++;

    try {
      const bitmap = await createImageBitmap(this.video);
      if (!this.isRunning || !this.worker) {
        bitmap.close();
        this.isProcessingFrame = false;
        return;
      }
      this.worker.postMessage(
        {
          type: 'frame',
          bitmap,
          capturedAtMs: captureTimestamp,
          sessionId: this.sessionId,
          sequence: this.sequence
        },
        [bitmap]
      );
    } catch (e) {
      this.isProcessingFrame = false;
    }
  }

  /**
   * Dispatch provider status event.
   * @param {'starting' | 'connected' | 'tracking-lost' | 'error' | 'stopped'} state
   * @param {string} [code]
   * @param {string} [message]
   */
  dispatchStatus(state, code, message) {
    if (this.onMessageCallback) {
      this.onMessageCallback({
        type: 'status',
        sessionId: this.sessionId,
        state,
        code,
        message
      });
    }
  }

  /**
   * Stop video tracks.
   */
  stopStreamTracks() {
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
    }
  }

  /**
   * Stop webcam provider and cleanup worker and streams.
   */
  async stop() {
    this.isRunning = false;
    this.isProcessingFrame = false;
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    this.stopStreamTracks();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.dispatchStatus('stopped');
  }
}
