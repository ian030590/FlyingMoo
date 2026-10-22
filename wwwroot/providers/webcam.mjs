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
    this.workerReady = false;
    this.isRunning = false;
    this.animFrameId = null;
    this.lastVideoTime = -1;

    this.activeDeviceId = null;
    this.processingTrack = null;
    this.trackStreamActive = false;
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
    this.workerReady = false;
    this.lastVideoTime = -1;
    this.activeDeviceId = deviceId || null;

    this.dispatchStatus('starting');

    try {
      if (!this.video) {
        this.video = document.createElement('video');
        this.video.setAttribute('playsinline', '');
        this.video.setAttribute('muted', '');
        this.video.style.display = 'none';
        document.body.appendChild(this.video);
      }

      const videoConstraints = {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 }
      };
      if (deviceId) {
        videoConstraints.deviceId = { exact: deviceId };
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false
      });

      // User might have stopped during permission prompt
      if (!this.isRunning || this.sessionId !== sessionId) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }

      this.stream = stream;
      this.video.srcObject = this.stream;
      await this.video.play();
      if (!this.isRunning || this.sessionId !== sessionId) return;
      this.dispatchStatus('camera-ready');

      // Listen for unexpected track ending (e.g. camera unplugged)
      this.stream.getVideoTracks().forEach(track => {
        track.onended = () => {
          if (this.isRunning && this.sessionId === sessionId) {
            this.dispatchStatus('tracking-lost', 'CAMERA_DISCONNECTED');
          }
        };
      });

      // MediaPipe's WASM loader uses importScripts, which requires a classic worker.
      this.worker = new Worker(new URL('./pose-worker.mjs', import.meta.url));
      this.worker.onmessage = (e) => this.handleWorkerMessage(e);
      this.worker.onerror = (err) => {
        console.error('Pose worker error:', err);
        this.dispatchStatus('error', 'WORKER_FAILED', err.message);
      };

      this.worker.postMessage({ type: 'init', sessionId });

      this.scheduleNextFrame();
    } catch (err) {
      if (sessionId !== this.sessionId || !this.isRunning) return;
      this.isRunning = false;
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
        this.workerReady = true;
        this.startTrackStream();
        this.dispatchStatus('connected');
      } else if (msg.state === 'stream-fallback') {
        this.trackStreamActive = false;
        this.processingTrack?.stop();
        this.processingTrack = null;
        this.scheduleNextFrame();
      } else {
        this.dispatchStatus(msg.state, msg.code, msg.message);
      }
      return;
    }

    if (msg.type === 'pose') {
      this.sequence = Math.max(this.sequence, msg.sample?.sequence ?? 0);
      if (this.onMessageCallback) {
        this.onMessageCallback(msg);
      }
      this.processCurrentVideoFrame();
    }
  }

  /**
   * Poll new video frames even when a hidden video's frame callbacks are suspended.
   */
  scheduleNextFrame() {
    if (!this.isRunning || !this.video || this.trackStreamActive) return;

    this.animFrameId = requestAnimationFrame(() => {
      this.processCurrentVideoFrame();
      this.scheduleNextFrame();
    });
  }

  /**
   * Grab image bitmap from current video frame and forward to worker.
   */
  async processCurrentVideoFrame() {
    if (!this.isRunning || !this.video || this.trackStreamActive || this.isProcessingFrame || !this.worker || !this.workerReady) return;
    if (this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    if (this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;

    this.isProcessingFrame = true;
    const captureTimestamp = performance.now();
    const sessionId = this.sessionId;
    const worker = this.worker;
    const sequence = ++this.sequence;

    try {
      const bitmap = await createImageBitmap(this.video);
      if (!this.isRunning || this.worker !== worker || this.sessionId !== sessionId) {
        bitmap.close();
        return;
      }
      this.worker.postMessage(
        {
          type: 'frame',
          bitmap,
          capturedAtMs: captureTimestamp,
          sessionId,
          sequence,
          clockOriginMs: performance.timeOrigin
        },
        [bitmap]
      );
    } catch (e) {
      if (this.worker === worker && this.sessionId === sessionId) this.isProcessingFrame = false;
    }
  }

  startTrackStream() {
    if (typeof MediaStreamTrackProcessor === 'undefined' || !this.stream) return;
    try {
      this.processingTrack = this.stream.getVideoTracks()[0].clone();
      const processor = new MediaStreamTrackProcessor({ track: this.processingTrack, maxBufferSize: 1 });
      const readable = processor.readable;
      this.worker.postMessage({ type: 'stream', sessionId: this.sessionId, readable,
        clockOriginMs: performance.timeOrigin,
        mediaClockOffsetMs: performance.now() - this.video.currentTime * 1000 }, [readable]);
      this.trackStreamActive = true;
      if (this.animFrameId !== null) cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    } catch {
      this.processingTrack?.stop();
      this.processingTrack = null;
    }
  }

  /**
   * Dispatch provider status event.
   * @param {'starting' | 'camera-ready' | 'connected' | 'tracking-lost' | 'error' | 'stopped'} state
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
    this.workerReady = false;
    this.isProcessingFrame = false;
    this.trackStreamActive = false;
    this.processingTrack?.stop();
    this.processingTrack = null;
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
