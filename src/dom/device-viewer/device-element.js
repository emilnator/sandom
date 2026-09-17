// <sandom-device> — a rotating 3D device with a live sandom render mapped
// onto its screen.
//
// Attributes:
//   device  — catalog key: handset | tablet | laptop (default handset)
//   chrome  — "app" wraps the stage in the translucent application chroma
//             (blue slab, backdrop blur, window shadow); "none" leaves the
//             background fully transparent so the device floats over the
//             host surface (the Studio Preview case, where the real window
//             chroma is behind the component). Default "app".
//   src     — URL of the document to render on the device screen.
//
// The document can also be supplied programmatically with preview(), which
// accepts a File or a source string.
//
// Drag horizontally to spin the device; the idle rotation resumes a moment
// after the last interaction.

import { DEVICE_CATALOG } from "./device-catalog.js";
import { startDeviceViewer } from "./device-viewer-client.js";

const MODELS_BASE_URL = new URL(
  "../../../models/devices/",
  import.meta.url,
);
const componentStyle = new CSSStyleSheet();
componentStyle.replaceSync(`
  :host {
    display: block;
    block-size: 480px;
    contain: layout size;
  }
  .stage {
    position: relative;
    inline-size: 100%;
    block-size: 100%;
    overflow: hidden;
  }
  .stage.chrome-app {
    background:
      linear-gradient(
        160deg,
        rgba(44, 62, 96, 0.42),
        rgba(24, 32, 52, 0.38)
      );
    backdrop-filter: blur(18px);
    border-radius: 12px;
    box-shadow:
      0 0 0 1px rgba(6, 8, 12, 0.55),
      inset 0 0 0 1px rgba(243, 241, 232, 0.08),
      0 18px 50px rgba(4, 6, 12, 0.5),
      0 4px 14px rgba(4, 6, 12, 0.4);
  }
  canvas {
    position: absolute;
    inset: 0;
    inline-size: 100%;
    block-size: 100%;
    touch-action: pan-y;
    cursor: grab;
  }
  canvas.dragging {
    cursor: grabbing;
  }
`);

export class SandomDevice extends HTMLElement {
  static observedAttributes = ["device", "chrome", "src"];

  #shadow = this.attachShadow({ mode: "open" });
  #stage = null;
  #canvas = null;
  #viewer = null;
  #input = null;
  #resizeObserver = null;
  // Mutating operations (start, document and device changes, stop) run
  // through one ordered chain, following the render-host ordered-chain
  // rule: two interleaved changes otherwise race in the worker.
  #operationChain = Promise.resolve();
  #modelCache = new Map();
  // Model keys whose GLB bytes the live worker has already received; the
  // worker caches parsed geometry and scenes per key.
  #sentModelKeys = new Set();

