import { enqueueInputRecord, mapPresentedPoint } from "./interaction.js";
import { quantizeWorkingPixels } from "../output/color-transform.js";
import { createCanvasPresenter } from "../canvas-presentation.js";

const HTMLElementBase = globalThis.HTMLElement ?? class {};
const MODES = new Set(["asset", "real"]);

export class SandomInteractiveRendererElement extends HTMLElementBase {
  #session = null;
  #target = null;
  #placement = null;
  #mode = "asset";
  #records = [];
  #dispatchScheduled = false;
  #activePointerIdentifiers = new Set();
  #canvas;
  #context = null;
  #presenter = null;
  #presenterDevice = null;

  constructor() {
    super();
    const shadowRoot = this.attachShadow({ mode: "open" });
    shadowRoot.innerHTML = `
      <style>
        :host { display: inline-block; line-height: 0; }
        canvas { display: block; max-width: 100%; touch-action: none; }
      </style>
      <canvas part="canvas" role="img" aria-label="Sandom interactive render"></canvas>
    `;
    this.#canvas = shadowRoot.querySelector("canvas");

    const enqueuePointer = (kind, event) => {
      if (this.#mode !== "real") return;
      const rectangle = this.#canvas.getBoundingClientRect();
      const point = mapPresentedPoint(
        { x: event.clientX, y: event.clientY },
        rectangle,
        { width: this.#canvas.width, height: this.#canvas.height },
      );
      enqueueInputRecord(this.#records, {
        kind,
        pointerId: event.pointerId,
        pointerType: event.pointerType || "mouse",
        isPrimary: event.isPrimary,
        button: event.button,
        buttons: event.buttons,
        x: point.x,
        y: point.y,
        pressure: event.pressure,
        altKey: event.altKey,
        controlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        timeMilliseconds: event.timeStamp,
      });
      if (kind === "pointer-down") {
        this.#activePointerIdentifiers.add(event.pointerId);
        this.#canvas.setPointerCapture(event.pointerId);
      }
      if (kind === "pointer-up") {
        this.#activePointerIdentifiers.delete(event.pointerId);
        if (this.#canvas.hasPointerCapture(event.pointerId)) {
          this.#canvas.releasePointerCapture(event.pointerId);
        }
      }
      this.#scheduleDispatch();
    };
    this.#canvas.addEventListener("pointerdown", (event) => {
      enqueuePointer("pointer-down", event);
    });
    this.#canvas.addEventListener(
      "pointermove",
      (event) => enqueuePointer("pointer-move", event),
    );
    this.#canvas.addEventListener("pointerup", (event) => {
      enqueuePointer("pointer-up", event);
    });
    this.#canvas.addEventListener("pointercancel", (event) => {
      if (this.#mode !== "real") return;
      this.#activePointerIdentifiers.delete(event.pointerId);
      if (this.#canvas.hasPointerCapture(event.pointerId)) {
        this.#canvas.releasePointerCapture(event.pointerId);
      }
      this.#records.push({
        kind: "pointer-cancel",
        pointerId: event.pointerId,
      });
      this.#scheduleDispatch();
    });
    this.#canvas.addEventListener("pointerleave", (event) => {
      if (
        this.#mode !== "real" ||
        this.#activePointerIdentifiers.has(event.pointerId)
      ) return;
      this.#records.push({ kind: "pointer-leave", pointerId: event.pointerId });
      this.#scheduleDispatch();
    });
    this.#canvas.addEventListener("wheel", (event) => {
      if (this.#mode !== "real") return;
      event.preventDefault();
      const rectangle = this.#canvas.getBoundingClientRect();
      const point = mapPresentedPoint(
        { x: event.clientX, y: event.clientY },
        rectangle,
        { width: this.#canvas.width, height: this.#canvas.height },
      );
      this.#records.push({
        kind: "wheel",
        x: point.x,
        y: point.y,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        altKey: event.altKey,
        controlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      });
      this.#scheduleDispatch();
    }, { passive: false });
  }

  get mode() {
    return this.#mode;
  }

  set mode(value) {
    const mode = String(value);
    if (!MODES.has(mode)) {
      throw new RangeError(`Unknown interaction mode: ${mode}`);
    }
    if (mode === this.#mode) return;
    this.#mode = mode;
    this.setAttribute("mode", mode);
    if (this.#session && this.#target) {
      this.#session.setInteractionMode(this.#target, mode);
    }
    this.dispatchEvent(
      new CustomEvent("mode-change", {
        detail: Object.freeze({ mode }),
      }),
    );
  }

  connect({ session, target, placement = "placement-1" }) {
    if (!session || typeof session.dispatchInputBatch !== "function") {
      throw new TypeError("connect requires a DocumentSession");
    }
    this.#session = session;
    this.#target = String(target);
    this.#placement = String(placement);
    session.setInteractionMode(this.#target, this.#mode);
    this.present();
  }

  disconnect() {
    this.#dispatchScheduled = false;
    this.#records = [];
    this.#activePointerIdentifiers.clear();
    this.#session = null;
    this.#target = null;
    this.#placement = null;
    this.#canvas.style.cursor = "default";
  }

  // Presents the target's current output. A texture target (the default)
  // hands the single layer's GPU texture to a WebGPU canvas presenter with
  // no readback; a pixel target, or the WebGL 2 fallback, draws its
  // composited pixels through a 2D context.
  present(output = this.#session?.captureCurrent(this.#target)) {
    if (!output) throw new Error("No current Sandom target frame is available");
    const textureLayer = output.pixels
      ? null
      : output.layers?.find(({ frame }) => frame?.textureImage?.texture);
    if (textureLayer) {
      const { frame } = textureLayer;
      if (output.layers.length !== 1) {
        throw new Error(
          "A texture target presents exactly one placement; attach a pixel target for composited placements",
        );
      }
      this.#presentTexture(frame);
    } else if (output.pixels) {
      this.#presentPixels(output);
    } else {
      throw new Error("The current Sandom target has no presentable frame");
    }
    this.dispatchEvent(
      new CustomEvent("frame", {
        detail: Object.freeze({
          target: output.target,
          presentationRevision: output.presentationRevision,
          width: output.width,
          height: output.height,
        }),
      }),
    );
  }

  #presentTexture(frame) {
    if (this.#context !== null) {
      throw new Error(
        "The canvas already presents pixels; a texture target needs a fresh element",
      );
    }
    if (this.#presenter === null || this.#presenterDevice !== frame.device) {
      this.#presenter?.destroy();
      this.#presenter = createCanvasPresenter({
        canvas: this.#canvas,
        device: frame.device,
      });
      this.#presenterDevice = frame.device;
    }
    if (
      this.#canvas.width !== frame.width || this.#canvas.height !== frame.height
    ) {
      this.#canvas.width = frame.width;
      this.#canvas.height = frame.height;
    }
    this.#presenter.present(frame.textureImage);
  }

  #presentPixels(output) {
    if (this.#presenter !== null) {
      throw new Error(
        "The canvas already presents textures; a pixel target needs a fresh element",
      );
    }
    this.#context ??= this.#canvas.getContext("2d");
    this.#canvas.width = output.width;
    this.#canvas.height = output.height;
    this.#context.putImageData(
      new ImageData(
        new Uint8ClampedArray(quantizeWorkingPixels(output.pixels)),
        output.width,
        output.height,
      ),
      0,
      0,
    );
  }

  #scheduleDispatch() {
    if (this.#dispatchScheduled) return;
    this.#dispatchScheduled = true;
    queueMicrotask(async () => {
      const records = this.#records;
      this.#records = [];
      if (records.length === 0) {
        this.#dispatchScheduled = false;
        return;
      }
      const status = this.#session.targetStatus(this.#target);
      const placement = status.placements.find(({ identifier }) =>
        identifier === this.#placement
      );
      if (!placement) {
        throw new RangeError(`Unknown target placement: ${this.#placement}`);
      }
      try {
        const result = await this.#session.dispatchInputBatch({
          target: this.#target,
          placement: this.#placement,
          expectedPresentationRevision: status.presentationRevision,
          expectedInteractionRevision: placement.interactionRevision,
          records,
        });
        const output = result.outputs.find(({ target }) =>
          target === this.#target
        );
        if (output) this.present(output);
        this.#canvas.style.cursor = result.cursor;
        for (const record of records) {
          if (
            record.kind === "pointer-down" &&
            result.activePointerIdentifiers.includes(record.pointerId)
          ) {
            this.#canvas.setPointerCapture(record.pointerId);
          } else if (
            (record.kind === "pointer-up" ||
              record.kind === "pointer-cancel") &&
            this.#canvas.hasPointerCapture(record.pointerId)
          ) {
            this.#canvas.releasePointerCapture(record.pointerId);
          }
        }
        this.#activePointerIdentifiers = new Set(
          result.activePointerIdentifiers,
        );
        this.dispatchEvent(
          new CustomEvent("interaction-revision", {
            detail: Object.freeze({
              target: this.#target,
              presentationRevision:
                this.#session.targetStatus(this.#target).presentationRevision,
              instance: result.instance,
              interactionRevision: result.interactionRevision,
            }),
          }),
        );
      } catch (error) {
        this.dispatchEvent(new CustomEvent("sandom-error", { detail: error }));
        throw error;
      } finally {
        this.#dispatchScheduled = false;
        if (this.#records.length > 0) this.#scheduleDispatch();
      }
    });
  }

  disconnectedCallback() {
    this.disconnect();
  }
}

export function defineSandomInteractiveRenderer(
  name = "sandom-interactive-renderer",
  registry = globalThis.customElements,
) {
  if (registry === undefined) {
    throw new Error(
      "defineSandomInteractiveRenderer requires a custom element registry",
    );
  }
  const existing = registry.get(name);
  if (existing === undefined) {
    registry.define(name, SandomInteractiveRendererElement);
  } else if (existing !== SandomInteractiveRendererElement) {
    throw new Error(`${name} is registered with a different constructor`);
  }
  return SandomInteractiveRendererElement;
}
