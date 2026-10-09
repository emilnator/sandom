// The `style` proxy accepts CSS-shaped property writes and resolves them into
// the flat fields consumed by the scene writer. Invalid values for supported
// programmatic properties fail loudly; unknown named-property assignments are
// CSSOM no-ops. Parsed declaration lists follow CSS recovery: unsupported
// declarations are discarded and exposed through `style.diagnostics`.
//
// serialize.js reads an element's resolved fields via style._fields — a
// plain object shaped exactly like an examples/scenes.js node (minus
// `children`, which the tree walk supplies).

import { parseCSSEasing } from "../dom-wasm/easing.js";
import { sharedDomCore } from "../dom-wasm/core.js";
import { animationLength as parseAnimationLength, animationLineHeight, animationProperty } from "../dom-wasm/animation.js";
import { createInlineStyleClass } from "./dom-bindings.generated.js";

// ---- value parsing ----

// The WebAssembly color kernel owns the color grammar and every numeric
// conversion step (docs/specifications/color-and-image-data.md). This module
// only routes strings to it.

// "#rrggbb" / functional CSS Color 4 forms / a named color -> {r,g,b,a} in
// extended sign-mirrored encoded sRGB - standard mode's working encoding
// (docs/specifications/color-and-image-data.md). The DOM core parses and
// converts through the shared color kernel; wide-gamut and high-dynamic-
// range input keeps components below zero and above one; no gamut map and
// no channel clamp run here. Native raster-plan preparation converts these
// values into linear Rec. 2020 for the high-dynamic-range render path. An
// invalid value throws.
export function parseColor(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  if (typeof raw === "object") return raw;
  const color = sharedDomCore.parseColor(raw);
  if (color === null) throw new Error(`CSS color "${raw}": invalid value`);
  return color;
}




export function repeatedListValue(values, index) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError("Cannot repeat an empty style list");
  }
  return values[sharedDomCore.status("animation_list_index", values.length, index)];
}


// The ONE way to read an element's style facts outside the style system:
// cascade-resolved fields (stylesheet rules plus inline style) when a
// style system exists, inline fields otherwise (detached trees, tests).
// Reading `element.style._fields` directly misses class-driven values -
// the interaction snapshot, scrollbars, anchoring, and snapping all
// consume this instead (presented-frame refactor, Slice 3).
export function resolvedElementFields(element) {
  if (element?.nodeType !== 1) return {};
  return element.ownerDocument?._styleSystem?.resolvedFields?.(element) ??
    element.style?._fields ?? {};
}

export function resolvedOverflowAxes(fields) {
  let x = fields.overflowX ?? fields.overflow ?? "visible";
  let y = fields.overflowY ?? fields.overflow ?? "visible";
  const originalX = x;
  const originalY = y;
  if (originalX === "visible" && !["visible", "clip"].includes(originalY)) {
    x = "auto";
  }
  if (originalY === "visible" && !["visible", "clip"].includes(originalX)) {
    y = "auto";
  }
  if (originalX === "clip" && !["visible", "clip"].includes(originalY)) {
    x = "hidden";
  }
  if (originalY === "clip" && !["visible", "clip"].includes(originalX)) {
    y = "hidden";
  }
  return { x, y };
}

export function cssPropertyToIDLName(name) {
  return sharedDomCore.styleIDLName(String(name));
}

export function idlPropertyToCSSName(name) {
  return sharedDomCore.styleCSSName(String(name));
}


// Cascade swallow policy (BUG-document-parity-divergences.md, decided
// 2026-08-25): the ENGINE stays CSS-conformant — an unsupported or
// unparseable declaration is dropped from the cascade like a browser
// drops an unknown property — but every drop is RECORDED here so the
// parity gate can fail loudly on documents that silently lost styling.
// Four separate document divergences (flex, border sides, place-items,
// grid-row) each hid behind a silent drop before this registry existed.
// Consumers (the parity harness) read and clear between documents.
export const droppedDeclarations = new Set();


// ---- CSSStyleDeclaration parity ----
//
// The real pod cap's bindStyleHandle (swarm.js) assumes
// getStyle(node) returns something that behaves like a real
// CSSStyleDeclaration — in particular, plain property/bracket assignment
// is a silent no-op for CSS custom properties (`--foo`); only
// setProperty/getPropertyValue/removeProperty actually work for those.
// The proxy preserves this JavaScript property-assignment distinction; the
// explicit methods use the core's custom declaration storage.


