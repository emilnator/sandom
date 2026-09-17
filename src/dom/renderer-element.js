import { startBrowserPreview } from "./browser-preview-client.js";
import { renderInBrowserWorker } from "./browser-render-client.js";
import { STANDARD_RENDER_VIEWPORT } from "./render-planning.js";

const HTMLElementBase = globalThis.HTMLElement ?? class {};
const SUPPORTED_INPUT_EXTENSIONS = Object.freeze([".html", ".js", ".jsx"]);

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return number;
}

function positiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new RangeError(`${name} must be positive`);
  }
  return number;
}

export function selectSandomRendererInput(files) {
  const fileList = Array.from(files);
  const inputCandidates = fileList.filter((file) => {
    const lowerName = file.name.toLowerCase();
    return SUPPORTED_INPUT_EXTENSIONS.some((extension) =>
      lowerName.endsWith(extension)
    );
  });
  if (inputCandidates.length !== 1) {
    throw new TypeError(
      inputCandidates.length === 0
        ? "Select one HTML, JavaScript, or JSX input file"
        : "Select only one HTML, JavaScript, or JSX input file",
    );
  }
  const input = inputCandidates[0];
  return Object.freeze({
    input,
    resources: Object.freeze(fileList.filter((file) => file !== input)),
  });
}

export class SandomRendererElement extends HTMLElementBase {
  #previewSession = null;
  #previewSequence = 0;
  #exportOperation = null;
  #outputURL = null;
  #result = null;
  #state = "empty";
  #retainedSelection = null;
  #resizeState = null;

