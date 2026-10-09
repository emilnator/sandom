import { createPlaygroundStage, playgroundRuntime, RUNTIME_READY, RUNTIME_DIAGNOSTICS } from "sandom/component-runtime";

const computedProperties = ["display", "position", "width", "height", "padding-top", "padding-right", "padding-bottom", "padding-left", "gap", "color", "background-color", "border-radius", "font-family", "font-size", "font-weight", "opacity", "transform"];

export async function createLiveComponent({ canvas, viewport, onFrame, onInspect, onFault }) {
  const runtime = await playgroundRuntime();
  if (runtime.status !== RUNTIME_READY) throw new Error(RUNTIME_DIAGNOSTICS[runtime.status]);
  // Probe the exact standard surface format before the visible canvas is bound.
  const probe = document.createElement("canvas");
  const context = probe.getContext("webgpu");
  if (!context) throw new Error("This browser refused the WebGPU canvas context. Open the studio in a WebGPU-capable browser.");
  context.configure({ device: runtime.device, format: navigator.gpu.getPreferredCanvasFormat(), colorSpace: "srgb", alphaMode: "premultiplied", toneMapping: { mode: "standard" } });
  context.unconfigure();
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  let selectedElement = null;
  let interaction = false;
  let inspection = false;
  let locked = false;
  let input = null;
  let fault = null;
  let frameCount = 0;
  const stage = await createPlaygroundStage({ canvas, width: viewport.width, height: viewport.height, deviceScale: viewport.deviceScale,
    onFrame: (statistics) => {
      frameCount = statistics.frames;
      onFrame?.({ ...statistics, text: stage.container.textContent, inspection: selectedElement?.isConnected ? inspectElement(selectedElement) : null });
    } });
  stage.input.dispose();
  stage.container.style.cssText = `width: ${viewport.width}px; height: ${viewport.height}px; display: flex; align-items: center; justify-content: center; background: #ffffff; font-family: Inter, sans-serif; color: #18181b;`;
  const revisionStyle = stage.document.createElement("style");
  stage.document.head.appendChild(revisionStyle);
  const { createRoot, createElement, flushSync } = stage.designSystem;
  const root = createRoot(stage.container, { onUncaughtError: (error) => { fault = error; onFault?.(error); } });
  const factories = new Map();
  const projection = runtime.projectOntoRectangle(canvas, viewport);

  function inspectElement(node) {
    const rect = node.getBoundingClientRect();
    const style = stage.realm.getComputedStyle(node);
    return { tag: node.localName, attributes: Object.fromEntries(node.getAttributeNames().map((name) => [name, node.getAttribute(name)])),
      text: node.textContent, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      style: Object.fromEntries(computedProperties.map((name) => [name, style.getPropertyValue(name)])),
      state: { value: node.value, checked: node.checked, disabled: node.disabled } };
  }
  function tree() {
    return Array.from(stage.container.querySelectorAll("*"), (node, index) => ({ index, ...inspectElement(node) }));
  }
  function updateInput() {
    input?.dispose();
    input = null;
    stage.document.activeElement?.blur();
    if (interaction && !inspection && !locked) {
      input = runtime.bindProjectedInput({ host: canvas, backend: stage.backend, root: stage.document.documentElement, project: projection,
        unproject: projection.unproject, label: "Live component keyboard input" });
    }
    canvas.style.cursor = inspection ? "crosshair" : "default";
  }
  function inspectPointer(event) {
    if (!inspection || locked) return;
    const point = projection(event);
    if (!point) return;
    const node = stage.backend.elementFromPoint(stage.document.documentElement, point.x, point.y);
    if (!node) throw new Error(`Sandom hit testing found no element at ${point.x}, ${point.y}. Select a node from the DOM tree.`);
    selectedElement = node;
    onInspect?.(inspectElement(node));
  }
  canvas.addEventListener("click", inspectPointer);
  async function mount(source, props) {
    selectedElement = null;
    fault = null;
    if (!factories.has(source.module)) {
      const module = await import(source.module);
      if (typeof module.createComponent !== "function") throw new Error(`${source.module} must export createComponent(runtime). Supply the same React runtime used by its shadcn components.`);
      const Component = module.createComponent(stage.designSystem);
      if (typeof Component !== "function") throw new Error(`${source.module} createComponent returned ${typeof Component}; expected a component function.`);
      factories.set(source.module, Component);
    }
    const stylesheet = await fetch(source.stylesheet);
    if (!stylesheet.ok) throw new Error(`Stylesheet ${source.stylesheet} returned HTTP ${stylesheet.status}. Restore the committed stylesheet.`);
    revisionStyle.textContent = await stylesheet.text();
    flushSync(() => root.render(createElement(factories.get(source.module), { ...props, key: crypto.randomUUID() })));
    if (fault) throw fault;
    // renderNow returns null while another frame owns the surface. Wait for
    // that owner before requesting the committed component's capture frame.
    await stage.surface.whenIdle();
    await stage.surface.renderNow();
    if (fault) throw fault;
    return tree();
  }
  function snapshot() {
    if (!frameCount) throw new Error("Sandom has presented zero frames. Render the component before capturing it.");
    if (canvas.width !== viewport.pixelWidth || canvas.height !== viewport.pixelHeight) throw new Error(`Canvas backing size ${canvas.width}×${canvas.height} differs from ${viewport.pixelWidth}×${viewport.pixelHeight}. Reload with matching capture density.`);
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("The browser refused a 2D readback canvas.");
    context.drawImage(canvas, 0, 0);
    return new Promise((resolve, reject) => copy.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG encoding returned no bytes. Preserve the visible rendering and inspect the browser error.")), "image/png"));
  }
  return { mount, snapshot, tree, inspect(index) {
    const node = stage.container.querySelectorAll("*")[index];
    if (!node) throw new Error(`DOM node ${index} is absent. Refresh inspection after the component renders.`);
    selectedElement = node;
    return inspectElement(node);
  }, setMode({ interactive, inspecting, busy = false }) {
    interaction = interactive;
    inspection = inspecting;
    locked = busy;
    updateInput();
  }, viewport, async dispose() {
    input?.dispose();
    canvas.removeEventListener("click", inspectPointer);
    flushSync(() => root.unmount());
    await stage.dispose();
  } };
}
