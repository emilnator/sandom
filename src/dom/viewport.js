import {
  addEventListener as addSandomEventListener,
  dispatchEvent as dispatchSandomEvent,
  removeEventListener as removeSandomEventListener,
} from './events.js';
import { scrollRead, scrollStore } from "./scroll-core.js";
import { installViewportScrollBindings } from "./dom-bindings.generated.js";

export function normalizeScrollCoordinates(first, second, fallbackLeft, fallbackTop) {
  let left;
  let top;
  let behavior = 'auto';
  if (typeof first === 'object' && first !== null) {
    left = first.left;
    top = first.top;
    behavior = first.behavior ?? 'auto';
  } else {
    left = first;
    top = second;
  }
  if (!['auto', 'instant', 'smooth'].includes(behavior)) {
    throw new TypeError(`Unknown scroll behavior "${behavior}"`);
  }
  const numericLeft = left === undefined ? fallbackLeft : Number(left);
  const numericTop = top === undefined ? fallbackTop : Number(top);
  return {
    left: Number.isFinite(numericLeft) ? numericLeft : 0,
    top: Number.isFinite(numericTop) ? numericTop : 0,
    behavior,
  };
}

// Language-only hooks used by the generated public scroll bindings. Capture
// method identity before value conversion and preserve ECMAScript + coercion.
export const scrollBindingRuntime = Object.freeze({
  normalizeScrollCoordinates,
  normalizeScrollProperty(value) {
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  },
  addScrollDelta(base, delta) { return base + delta; },
  applyScrollPosition(target, method, ...args) {
    return Reflect.apply(method, target, args);
  },
  viewportScrollRequest(target, left, top, source, behavior) {
    target._surface?._requestViewportScroll(left, top, source, behavior);
    if (!target._surface) target._setRequested(left, top);
  },
});

export class SandomViewport {
  constructor({ width = 1280, height = 720, deviceScale = 1 } = {}) {
    if (!(width > 0) || !(height > 0) || !(deviceScale > 0)) {
      throw new RangeError('Viewport width, height, and deviceScale must be positive');
    }
    this.width = Number(width);
    this.height = Number(height);
    this.deviceScale = Number(deviceScale);
    this._requestedLeft = 0;
    this._requestedTop = 0;
    this._effectiveLeft = 0;
    this._effectiveTop = 0;
    this._surface = null;
  }

  get _requestedLeft() { return scrollRead(this, 0); }
  set _requestedLeft(value) { scrollStore(this, 0, value); }
  get _requestedTop() { return scrollRead(this, 1); }
  set _requestedTop(value) { scrollStore(this, 1, value); }
  get _effectiveLeft() { return scrollRead(this, 2); }
  set _effectiveLeft(value) { scrollStore(this, 2, value); }
  get _effectiveTop() { return scrollRead(this, 3); }
  set _effectiveTop(value) { scrollStore(this, 3, value); }
  get parentNode() { return null; }
  get innerWidth() { return this.width; }
  get innerHeight() { return this.height; }

  resizeTo(width, height, deviceScale = this.deviceScale) {
    if (!(width > 0) || !(height > 0) || !(deviceScale > 0)) {
      throw new RangeError('Viewport width, height, and deviceScale must be positive');
    }
    if (this.width === width && this.height === height && this.deviceScale === deviceScale) return;
    const previous = {
      width: this.width,
      height: this.height,
      deviceScale: this.deviceScale,
    };
    this.width = Number(width);
    this.height = Number(height);
    this.deviceScale = Number(deviceScale);
    this._surface?._recordViewportResize(previous);
  }

  addEventListener(type, callback, options) { addSandomEventListener(this, type, callback, options); }
  removeEventListener(type, callback, options) { removeSandomEventListener(this, type, callback, options); }
  dispatchEvent(event) { return dispatchSandomEvent(this, event); }

  _setRequested(left, top) {
    this._requestedLeft = left;
    this._requestedTop = top;
    if (!this._surface) this._setEffective(left, top);
  }

  _setEffective(left, top) {
    this._effectiveLeft = left;
    this._effectiveTop = top;
  }
}

installViewportScrollBindings(scrollBindingRuntime, SandomViewport.prototype);