function parseAnimationTranslate(value) {
  const slots = sharedDomCore.declarationSlots("translate", String(value));
  if (!slots?.length || slots[0].kind === 1 || slots[0].value?.x === undefined) {
    throw new TypeError(`Invalid translate value: ${String(value).trim()}`);
  }
  return {
    kind: "translate",
    x: slots[0].value.x,
    y: slots[0].value.y,
  };
}

export function canonicalizeAnimationKeyframes(keyframes) {
  if (!Array.isArray(keyframes)) {
    throw new TypeError("keyframes must be an array");
  }
  return keyframes.map((frame) => {
    const canonical = {};
    for (const [name, value] of Object.entries(frame)) {
      if (name === "offset" || name === "composite") {
        canonical[name] = value;
        continue;
      }
      if (name === "easing") {
        canonical.easing = typeof value === "string"
          ? parseCSSEasing(value)
          : structuredClone(value);
        continue;
      }
      if (name === "transform") {
        canonical.transform = {
          kind: "transform",
          components: sharedDomCore.transformComponents(value),
        };
        continue;
      }
      const property = animationProperty(name);
      if (!property) {
        throw new TypeError(`Property is not animation-enabled: ${name}`);
      }
      const cssName = property.name;
      if (property.id === 12) {
        canonical[cssName] = { kind: "scalar", value: Number(value) };
      } else if (property.id === 13) {
        const color = parseColor(value);
        canonical[cssName] = {
          kind: "color",
          value: [color.r, color.g, color.b, color.a],
        };
      } else if (property.id === 14) {
        canonical[cssName] = { kind: "keyword", keyword: String(value) };
      } else if (property.id === 25) {
        canonical[cssName] = animationLineHeight(value);
      } else if (property.id === 26) {
        canonical[cssName] = parseAnimationTranslate(value);
      } else {
        canonical[cssName] = parseAnimationLength(value);
      }
    }
    return canonical;
  });
}

export function supportsStyleProperty(name) {
  return sharedDomCore.styleSupports(cssPropertyToIDLName(name));
}

function animationBaseValue(property, value) {
  if (property === "transform") {
    return {
      kind: "transform",
      components: sharedDomCore.transformComponents(value),
    };
  }
  if (property === "translate") return parseAnimationTranslate(value);
  if (property === "opacity") return { kind: "scalar", value: Number(value) };
  if (property === "backgroundColor") {
    const color = parseColor(value);
    return { kind: "color", value: [color.r, color.g, color.b, color.a] };
  }
  if (property === "visibility") return { kind: "keyword", keyword: value };
  if (property === "lineHeight" || property === "line-height") return animationLineHeight(value);
  return parseAnimationLength(value);
}

const styleInstances = new WeakSet();

export function isStyleDeclaration(value) {
  return styleInstances.has(value);
}

class SDStyleRuntime {
  constructor(element) {
    this._element = element;
    this._mutationOldValue = null;
  }

