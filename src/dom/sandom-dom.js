// createSandomDOM: one Sandom document and the backend object a host drives
// it through. The public facade (dom.js) re-exports it; the document
// session and the component renderer import it from here, so neither
// imports the facade that re-exports them (test/module_graph_test.js).
import { validateClosedRecord } from "../closed-record.js";
import { SDDocument } from "./node.js";
import * as layoutGetters from "./layout-getters.js";
import { DEFAULT_VIEWPORT_HEIGHT, DEFAULT_VIEWPORT_WIDTH } from "./live-geometry.js";
import { createEvent, eventIntrinsics } from "./events.js";
import { createRenderSurface } from "./render-surface.js";
import { SandomViewport } from "./viewport.js";
import { createInputController, hostEditingPlatform } from "./input-controller.js";

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
const DOM_OPTION_NAMES = new Set([
  "viewportW",
  "viewportH",
  "deviceScale",
  "glyphResourceManager",
  "document",
  "sceneRendererRuntime",
  "fontRegistry",
  "editingPlatform",
]);

export function createSandomDOM(options = {}) {
  validateClosedRecord(options, DOM_OPTION_NAMES, "createSandomDOM options");
  let {
    viewportW = DEFAULT_VIEWPORT_WIDTH,
    viewportH = DEFAULT_VIEWPORT_HEIGHT,
    deviceScale = 1,
    glyphResourceManager,
    document = null,
    sceneRendererRuntime = null,
    fontRegistry = null,
    editingPlatform = hostEditingPlatform(),
  } = options;
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
  const input = createInputController(layoutOptions, editingPlatform);
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

    createRenderSurface(root, options = {}) {
      return createRenderSurface(root, {
        ...options,
        viewport: options.viewport ?? viewport,
        ...(glyphResourceManager !== undefined &&
            options.glyphResourceManager === undefined
          ? { glyphResourceManager }
          : {}),
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
