export { createSandomRuntime } from "../scene-renderer.js";
export {
  defineSandomInteractiveRenderer,
  SandomInteractiveRendererElement,
} from "./interactive-renderer-element.js";
import {
  renderAnimationInput,
  renderDocumentAnimation,
  renderHTMLAnimation,
} from "./render-animation.js";
export { renderAnimationInput, renderDocumentAnimation, renderHTMLAnimation };
export { createDocumentSession, DocumentSession } from "./document-session.js";
export { renderComponent } from "./render-component.js";
export { recommendMotionCapture } from "./motion-capture-recommendation.js";
export {
  planAutomaticViewport,
  renderInput,
  RenderPlanningError,
} from "./render-planning.js";
export { renderInBrowserWorker } from "./browser-render-client.js";
export {
  defineSandomRenderer,
  SandomRendererElement,
  selectSandomRendererInput,
} from "./renderer-element.js";
export {
  BROWSER_RENDER_ERROR_KIND,
  BROWSER_RENDER_PROTOCOL_VERSION,
  BROWSER_RENDER_READY_KIND,
  BROWSER_RENDER_REQUEST_KIND,
  BROWSER_RENDER_RESULT_KIND,
} from "./browser-render-worker-protocol.js";
export {
  installBrowserRenderWorker,
  renderBrowserWorkerRequest,
} from "./browser-render-worker-runtime.js";
export { evaluateComponentModule } from "./input-preprocessors.js";
export { SDDocument as SandomDocument } from "./node.js";
// Public Sandom DOM facade. This module owns document construction,
// interaction, layout inspection, rendering surfaces, and render planning.
// Product adapters belong in separate modules.

import { DOMParser, SDDocument } from "./node.js";
import * as layoutGetters from "./layout-getters.js";
import {
  createEvent,
  dispatchEvent as dispatchSandomEvent,
  eventIntrinsics,
} from "./events.js";
import { serializeToScene } from "./serialize.js";
import { createLayoutArtifact, renderScenePixels } from "../scene-renderer.js";
import { CSSKeyframesRule } from "./stylesheet.js";
import { createRenderSurface } from "./render-surface.js";
import { SandomViewport } from "./viewport.js";
import { createInputController } from "./input-controller.js";



// The layout-getter family, keyed by the EXACT property names swarm.js
// routes through getProperty (swarm.js:153-172) — a plain lookup table
// so getProperty's own body doesn't need a long if/else chain.
const LAYOUT_GETTER_PROPERTIES = {
  offsetWidth: layoutGetters.offsetWidth,
  offsetHeight: layoutGetters.offsetHeight,
  offsetTop: layoutGetters.offsetTop,
  offsetLeft: layoutGetters.offsetLeft,
  clientWidth: layoutGetters.clientWidth,
  clientHeight: layoutGetters.clientHeight,
  scrollTop: layoutGetters.scrollTop,
  scrollLeft: layoutGetters.scrollLeft,
  scrollWidth: layoutGetters.scrollWidth,
  scrollHeight: layoutGetters.scrollHeight,
};