  connectedCallback() {
    this.#shadow.adoptedStyleSheets = [componentStyle];
    this.#stage = document.createElement("div");
    this.#stage.className = "stage";
    this.#canvas = document.createElement("canvas");
    this.#canvas.setAttribute("role", "img");
    this.#stage.append(this.#canvas);
    this.#shadow.replaceChildren(this.#stage);
    this.#applyChrome();
    this.#applyAccessibleLabel();
    this.#wirePointer();
    this.#resizeObserver = new ResizeObserver(() => {
      if (this.#viewer === null) return;
      const { width, height, pixelScale } = this.#surfaceSize();
      this.#viewer.resize(width, height, pixelScale);
    });
    this.#resizeObserver.observe(this);
    if (this.getAttribute("src")) {
      this.#loadFromSource(this.getAttribute("src"));
    }
  }

  disconnectedCallback() {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.#enqueue(() => this.#stop());
  }

  attributeChangedCallback(name, previous, next) {
    if (previous === next || this.#stage === null) return;
    if (name === "chrome") {
      this.#applyChrome();
      return;
    }
    if (name === "device") {
      this.#applyAccessibleLabel();
      if (this.#input !== null) this.#applyDevice();
      return;
    }
    if (name === "src" && next) {
      this.#loadFromSource(next);
    }
  }

  get deviceRecord() {
    const key = this.getAttribute("device") ?? "handset";
    const record = DEVICE_CATALOG[key];
    if (!record) {
      throw new Error(`Unknown device ${JSON.stringify(key)}`);
    }
    return record;
  }

  async preview(input) {
    let name;
    let bytes;
    if (typeof input === "string") {
      name = "document.html";
      bytes = new TextEncoder().encode(input);
    } else if (input instanceof File) {
      name = input.name;
      bytes = new Uint8Array(await input.arrayBuffer());
    } else {
      throw new TypeError("preview() accepts a File or a source string");
    }
    this.#input = { name, bytes };
    await this.#applyInput();
  }

  #applyChrome() {
    const mode = this.getAttribute("chrome") ?? "app";
    this.#stage.classList.toggle("chrome-app", mode !== "none");
  }

  #applyAccessibleLabel() {
    this.#canvas?.setAttribute(
      "aria-label",
      `Rotating three-dimensional ${this.deviceRecord.label.toLowerCase()} ` +
        "with the rendered document on its screen",
    );
  }

  // Every pointer fact forwards to the worker in canvas backing pixels;
  // the worker raycasts against the screen plane and decides between
  // document interaction and the orbit drag.
  #wirePointer() {
    const canvas = this.#canvas;
    const facts = (event) => {
      const rectangle = canvas.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      return {
        canvasX: (event.clientX - rectangle.left) * scale,
        canvasY: (event.clientY - rectangle.top) * scale,
        pointerId: event.pointerId,
        pointerType: event.pointerType || "mouse",
        isPrimary: event.isPrimary,
        button: event.button,
        buttons: event.buttons,
        pressure: event.pressure,
        altKey: event.altKey,
        controlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        timeMilliseconds: event.timeStamp,
      };
    };
    const forward = (action, event) => {
      this.#viewer?.pointer({ action, ...facts(event) });
    };
    canvas.addEventListener("pointerdown", (event) => {
      canvas.classList.add("dragging");
      canvas.setPointerCapture(event.pointerId);
      forward("down", event);
    });
    canvas.addEventListener("pointermove", (event) => {
      forward("move", event);
    });
    canvas.addEventListener("pointerup", (event) => {
      canvas.classList.remove("dragging");
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      forward("up", event);
    });
    canvas.addEventListener("pointercancel", (event) => {
      canvas.classList.remove("dragging");
      this.#viewer?.pointer({
        action: "cancel",
        pointerId: event.pointerId,
      });
    });
    canvas.addEventListener("pointerleave", (event) => {
      this.#viewer?.pointer({
        action: "leave",
        pointerId: event.pointerId,
      });
    });
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      this.#viewer?.pointer({
        action: "wheel",
        ...facts(event),
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
      });
    }, { passive: false });
  }

  #surfaceSize() {
    const rectangle = this.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    return {
      width: Math.max(1, Math.round(rectangle.width * scale)),
      height: Math.max(1, Math.round(rectangle.height * scale)),
      pixelScale: scale,
    };
  }

  async #loadFromSource(source) {
    const response = await fetch(new URL(source, document.baseURI));
    if (!response.ok) {
      throw new Error(`Loading ${source} failed: ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    this.#input = {
      name: source.split("/").pop() || "document.html",
      bytes,
    };
    await this.#applyInput();
  }

  async #loadModel(record) {
    if (this.#modelCache.has(record.directory)) {
      return this.#modelCache.get(record.directory);
    }
    const directoryURL = new URL(`${record.directory}/`, MODELS_BASE_URL);
    const [glbResponse, metadataResponse] = await Promise.all([
      fetch(new URL(record.directory + ".glb", directoryURL)),
      fetch(new URL("device.json", directoryURL)),
    ]);
    if (!glbResponse.ok || !metadataResponse.ok) {
      throw new Error(`Loading the ${record.directory} model failed`);
    }
    const model = {
      glb: new Uint8Array(await glbResponse.arrayBuffer()),
      metadata: await metadataResponse.json(),
    };
    this.#modelCache.set(record.directory, model);
    return model;
  }

  #enqueue(operation) {
    const next = this.#operationChain.then(operation);
    // The chain must survive a failed operation; the failure still
    // propagates to the caller through the returned promise.
    this.#operationChain = next.catch(() => {});
    return next;
  }

  // Present the current input. Starts the persistent viewer on first use;
  // afterwards replaces only the document session, so the scene and its
  // rotation stay live.
  #applyInput() {
    return this.#enqueue(async () => {
      if (this.#input === null || !this.isConnected) return;
      if (this.#viewer === null) {
        await this.#start();
        return;
      }
      await this.#viewer.setInput({
        input: this.#input,
        viewport: this.deviceRecord.viewport,
      });
    });
  }

  // Swap the device model in the live viewer. GLB bytes travel once per
  // model key; afterwards the worker's cached scene reactivates.
  #applyDevice() {
    return this.#enqueue(async () => {
      if (this.#input === null || !this.isConnected) return;
      if (this.#viewer === null) {
        await this.#start();
        return;
      }
      const record = this.deviceRecord;
      const model = await this.#loadModel(record);
      const sent = this.#sentModelKeys.has(record.directory);
      await this.#viewer.setModel({
        model: {
          key: record.directory,
          ...(sent ? {} : { glb: model.glb }),
          screen: model.metadata.screen,
          pose: model.metadata.pose,
        },
        viewport: record.viewport,
        input: this.#input,
      });
      this.#sentModelKeys.add(record.directory);
    });
  }

  async #start() {
    const record = this.deviceRecord;
    const model = await this.#loadModel(record);
    this.#viewer = await startDeviceViewer(this.#canvas, {
      input: this.#input,
      viewport: record.viewport,
      surface: this.#surfaceSize(),
      model: {
        key: record.directory,
        glb: model.glb,
        screen: model.metadata.screen,
        pose: model.metadata.pose,
      },
      onCursor: (cursor) => {
        // The stylesheet's grab cursor keeps the orbit affordance when
        // the document does not claim the pointer.
        if (this.#canvas) {
          this.#canvas.style.cursor = cursor === "default" ? "" : cursor;
        }
      },
    });
    this.#sentModelKeys.add(record.directory);
  }

  #stop() {
    if (this.#viewer === null) return;
    this.#viewer.release();
    this.#viewer = null;
  }
}

export function defineSandomDevice() {
  if (!customElements.get("sandom-device")) {
    customElements.define("sandom-device", SandomDevice);
  }
}
