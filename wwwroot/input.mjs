/**
 * @file input.mjs
 * Unified input manager arbitrating keyboard and head-control directions.
 * Ensures per-axis takeover, opposite-key cancellation, and safe direction snapshots.
 */

export class InputManager {
  constructor() {
    /** @type {Set<string>} */
    this.heldKeys = new Set();

    /** @type {{ up: boolean, down: boolean, left: boolean, right: boolean }} */
    this.headDirections = { up: false, down: false, left: false, right: false };

    /** @type {'keyboard' | 'webcam' | 'tobii'} */
    this.activeSource = 'keyboard';

    this.onActionCallback = null;
  }

  /**
   * Set callback for single-press actions (e.g. 'space', 'mute', 'recenter', 'pause').
   * @param {(action: string) => void} cb
   */
  setOnAction(cb) {
    this.onActionCallback = cb;
  }

  /**
   * Set active input source.
   * @param {'keyboard' | 'webcam' | 'tobii'} source
   */
  setSource(source) {
    this.activeSource = source;
    if (source === 'keyboard') {
      this.clearHeadDirections();
    }
  }

  /**
   * Set directions coming from head-control mapper.
   * @param {{ up: boolean, down: boolean, left: boolean, right: boolean }} dirs
   */
  setHeadDirections(dirs) {
    this.headDirections = {
      up: Boolean(dirs.up && !dirs.down),
      down: Boolean(dirs.down && !dirs.up),
      left: Boolean(dirs.left && !dirs.right),
      right: Boolean(dirs.right && !dirs.left)
    };
  }

  /**
   * Clears head directions immediately.
   */
  clearHeadDirections() {
    this.headDirections = { up: false, down: false, left: false, right: false };
  }

  /**
   * Handle keydown event.
   * @param {KeyboardEvent} e
   * @returns {boolean} true if event was consumed as game input
   */
  handleKeyDown(e) {
    // If the event targets an interactive UI element, ignore flight keys
    const hudShortcut = e.target?.closest?.('.hud-overlay') &&
      (this.isFlightKeyCode(e.code) || e.code === 'KeyM' || e.code === 'KeyR');
    if (this.isUiElement(e.target) && !hudShortcut) {
      if (e.code === 'Escape') {
        if (this.onActionCallback) this.onActionCallback('escape');
        return true;
      }
      return false;
    }

    // Ignore key repeat for single-trigger actions
    if (!e.repeat) {
      if (e.code === 'Space') {
        if (this.onActionCallback) this.onActionCallback('space');
        return true;
      }
      if (e.code === 'KeyM') {
        if (this.onActionCallback) this.onActionCallback('mute');
        return true;
      }
      if (e.code === 'KeyR') {
        if (this.onActionCallback) this.onActionCallback('recenter');
        return true;
      }
      if (e.code === 'Escape') {
        if (this.onActionCallback) this.onActionCallback('escape');
        return true;
      }
    }

    if (this.isFlightKeyCode(e.code)) {
      this.heldKeys.add(e.code);
      return true;
    }

    return false;
  }

  /**
   * Handle keyup event.
   * @param {KeyboardEvent} e
   */
  handleKeyUp(e) {
    if (this.isFlightKeyCode(e.code)) {
      this.heldKeys.delete(e.code);
    }
  }

  /**
   * Check if element is a UI control that receives keyboard focus.
   * @param {EventTarget | null} target
   */
  isUiElement(target) {
    if (!target || !(target instanceof HTMLElement)) return false;
    const tag = target.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button') {
      return true;
    }
    return Boolean(target.closest('[role="dialog"], .modal-panel, .settings-panel'));
  }

  /**
   * Check if code is a directional flight key.
   * @param {string} code
   */
  isFlightKeyCode(code) {
    return (
      code === 'ArrowUp' ||
      code === 'KeyW' ||
      code === 'ArrowDown' ||
      code === 'KeyS' ||
      code === 'ArrowLeft' ||
      code === 'KeyA' ||
      code === 'ArrowRight' ||
      code === 'KeyD'
    );
  }

  /**
   * Reset all keys and head directions (on pause, blur, source switch).
   */
  reset() {
    this.heldKeys.clear();
    this.clearHeadDirections();
  }

  /**
   * Produce snapshot of current active directions according to arbitration rules.
   * @returns {{ up: boolean, down: boolean, left: boolean, right: boolean }}
   */
  getSnapshot() {
    const keyUp = this.heldKeys.has('ArrowUp') || this.heldKeys.has('KeyW');
    const keyDown = this.heldKeys.has('ArrowDown') || this.heldKeys.has('KeyS');
    const keyLeft = this.heldKeys.has('ArrowLeft') || this.heldKeys.has('KeyA');
    const keyRight = this.heldKeys.has('ArrowRight') || this.heldKeys.has('KeyD');

    const vertKeyActive = keyUp || keyDown;
    const horizKeyActive = keyLeft || keyRight;

    let up = false;
    let down = false;
    let left = false;
    let right = false;

    // Vertical axis arbitration
    if (vertKeyActive) {
      if (keyUp && !keyDown) up = true;
      else if (keyDown && !keyUp) down = true;
      // If both pressed, vertical is neutral (up=false, down=false)
    } else if (this.activeSource !== 'keyboard') {
      up = this.headDirections.up;
      down = this.headDirections.down;
    }

    // Horizontal axis arbitration
    if (horizKeyActive) {
      if (keyLeft && !keyRight) left = true;
      else if (keyRight && !keyLeft) right = true;
      // If both pressed, horizontal is neutral (left=false, right=false)
    } else if (this.activeSource !== 'keyboard') {
      left = this.headDirections.left;
      right = this.headDirections.right;
    }

    // Enforce mutual exclusivity
    if (up && down) { up = false; down = false; }
    if (left && right) { left = false; right = false; }

    return { up, down, left, right };
  }
}