// Layout getters require an explicit viewport. The default matches the
// established Sandom oracle viewport and callers can override it.
export function createSandomDOM({
  viewportW = layoutGetters.DEFAULT_VIEWPORT_WIDTH,
  viewportH = layoutGetters.DEFAULT_VIEWPORT_HEIGHT,
  deviceScale = 1,
  glyphResourceManager,
  onSnapshotPerformance,
  document = null,
  sceneRendererRuntime = null,
  fontRegistry = null,
} = {}) {
  sceneRendererRuntime ??= document?._sandomSceneRendererRuntime ?? null;
  fontRegistry ??= sceneRendererRuntime?.fontRegistry;
  document ??= new SDDocument({ core: sceneRendererRuntime?.core, fontRegistry });
  if (sceneRendererRuntime && document._domCore !== sceneRendererRuntime.core) {
    throw new TypeError("The document belongs to a different renderer core");
  }
  document._sandomSceneRendererRuntime = sceneRendererRuntime;
  if (fontRegistry) {
    if (fontRegistry.core !== document._domCore) {
      throw new TypeError("The font registry belongs to a different renderer core");
    }
    document._sandomFontRegistry = fontRegistry;
  }
  const layoutOptions = { viewportW, viewportH };
  const viewport = new SandomViewport({
    width: viewportW,
    height: viewportH,
    deviceScale,
  });
  const eventListenerWrappers = new WeakMap();
  const input = createInputController(document, layoutOptions);
  const { pointerController, ...inputBindings } = input;

  return {
    ...inputBindings,
    viewport,
    document,
    createElement(tag) {
      const element = document.createElement(tag);
      element._pointerController = pointerController;
      element._layoutOptions = layoutOptions;
      return element;
    },
    createElementNS(namespace, tag) {
      const element = document.createElementNS(namespace, tag);
      element._pointerController = pointerController;
      element._layoutOptions = layoutOptions;
      return element;
    },
    createTextNode(text) {
      return document.createTextNode(text);
    },
    createComment(text) {
      return document.createComment(text);
    },
    createDocumentFragment() {
      return document.createDocumentFragment();
    },

    appendChild(parent, child) {
      parent.appendChild(child);
    },
    removeChild(parent, child) {
      parent.removeChild(child);
    },
    insertBefore(parent, node, ref) {
      parent.insertBefore(node, ref);
    },
    replaceChild(parent, newChild, old) {
      parent.replaceChild(newChild, old);
    },
    cloneNode(node, deep) {
      return node.cloneNode(deep);
    },

    getProperty(node, name) {
      if (name === "children") return Array.from(node.children);
      if (name in LAYOUT_GETTER_PROPERTIES) {
        return LAYOUT_GETTER_PROPERTIES[name](node, layoutOptions);
      }
      return node[name];
    },
    setProperty(node, name, value) {
      node[name] = value;
    },

    // A real handler, not routed through getProperty (swarm.js:309 calls
    // backend.getBoundingClientRect(node) directly) — matches the
    // browser backend's own separate method (frontend-iris.js:91-95).
    getBoundingClientRect(node) {
      return layoutGetters.getBoundingClientRect(node, layoutOptions);
    },

    // The render entry point — NOT part of the pinned backend.* contract
    // swarm.js drives. It returns the RGBA render product. Callers that need a
    // persisted image must pass these pixels to an explicit encoder.
    //
    // `root` is the tree's own root element (this backend has no
    // implicit "the" tree the way a real `document` does — every other
    // method here already takes its node explicitly, same convention).
    // Reuses this backend's own viewport size (the same one
    // getBoundingClientRect/offsetWidth etc. already use) unless
    // overridden; deviceScale defaults to 1 (CSS-px-equivalent output,
    // matching a plain screenshot) but accepts N>1 for a Retina-quality
    // snapshot, same convention renderScenePixels itself already uses.
    async renderSnapshot(
      root,
      { viewportW: overrideW, viewportH: overrideH, deviceScale = 1 } = {},
    ) {
      const w = overrideW ?? viewportW;
      const h = overrideH ?? viewportH;
      const serializationStartedAt = onSnapshotPerformance
        ? performance.now()
        : 0;
      const serialized = serializeToScene(root, {
        viewportWidth: w,
        viewportHeight: h,
      });
      const { nodes, indexOf, imageSources } = serialized;
      const serializationFinishedAt = onSnapshotPerformance
        ? performance.now()
        : 0;
      const {
        pixels,
        width,
        height,
        boxes,
        performance: rendererPerformance,
      } = await (sceneRendererRuntime?.renderScenePixels ?? renderScenePixels)(
        {
          width: w,
          height: h,
          nodes,
          imageSources,
        },
        deviceScale,
        { glyphResourceManager },
      );
      if (onSnapshotPerformance) {
        onSnapshotPerformance(Object.freeze({
          serializationMilliseconds: serializationFinishedAt -
            serializationStartedAt,
          rasterizationMilliseconds: performance.now() -
            serializationFinishedAt,
          glyphs: rendererPerformance.glyphs,
        }));
      }
      return {
        pixels,
        width,
        height,
        deviceScale,
        // The serialization stays referenced: its publication is the
        // geometry builder's row source for this layout.
        layout: { boxes, indexOf, serialized, publication: serialized.publication },
      };
    },

    createRenderSurface(root, options = {}) {
      return createRenderSurface(root, {
        ...options,
        viewport: options.viewport ?? viewport,
        glyphResourceManager: options.glyphResourceManager ??
          glyphResourceManager ?? null,
        renderPixels: options.renderPixels ??
          sceneRendererRuntime?.renderScenePixels,
        layoutScene: options.layoutScene ??
          sceneRendererRuntime?.layoutTreeBoxes,
        // A DOM with its own runtime always gets that runtime's persistent
        // renderer. Without one, leave the choice to the surface's own
        // default (renderPixels identity), which selects the module-level
        // persistent renderer — forcing false here killed engine-backed
        // animations for every bare createSandomDOM().
        usePersistentRenderer: options.usePersistentRenderer ??
          (sceneRendererRuntime !== null ? true : undefined),
        createPersistentRenderer: options.createPersistentRenderer ??
          sceneRendererRuntime?.createSceneRendererForCurrentModule,
      });
    },

    getAttribute(node, name) {
      return node.getAttribute(name);
    },
    setAttribute(node, name, value) {
      node.setAttribute(name, value);
    },
    removeAttribute(node, name) {
      node.removeAttribute(name);
    },
    hasAttribute(node, name) {
      return node.hasAttribute(name);
    },

    getStyle(node) {
      return node.style;
    },

    getClassList(node) {
      return node.classList;
    },

    // Interactivity — real passthroughs.
    focus(node) {
      node.focus();
    },
    blur(node) {
      node.blur();
    },
    select(node) {
      node.select();
    },
    click(node) {
      node.click();
    },
    scrollIntoView(node, options) {
      node.scrollIntoView(options);
    },
    elementFromPoint(root, x, y) {
      return layoutGetters.elementFromPoint(root, x, y, layoutOptions);
    },
    inspectScrolling(root, target = root._renderSurface?.viewport) {
      const surface = root._renderSurface;
      if (!surface) {
        throw new Error("inspectScrolling: root has no live render surface");
      }
      return surface.inspectScrolling(target);
    },
    getScrollbars(root) {
      return Object.freeze(
        (root._renderSurface?.scrollbars ?? []).map((scrollbar) =>
          Object.freeze({
            role: "scrollbar",
            orientation: scrollbar.orientation,
            valueMinimum: scrollbar.minimum,
            valueMaximum: scrollbar.maximum,
            valueNow: scrollbar.value,
            controls: scrollbar.element,
            track: Object.freeze({ ...scrollbar.track }),
            thumb: Object.freeze({ ...scrollbar.thumb }),
          })
        ),
      );
    },
    setSelectionRange(node, start, end, direction) {
      node.setSelectionRange(start, end, direction);
    },

    // §3, RULED BUILD NOW — real passthroughs (closest returns the
    // SDElement or null; the cap's ensureElementHandle handles
    // wrapping/null, same as any other node-returning backend call).
    matches(node, selector) {
      return node.matches(selector);
    },
    closest(node, selector) {
      return node.closest(selector);
    },

    addEventListener(node, type, callback) {
      let wrapper = eventListenerWrappers.get(callback);
      if (!wrapper) {
        wrapper = (event) => callback(eventIntrinsics(event));
        eventListenerWrappers.set(callback, wrapper);
      }
      node.addEventListener(type, wrapper);
    },
    removeEventListener(node, type, callback) {
      const wrapper = eventListenerWrappers.get(callback);
      if (wrapper) node.removeEventListener(type, wrapper);
    },
    dispatchEvent(node, name, detail) {
      return node.dispatchEvent(createEvent(name, { detail, bubbles: true }));
    },
  };
}