  _getDiagnostics() {
    return this._element._domCore.styleDiagnostics(this._element._coreHandle);
  }
  _getLength() {
    return this._element._domCore.styleCount(this._element._coreHandle);
  }
  _item(index) {
    return this._element._domCore.styleCSSNameAt(
      this._element._coreHandle,
      index,
    ) ?? "";
  }
  [Symbol.iterator]() {
    return Array.from({ length: this.length }, (_, index) => this.item(index))
      [Symbol.iterator]();
  }
  _getCSSText() {
    return this._element._domCore.styleText(this._element._coreHandle);
  }
  _replaceText(source) {
    this._element._domCore.styleReplace(
      this._element._coreHandle,
      source,
      false,
      this._element.ownerDocument?._sandomFontRegistry ?? undefined,
    );
    this._deliverMutation();
  }
  _parseAttribute(source) {
    this._element._assertMutationAllowed();
    this._element._parsingStyleAttribute = true;
    try {
      this._element._domCore.styleReplace(
        this._element._coreHandle,
        source,
        true,
        this._element.ownerDocument?._sandomFontRegistry ?? undefined,
      );
      this._element._domCore.callbackRecords();
      this._element._notifyMutation("style");
    } finally {
      this._element._parsingStyleAttribute = false;
    }
  }
  _deliverMutation(property) {
    const core = this._element._domCore;
    const hadAttribute = core.exports.style_mutation_had_attribute() !== 0;
    const record = core.callbackRecords().find((entry) => entry.kind === 2);
    this._mutationOldValue = hadAttribute ? record?.oldValue ?? "" : null;
    this._element._notifyMutation("style", property);
  }
  _set(name, value, priority, mode) {
    const changed = this._element._domCore.styleSet(
      this._element._coreHandle,
      name,
      value,
      priority,
      mode,
      this._element.ownerDocument?._sandomFontRegistry ?? undefined,
    );
    if (!changed) return;
    if (changed === 3) {
      this._element._domCore.callbackRecords();
      return;
    }
    this._deliverMutation(name);
    const animatedProperty = changed === 1 && this._element._renderSurface
      ? animationProperty(name) : null;
    if (animatedProperty) {
      this._element._renderSurface._broadcastReplaceAnimationBase(
        this._element,
        animatedProperty.name,
        animationBaseValue(name, this.getPropertyValue(name)),
      );
    }
  }
  _assertMutation() {
    this._element._assertMutationAllowed();
  }
  _invalidPriority(priority) {
    return !this._element._domCore.stylePriorityValid(priority);
  }
  _methodName(name) {
    return this._element._domCore.styleMethodName(name);
  }
  _unsupportedName(property) {
    return !this._element._domCore.styleSupports(property);
  }
  _setPropertyNormalized(property, value, priority) {
    this._set(property, value, priority, 1);
  }
  _getPropertyValue(property) {
    return this._element._domCore.styleRead(
      this._element._coreHandle,
      property,
    ) ?? "";
  }
  _getPropertyPriority(property) {
    return this._element._domCore.stylePriority(
      this._element._coreHandle,
      property,
    );
  }
  _removeProperty(property) {
    const previous = this._element._domCore.styleRemove(
      this._element._coreHandle,
      property,
    );
    if (previous !== "") this._deliverMutation(property);
    else {
      // The attribute operation still owns its record lifetime when removing
      // an absent/empty declaration does not notify style consumers.
      this._element._domCore.callbackRecords();
    }
    return previous;
  }
}

const SDStyle = createInlineStyleClass({ Base: SDStyleRuntime });

export function createStyle(element) {
  const style = new SDStyle(element);
  const proxy = new Proxy(style, {
    get(target, prop) {
      if (typeof prop === "string" && /^(0|[1-9]\d*)$/.test(prop)) {
        const index = Number(prop);
        return index < target.length ? target.item(index) : undefined;
      }
      if (prop in target || typeof prop !== "string") return target[prop];
      if (!supportsStyleProperty(prop) || prop.startsWith("--")) {
        return undefined;
      }
      return target.getPropertyValue(idlPropertyToCSSName(prop));
    },
    set(target, prop, value) {
      if (typeof prop !== "string") return false;
      if (/^(0|[1-9]\d*)$/.test(prop)) return true;
      // Internal SDStyle state and real class members bypass CSS property
      // assignment. The proxy must not interpret them as authored properties.
      if (prop in target) {
        target[prop] = value;
        return true;
      }
      target._element._assertMutationAllowed();
      // Custom-property parity (see class doc above): plain assignment on
      // a dash-prefixed name is a silent no-op, exactly like a real
      // CSSStyleDeclaration — only setProperty (above) actually sets one.
      if (prop.startsWith("--")) return true;
      const property = cssPropertyToIDLName(prop);
      if (target._unsupportedName(property)) return true;
      if (value === "") {
        target.removeProperty(prop);
        return true;
      }
      // Keep the core's strict check for engine callers. Only the CSSOM named
      // property setter turns an unknown authored property into a no-op.
      target._element._domCore.styleCheckName(property);
      target._set(property, String(value), "", 0);
      return true;
    },
    has(target, prop) {
      if (typeof prop === "string" && /^(0|[1-9]\d*)$/.test(prop)) {
        return Number(prop) < target.length;
      }
      return prop in target;
    },
    ownKeys(target) {
      return [
        ...Array.from({ length: target.length }, (_, index) => String(index)),
        ...Reflect.ownKeys(target),
      ];
    },
    getOwnPropertyDescriptor(target, prop) {
      if (
        typeof prop === "string" &&
        /^(0|[1-9]\d*)$/.test(prop) &&
        Number(prop) < target.length
      ) {
        return {
          configurable: true,
          enumerable: true,
          writable: false,
          value: target.item(Number(prop)),
        };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
  styleInstances.add(proxy);
  return proxy;
}