  constructor() {
    super();
    const shadowRoot = this.attachShadow({ mode: "open" });
    shadowRoot.innerHTML = `
      <style>
        :host {
          --sandom-renderer-field: #11131a;
          --sandom-renderer-ink: #f3f1e8;
          display: block;
          min-block-size: 42rem;
          box-sizing: border-box;
          color: var(--sandom-renderer-ink);
          background-color: var(--sandom-renderer-field);
          background-image:
            radial-gradient(circle at 22% 18%, #30306a 0, transparent 38%),
            radial-gradient(circle at 78% 72%, #5e283f 0, transparent 42%),
            linear-gradient(137deg, #11131a 8%, #24244b 48%, #11131a 92%);
          font: 14px/1.5 "IBM Plex Mono", ui-monospace, monospace;
          padding: 2rem 3ch;
        }
        *, *::before, *::after { box-sizing: border-box; }
        [hidden] { display: none !important; }
        [part="layout"] {
          display: grid;
          grid-template-columns: minmax(18ch, 24ch) minmax(32ch, 1fr) minmax(15ch, 19ch);
          gap: 3ch;
          min-block-size: 38rem;
        }
        [part="configuration"], [part="export"] {
          display: grid;
          align-content: start;
          gap: 1rem;
          padding: 1rem 2ch;
          color: var(--sandom-renderer-ink);
          background: var(--sandom-renderer-field);
        }
        h2, p { margin: 0; font: inherit; }
        h2 { text-transform: uppercase; letter-spacing: 0.08em; }
        label { display: grid; gap: 0.5rem; }
        input, select, button {
          min-inline-size: 0;
          padding: 0.5rem 1ch;
          border-radius: 0;
          color: var(--sandom-renderer-ink);
          background: var(--sandom-renderer-field);
          border: 1px solid var(--sandom-renderer-ink);
          font: inherit;
        }
        button { cursor: pointer; }
        button[data-primary] {
          color: var(--sandom-renderer-field);
          background: var(--sandom-renderer-ink);
          border: 0;
        }
        input:focus-visible, select:focus-visible, button:focus-visible,
        [part="drop-target"]:focus-within, [data-resize-handle]:focus-visible {
          outline: 2px solid var(--sandom-renderer-ink);
          outline-offset: 2px;
        }
        input[type="file"] {
          position: absolute;
          inline-size: 1px;
          block-size: 1px;
          overflow: hidden;
          clip-path: inset(50%);
        }
        [part="drop-target"] {
          display: grid;
          min-block-size: 6rem;
          place-items: center;
          padding: 1rem 2ch;
          border: 1px solid var(--sandom-renderer-ink);
          cursor: pointer;
          text-align: center;
        }
        [part="drop-target"][data-active], [part="drop-target"]:focus-within {
          color: var(--sandom-renderer-field);
          background: var(--sandom-renderer-ink);
        }
        [part="canvas-region"] {
          position: relative;
          display: grid;
          min-inline-size: 0;
          min-block-size: 38rem;
          place-items: center;
          overflow: auto;
          color: var(--sandom-renderer-ink);
          background: var(--sandom-renderer-field);
          contain: strict;
        }
        [data-canvas-stage] {
          position: relative;
          flex: none;
          transform-origin: top left;
        }
        canvas { display: block; inline-size: 100%; block-size: 100%; }
        [data-resize-handle] {
          position: absolute;
          inset-inline-end: -1ch;
          inset-block-end: -1rem;
          inline-size: 3ch;
          block-size: 2rem;
          display: grid;
          place-items: center;
          color: var(--sandom-renderer-field);
          background: var(--sandom-renderer-ink);
          cursor: nwse-resize;
          user-select: none;
        }
        [part="placeholder"], [part="warning"], [part="error"] {
          max-inline-size: 56ch;
          padding: 2rem 3ch;
          white-space: pre-wrap;
        }
        [part="status"] { min-block-size: 3rem; }
        [data-download] { text-align: center; text-decoration: none; }
        details { padding-block: 0.5rem; }
        summary { cursor: pointer; }
        pre { overflow: auto; white-space: pre-wrap; }
        @media (max-width: 74rem) {
          [part="layout"] { grid-template-columns: minmax(18ch, 24ch) minmax(30ch, 1fr); }
          [part="export"] { grid-column: 1 / -1; }
        }
        @media (max-width: 52rem) {
          [part="layout"] { grid-template-columns: 1fr; }
          [part="canvas-region"] { min-block-size: 30rem; }
          [part="export"] { grid-column: auto; }
        }
      </style>
      <section part="layout">
        <section part="configuration" aria-labelledby="sandom-configuration-label">
          <h2 id="sandom-configuration-label">Configuration</h2>
          <label part="drop-target">
            <span>Choose or drop one HTML, JavaScript, or JSX file</span>
            <input type="file" accept=".html,.js,.jsx,text/html,text/javascript" multiple>
          </label>
          <label>Viewport width
            <input data-viewport-width type="number" min="1" step="1" value="${STANDARD_RENDER_VIEWPORT.width}">
          </label>
          <label>Viewport height
            <input data-viewport-height type="number" min="1" step="1" value="${STANDARD_RENDER_VIEWPORT.height}">
          </label>
          <label>Zoom
            <input data-zoom type="range" min="10" max="400" step="10" value="100">
            <output data-zoom-output>100%</output>
          </label>
          <p>Drag the square at the lower-right of the canvas to change its viewport.</p>
          <p part="status" role="status" aria-live="polite">Choose an input to start the live preview.</p>
        </section>
        <section part="canvas-region" aria-label="Live Sandom canvas">
          <p part="placeholder">The live WebGPU preview appears here. Preview does not encode or download an image.</p>
          <div data-canvas-stage hidden>
            <canvas aria-label="Live Sandom rendered content"></canvas>
            <div data-resize-handle role="separator" tabindex="0" aria-label="Resize viewport" aria-orientation="horizontal">↘</div>
          </div>
          <pre part="warning" role="status" aria-live="polite" hidden></pre>
          <pre part="error" role="alert" hidden></pre>
        </section>
        <section part="export" aria-labelledby="sandom-export-label">
          <h2 id="sandom-export-label">Export</h2>
          <label>Format
            <select data-export-format>
              <option value="auto">Automatic</option>
              <option value="png">PNG</option>
              <option value="gif">GIF</option>
              <option value="jpeg-xl">JPEG XL</option>
            </select>
          </label>
          <button data-export type="button" data-primary disabled>Export</button>
          <a data-download hidden>Download output</a>
          <details part="plan" hidden><summary>Export plan</summary><pre></pre></details>
        </section>
      </section>
    `;
    const input = shadowRoot.querySelector('input[type="file"]');
    const dropTarget = shadowRoot.querySelector('[part="drop-target"]');
    input.addEventListener("change", () => {
      if (input.files.length > 0) this.previewFiles(input.files);
    });
    for (const eventName of ["dragenter", "dragover"]) {
      dropTarget.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropTarget.toggleAttribute("data-active", true);
      });
    }
    for (const eventName of ["dragleave", "drop"]) {
      dropTarget.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropTarget.toggleAttribute("data-active", false);
      });
    }
    dropTarget.addEventListener("drop", (event) => {
      if (event.dataTransfer.files.length > 0) {
        this.previewFiles(event.dataTransfer.files);
      }
    });
    const width = shadowRoot.querySelector("[data-viewport-width]");
    const height = shadowRoot.querySelector("[data-viewport-height]");
    for (const control of [width, height]) {
      control.addEventListener(
        "change",
        () => this.#resizePreviewFromControls(),
      );
    }
    const zoom = shadowRoot.querySelector("[data-zoom]");
    zoom.addEventListener("input", () => this.#applyZoom());
    shadowRoot.querySelector("[data-export]").addEventListener("click", () => {
      this.export().catch((error) => {
        if (this.#state !== "failed" && this.#state !== "cancelled") {
          throw error;
        }
      });
    });
    const resizeHandle = shadowRoot.querySelector("[data-resize-handle]");
    resizeHandle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      resizeHandle.setPointerCapture(event.pointerId);
      this.#resizeState = {
        pointerIdentifier: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        width: positiveInteger(width.value, "Viewport width"),
        height: positiveInteger(height.value, "Viewport height"),
      };
    });
    resizeHandle.addEventListener("pointermove", (event) => {
      if (this.#resizeState?.pointerIdentifier !== event.pointerId) return;
      const zoomScale = positiveNumber(zoom.value, "Zoom") / 100;
      width.value = String(Math.max(
        1,
        Math.round(
          this.#resizeState.width +
            (event.clientX - this.#resizeState.startX) / zoomScale,
        ),
      ));
      height.value = String(Math.max(
        1,
        Math.round(
          this.#resizeState.height +
            (event.clientY - this.#resizeState.startY) / zoomScale,
        ),
      ));
      this.#resizePreviewFromControls();
    });
    resizeHandle.addEventListener("pointerup", (event) => {
      if (this.#resizeState?.pointerIdentifier !== event.pointerId) return;
      resizeHandle.releasePointerCapture(event.pointerId);
      this.#resizeState = null;
    });
    resizeHandle.addEventListener("keydown", (event) => {
      const delta = event.shiftKey ? 10 : 1;
      if (
        !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
      ) return;
      event.preventDefault();
      if (event.key === "ArrowLeft") {
        width.value = String(Math.max(1, Number(width.value) - delta));
      }
      if (event.key === "ArrowRight") {
        width.value = String(Number(width.value) + delta);
      }
      if (event.key === "ArrowUp") {
        height.value = String(Math.max(1, Number(height.value) - delta));
      }
      if (event.key === "ArrowDown") {
        height.value = String(Number(height.value) + delta);
      }
      this.#resizePreviewFromControls();
    });
    this.#applyZoom();
  }

  get result() {
    return this.#result;
  }
  get state() {
    return this.#state;
  }

  #viewport() {
    return Object.freeze({
      width: positiveInteger(
        this.shadowRoot.querySelector("[data-viewport-width]").value,
        "Viewport width",
      ),
      height: positiveInteger(
        this.shadowRoot.querySelector("[data-viewport-height]").value,
        "Viewport height",
      ),
    });
  }

  #applyZoom() {
    const scale = positiveNumber(
      this.shadowRoot.querySelector("[data-zoom]").value,
      "Zoom",
    ) / 100;
    const viewport = this.#viewport();
    const stage = this.shadowRoot.querySelector("[data-canvas-stage]");
    stage.setAttribute(
      "style",
      `width:${viewport.width * scale}px;height:${viewport.height * scale}px`,
    );
    this.shadowRoot.querySelector("[data-zoom-output]").value = `${
      Math.round(scale * 100)
    }%`;
  }

  #resizePreviewFromControls() {
    const viewport = this.#viewport();
    this.#applyZoom();
    this.#previewSession?.resize(viewport.width, viewport.height);
    this.shadowRoot.querySelector('[part="status"]').textContent =
      `Live preview: ${viewport.width} × ${viewport.height}.`;
  }

  async previewFiles(files, options = {}) {
    const selection = selectSandomRendererInput(files);
    return await this.preview(selection.input, {
      ...options,
      resources: options.resources ?? selection.resources,
    });
  }

  async preview(input, options = {}) {
    this.cancel();
    this.#retainedSelection = Object.freeze({
      input,
      options: Object.freeze({ ...options }),
    });
    const sequence = ++this.#previewSequence;
    this.#state = "preparing";
    this.#result = null;
    const shadowRoot = this.shadowRoot;
    const status = shadowRoot.querySelector('[part="status"]');
    const error = shadowRoot.querySelector('[part="error"]');
    const warning = shadowRoot.querySelector('[part="warning"]');
    const placeholder = shadowRoot.querySelector('[part="placeholder"]');
    const nextStage = shadowRoot.querySelector("[data-canvas-stage]");
    const priorCanvas = nextStage.querySelector("canvas");
    const nextCanvas = this.ownerDocument.createElement("canvas");
    nextCanvas.setAttribute("aria-label", "Live Sandom rendered content");
    priorCanvas.replaceWith(nextCanvas);
    error.hidden = true;
    error.textContent = "";
    warning.hidden = true;
    warning.textContent = "";
    placeholder.hidden = false;
    nextStage.hidden = true;
    shadowRoot.querySelector("[data-export]").disabled = true;
    status.textContent = "Loading live preview.";
    this.dispatchEvent(
      new CustomEvent("sandom-preview-start", {
        detail: Object.freeze({ input }),
      }),
    );
    try {
      const session = await startBrowserPreview(nextCanvas, input, {
        ...options,
        viewport: this.#viewport(),
        onFrame: () => {
          if (this.#previewSequence !== sequence) return;
          placeholder.hidden = true;
          nextStage.hidden = false;
        },
      });
      if (this.#previewSequence !== sequence) {
        session.release();
        return session;
      }
      this.#previewSession = session;
      this.#state = "previewing";
      this.#applyZoom();
      const viewport = this.#viewport();
      status.textContent =
        `Live preview: ${viewport.width} × ${viewport.height}.`;
      const previewDiagnostics = session.metadata.diagnostics ?? [];
      warning.textContent = previewDiagnostics
        .filter((diagnostic) =>
          diagnostic.recoverable === true && diagnostic.severity === "warning"
        )
        .map((diagnostic) => diagnostic.message)
        .join("\n");
      warning.hidden = warning.textContent.length === 0;
      shadowRoot.querySelector("[data-export]").disabled = false;
      this.dispatchEvent(
        new CustomEvent("sandom-preview-ready", {
          detail: Object.freeze({ session, metadata: session.metadata }),
        }),
      );
      return session;
    } catch (caught) {
      if (this.#previewSequence !== sequence) throw caught;
      this.#state = "failed";
      placeholder.hidden = true;
      nextStage.hidden = true;
      error.textContent = caught?.message ?? String(caught);
      error.hidden = false;
      status.textContent = "Preview failed.";
      this.dispatchEvent(
        new CustomEvent("sandom-preview-error", {
          detail: Object.freeze({ error: caught }),
        }),
      );
      throw caught;
    }
  }

  async export(options = {}) {
    if (this.#retainedSelection === null || this.#state === "failed") {
      throw new Error("Export requires an active preview input");
    }
    this.#exportOperation?.abortController.abort(
      new DOMException("Export replaced", "AbortError"),
    );
    const abortController = new AbortController();
    this.#exportOperation = { abortController };
    const shadowRoot = this.shadowRoot;
    const status = shadowRoot.querySelector('[part="status"]');
    status.textContent = "Encoding export.";
    shadowRoot.querySelector("[data-export]").disabled = true;
    try {
      const format = shadowRoot.querySelector("[data-export-format]").value;
      const retainedOptions = this.#retainedSelection.options;
      const result = await renderInBrowserWorker(
        this.#retainedSelection.input,
        {
          ...retainedOptions,
          ...options,
          resources: options.resources ?? retainedOptions.resources,
          request: {
            ...(retainedOptions.request ?? {}),
            ...(options.request ?? {}),
            output: format,
            viewport: this.#viewport(),
          },
          signal: options.signal === undefined
            ? abortController.signal
            : AbortSignal.any([abortController.signal, options.signal]),
        },
      );
      if (this.#exportOperation?.abortController !== abortController) {
        return result;
      }
      this.#exportOperation = null;
      this.#result = result;
      if (this.#outputURL !== null) URL.revokeObjectURL(this.#outputURL);
      this.#outputURL = URL.createObjectURL(
        new Blob([result.output.bytes], {
          type: result.output.mediaType,
        }),
      );
      const download = shadowRoot.querySelector("[data-download]");
      download.href = this.#outputURL;
      download.download = `${
        this.#retainedSelection.input.name.replace(/\.[^.]+$/, "")
      }${result.output.extension}`;
      download.textContent = `Download ${result.output.format.toUpperCase()}`;
      download.hidden = false;
      const plan = shadowRoot.querySelector('[part="plan"]');
      plan.hidden = !this.hasAttribute("show-plan");
      plan.querySelector("pre").textContent = JSON.stringify(
        result.plan,
        null,
        2,
      );
      const exportDiagnostics = result.diagnostics ?? [];
      const warning = shadowRoot.querySelector('[part="warning"]');
      warning.textContent = exportDiagnostics
        .filter((diagnostic) =>
          diagnostic.recoverable === true && diagnostic.severity === "warning"
        )
        .map((diagnostic) => diagnostic.message)
        .join("\n");
      warning.hidden = warning.textContent.length === 0;
      status.textContent = result.output.format === "gif"
        ? `Export ready: ${result.output.frameCount} animation frames.`
        : "Export ready: one image.";
      shadowRoot.querySelector("[data-export]").disabled = false;
      this.dispatchEvent(
        new CustomEvent("sandom-export-complete", {
          detail: Object.freeze({ result }),
        }),
      );
      return result;
    } catch (caught) {
      if (this.#exportOperation?.abortController !== abortController) {
        throw caught;
      }
      this.#exportOperation = null;
      shadowRoot.querySelector("[data-export]").disabled = false;
      status.textContent = caught?.name === "AbortError"
        ? "Export canceled."
        : "Export failed.";
      if (caught?.name !== "AbortError") {
        this.dispatchEvent(
          new CustomEvent("sandom-export-error", {
            detail: Object.freeze({ error: caught }),
          }),
        );
      }
      throw caught;
    }
  }

  renderFiles(files, options = {}) {
    return this.previewFiles(files, options);
  }
  render(input, options = {}) {
    return this.preview(input, options);
  }

  cancel() {
    this.#previewSequence++;
    this.#previewSession?.release();
    this.#previewSession = null;
    this.#exportOperation?.abortController.abort(
      new DOMException("The browser export was canceled", "AbortError"),
    );
    this.#exportOperation = null;
  }

  clear() {
    this.cancel();
    if (this.#outputURL !== null) URL.revokeObjectURL(this.#outputURL);
    this.#outputURL = null;
    this.#result = null;
    this.#retainedSelection = null;
    this.#state = "empty";
    const shadowRoot = this.shadowRoot;
    shadowRoot.querySelector('[part="placeholder"]').hidden = false;
    shadowRoot.querySelector('[part="error"]').hidden = true;
    shadowRoot.querySelector('[part="warning"]').hidden = true;
    shadowRoot.querySelector('[part="warning"]').textContent = "";
    shadowRoot.querySelector("[data-canvas-stage]").hidden = true;
    shadowRoot.querySelector("[data-export]").disabled = true;
    shadowRoot.querySelector("[data-download]").hidden = true;
    shadowRoot.querySelector('[part="plan"]').hidden = true;
    shadowRoot.querySelector('[part="status"]').textContent =
      "Choose an input to start the live preview.";
  }

  disconnectedCallback() {
    this.clear();
  }
}

export function defineSandomRenderer(
  name = "sandom-renderer",
  registry = globalThis.customElements,
) {
  if (registry === undefined) {
    throw new Error("defineSandomRenderer requires a custom element registry");
  }
  const existing = registry.get(name);
  if (existing === undefined) registry.define(name, SandomRendererElement);
  else if (existing !== SandomRendererElement) {
    throw new Error(`${name} is registered with a different constructor`);
  }
  return SandomRendererElement;
}