export async function renderHTMLToImage(source, {
  viewportW = layoutGetters.DEFAULT_VIEWPORT_WIDTH,
  viewportH = layoutGetters.DEFAULT_VIEWPORT_HEIGHT,
  deviceScale = 1,
  baseURL = "about:blank",
  resolveResource = null,
} = {}) {
  return await renderAnimationInput({
    url: new URL(baseURL),
    bytes: new TextEncoder().encode(String(source)),
  }, {
    preprocessor: "html",
    format: "png",
    width: viewportW,
    height: viewportH,
    deviceScale,
    resolveResource,
  });
}

export async function inspectHTML(source, {
  viewportW = layoutGetters.DEFAULT_VIEWPORT_WIDTH,
  viewportH = layoutGetters.DEFAULT_VIEWPORT_HEIGHT,
  layout = false,
} = {}) {
  const document = new DOMParser().parseFromString(String(source), "text/html");
  const nodes = [];
  const domNodes = [];
  const pending = [{
    node: document.documentElement,
    parentIndex: null,
  }];
  let pendingIndex = 0;
  const resourceReferences = [];

  while (pendingIndex < pending.length) {
    const { node, parentIndex } = pending[pendingIndex++];
    const index = nodes.length;
    const record = {
      index,
      parentIndex,
      type: node.nodeType === 1
        ? "element"
        : node.nodeType === 3
        ? "text"
        : node.nodeType === 8
        ? "comment"
        : "other",
      name: node.nodeName,
      children: [],
    };
    if (node.nodeType === 1) {
      record.attributes = Object.fromEntries(node.attributes);
      for (
        const [attribute, kind] of [
          ["src", node.localName === "script" ? "script" : "image"],
          ["href", node.localName === "link" ? "stylesheet" : "link"],
        ]
      ) {
        const value = node.getAttribute(attribute);
        if (value !== null) {
          resourceReferences.push(Object.freeze({
            kind,
            url: value,
            source: "attribute",
            nodeIndex: index,
          }));
        }
      }
    } else if (node.nodeType === 3 || node.nodeType === 8) {
      record.text = node.data;
    }
    nodes.push(record);
    domNodes.push(node);
    if (parentIndex !== null) nodes[parentIndex].children.push(index);
    for (const child of node.childNodes) {
      pending.push({ node: child, parentIndex: index });
    }
  }

  const styleSheets = [...document.styleSheets];
  let keyframeRuleCount = 0;
  const styleDiagnostics = [];
  for (const styleSheet of styleSheets) {
    styleDiagnostics.push(...styleSheet.diagnostics);
    const rules = [...styleSheet.cssRules];
    while (rules.length > 0) {
      const rule = rules.pop();
      if (rule instanceof CSSKeyframesRule) keyframeRuleCount++;
      if (rule.cssRules) rules.push(...rule.cssRules);
    }
  }
  let layoutRecord = null;
  if (layout) {
    const serialized = serializeToScene(document.documentElement, {
      viewportWidth: viewportW,
      viewportHeight: viewportH,
    });
    const artifact = await createLayoutArtifact({
      width: viewportW,
      height: viewportH,
      nodes: serialized.nodes,
      imageSources: serialized.imageSources,
    });
    layoutRecord = Object.freeze({
      boxes: Object.freeze(nodes.flatMap((node, index) => {
        const boxIndex = serialized.indexOf.get(domNodes[index]);
        const box = boxIndex === undefined
          ? undefined
          : artifact.boxes[boxIndex];
        return box === undefined ? [] : [Object.freeze({
          nodeIndex: node.index,
          x: box.borderBox.x,
          y: box.borderBox.y,
          width: box.borderBox.width,
          height: box.borderBox.height,
          scrollWidth: box.scroll.width,
          scrollHeight: box.scroll.height,
        })];
      })),
    });
  }

  return Object.freeze({
    kind: "html-inspection",
    version: 1,
    document: Object.freeze({
      title: document.title,
      language: document.documentElement.getAttribute("lang") ?? "",
      compatibilityMode: document.compatMode,
      scripts: Object.freeze({
        count: document.querySelectorAll("script").length,
        execution: "inert",
      }),
    }),
    viewport: Object.freeze({ width: viewportW, height: viewportH }),
    tree: Object.freeze({
      root: 0,
      nodes: Object.freeze(nodes.map((node) =>
        Object.freeze({
          ...node,
          attributes: node.attributes === undefined
            ? undefined
            : Object.freeze(node.attributes),
          children: Object.freeze(node.children),
        })
      )),
    }),
    styles: Object.freeze({
      styleSheetCount: styleSheets.length,
      keyframeRuleCount,
      diagnostics: Object.freeze(styleDiagnostics),
    }),
    resources: Object.freeze({
      references: Object.freeze(resourceReferences),
    }),
    layout: layoutRecord,
    diagnostics: Object.freeze([]),
  });
}
