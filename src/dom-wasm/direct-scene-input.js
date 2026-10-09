// The one upload of authored Scene values. This format contains no engine
// offsets, enums, records, pools, defaults, or normalized CSS values. Native
// direct-input.watpart owns interpretation and publication.
const utf8 = new TextEncoder();
const hashName = (name) => {
  let hash = 0x811c9dc5;
  for (const byte of utf8.encode(name)) hash = Math.imul(hash ^ byte, 16777619);
  return hash >>> 0;
};

export function publishDirectSceneInput(core, nodes, imagePixelsFor, patchIndex = null) {
  if (patchIndex === null && isDomBackedScene(nodes)) {
    return publishDomBackedScene(core, nodes);
  }
  const values = [];
  const strings = [];
  const stringOffsets = new Map();
  let stringBytes = 0;
  const string = (text) => {
    let encoded = stringOffsets.get(text);
    if (encoded) return encoded;
    const bytes = utf8.encode(text);
    encoded = { offset: stringBytes, length: bytes.length };
    strings.push(bytes);
    stringBytes += bytes.length;
    stringOffsets.set(text, encoded);
    return encoded;
  };
  const active = new Set();
  const encode = (value, at, key = "", sceneNode = false) => {
    const entry = { key: string(key), name: key, hash: key ? directSceneFields.get(key) : 0, kind: 0 };
    values[at] = entry;
    if (value == null) return;
    if (typeof value === "number" || typeof value === "boolean") {
      entry.kind = typeof value === "number" ? 1 : 3;
      entry.number = Number(value);
      return;
    }
    if (typeof value === "string") {
      entry.kind = 2;
      entry.string = string(value);
      entry.text = value;
      return;
    }
    if (typeof value !== "object") {
      throw new TypeError(`Unsupported authored Scene value for ${key}`);
    }
    entry.authored = value;
    if (active.has(value)) throw new TypeError("Cyclic authored Scene value");
    active.add(value);
    try {
      if (sceneNode && value._coreBox !== undefined) {
        if (value._corePublication?.core !== core) {
          throw new TypeError("DOM-backed scene belongs to another renderer core");
        }
        const authored = {
          _nativePublication: value._corePublication.handle,
          _nativePublicationIndex: value._corePublicationIndex,
          _inspectionSourceNodeIndex: value._inspectionSourceNodeIndex,
          sourceRevision: value.sourceRevision,
          children: value.children,
          scrollLeft: value.scrollLeft,
          scrollTop: value.scrollTop,
        };
        if (Object.hasOwn(value, "_coreTransformOverride")) {
          authored._nativeTransformOverride = true;
          authored.transform = value._coreTransformOverride;
          authored.transformOrigin = value.transformOrigin;
        }
        // An inline SVG shape's fill and stroke paint servers, resolved by
        // the renderer against the shape's bounding box, paint over the
        // native row.
        if (value.svgFillGradient !== undefined) {
          authored.svgFillGradient = value.svgFillGradient;
        }
        if (value.svgStrokeGradient !== undefined) {
          authored.svgStrokeGradient = value.svgStrokeGradient;
        }
        active.delete(value);
        encode(authored, at, key);
        return;
      }
      const array = Array.isArray(value);
      entry.kind = array ? 5 : 4;
      const keys = array ? Array.from(value.keys()) : Object.keys(value);
      // Ignore resource objects and unrelated application data. Native lookup
      // also checks exact UTF-8 spelling, not a hash alone.
      const fields = array ? keys : keys.filter((name) => directSceneFields.has(name));
      if (sceneNode && value._corePublication && value._coreBox === undefined) {
        if (value._corePublication.core !== core) {
          throw new TypeError("DOM-backed text belongs to another renderer core");
        }
        const textIndex = fields.indexOf("text");
        if (textIndex !== -1) fields.splice(textIndex, 1);
        fields.push("_nativeTextPublication", "_nativePublicationIndex");
      }
      if (sceneNode && value.resolvedBorderImage && !fields.includes("borderImage")) {
        fields.push("borderImage");
      }
      entry.first = values.length;
      entry.count = fields.length;
      values.length += fields.length;
      for (let index = 0; index < fields.length; index++) {
        const field = fields[index];
        let child = value[field];
        if (sceneNode && field === "_nativeTextPublication") {
          child = value._corePublication.handle;
        } else if (sceneNode && field === "_nativePublicationIndex") {
          child = value._corePublicationIndex;
        }
        if (sceneNode && field === "borderImage") {
          child = value.resolvedBorderImage ?? child;
          if (child?.imageIndex !== undefined) {
            const source = imagePixelsFor(child.imageIndex);
            child = {
              ...child,
              sourceWidth: source?.width,
              sourceHeight: source?.height,
            };
          }
        }
        encode(child, entry.first + index, array ? "" : field,
          array && value === nodes);
      }
    } finally {
      active.delete(value);
    }
  };
  values.length = 1;
  encode(patchIndex === null ? nodes : nodes[0], 0, "", patchIndex !== null);
  const stringBase = 16 + values.length * 32;
  const length = stringBase + stringBytes;
  const pointer = core.status("engine_direct_input_allocate", length);
  if (!pointer) core.throwIfError();
  const bytes = core.refreshBytes();
  const view = new DataView(bytes.buffer);
  bytes.fill(0, pointer, pointer + length);
  view.setUint32(pointer, 0x53434e31, true);
  view.setUint32(pointer + 4, values.length, true);
  view.setUint32(pointer + 8, stringBytes, true);
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    const at = pointer + 16 + index * 32;
    view.setUint32(at, value.hash, true);
    view.setUint32(at + 4, value.kind, true);
    view.setUint32(at + 24, pointer + stringBase + value.key.offset, true);
    view.setUint32(at + 28, value.key.length, true);
    if (value.kind === 1 || value.kind === 3) {
      view.setFloat64(at + 16, value.number, true);
    } else if (value.kind === 2) {
      view.setUint32(at + 8, pointer + stringBase + value.string.offset, true);
      view.setUint32(at + 12, value.string.length, true);
    } else if (value.kind === 4 || value.kind === 5) {
      view.setUint32(at + 8, pointer + 16 + value.first * 32, true);
      view.setUint32(at + 12, value.count, true);
    }
  }
  let cursor = pointer + stringBase;
  for (const text of strings) {
    bytes.set(text, cursor);
    cursor += text.length;
  }
  // The native operation adopts the allocation, including on failure. Full
  // publication replaces the previous owned input; sparse patches replace only
  // their node's owned input. No JavaScript snapshot authority remains.
  try {
    return core.status("engine_direct_publish", pointer, length, patchIndex ?? -1);
  } catch (error) {
    if (core.exports.abi_error_kind() !== 18) throw error;
    const rejectedPointer = core.exports.abi_error_detail_a();
    const valueIndex = (rejectedPointer - pointer - 16) / 32;
    const rejected = Number.isInteger(valueIndex) ? values[valueIndex] : undefined;
    if (!rejected) throw error;
    const authored = rejected.kind === 2 ? rejected.text
      : rejected.kind === 1 || rejected.kind === 3 ? rejected.number : rejected.authored;
    throw new Error(
      `Unsupported authored Scene value ${JSON.stringify(authored)} for ${rejected.name}` +
      ` at node ${core.exports.abi_error_detail_b()}`,
      { cause: error },
    );
  }
}

// A scene every row of which is a DOM-backed core row without a transform
// override or a paint server: the authored object per row is the same
// seven fields, so the input is written straight into the allocation — no
// per-value objects, no string table beyond the seven key names. The
// generic encoder below is the definition this must match record for
// record.
function isDomBackedScene(nodes) {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node._coreBox === undefined || Object.hasOwn(node, "_coreTransformOverride") ||
      node.svgFillGradient !== undefined || node.svgStrokeGradient !== undefined) {
      return false;
    }
  }
  return true;
}

function publishDomBackedScene(core, nodes) {
  let childCount = 0;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node._corePublication?.core !== core) {
      throw new TypeError("DOM-backed scene belongs to another renderer core");
    }
    childCount += node.children?.length ?? 0;
  }
  // Root array, one object per node, seven fields per node, one element
  // per child index.
  const valueCount = 1 + nodes.length * 8 + childCount;
  const stringBase = 16 + valueCount * 32;
  const length = stringBase + DOM_ROW_STRING_BYTES;
  const pointer = core.status("engine_direct_input_allocate", length);
  if (!pointer) core.throwIfError();
  const bytes = core.refreshBytes();
  const view = new DataView(bytes.buffer);
  bytes.fill(0, pointer, pointer + length);
  view.setUint32(pointer, 0x53434e31, true);
  view.setUint32(pointer + 4, valueCount, true);
  view.setUint32(pointer + 8, DOM_ROW_STRING_BYTES, true);
  const keyPointers = new Array(DOM_ROW_KEYS.length);
  let stringCursor = pointer + stringBase;
  for (let key = 0; key < DOM_ROW_KEYS.length; key++) {
    bytes.set(DOM_ROW_KEY_BYTES[key], stringCursor);
    keyPointers[key] = stringCursor;
    stringCursor += DOM_ROW_KEY_BYTES[key].length;
  }
  // Records without a key (the root, the child indices) name the empty
  // string at the string table's base, as the generic encoder does.
  const emptyKey = pointer + stringBase;
  const values = pointer + 16;
  // Root: kind 5 (array) of nodes.length objects starting at record 1.
  view.setUint32(values + 4, 5, true);
  view.setUint32(values + 8, values + 32, true);
  view.setUint32(values + 12, nodes.length, true);
  view.setUint32(values + 24, emptyKey, true);
  const field = (at, key, kind) => {
    view.setUint32(at, DOM_ROW_KEY_HASHES[key], true);
    view.setUint32(at + 4, kind, true);
    view.setUint32(at + 24, keyPointers[key], true);
    view.setUint32(at + 28, DOM_ROW_KEY_BYTES[key].length, true);
  };
  const number = (at, key, value) => {
    if (value == null) {
      field(at, key, 0);
      return;
    }
    field(at, key, 1);
    view.setFloat64(at + 16, Number(value), true);
  };
  let next = values + 32 * (1 + nodes.length);
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    const object = values + 32 * (1 + index);
    view.setUint32(object + 4, 4, true);
    view.setUint32(object + 8, next, true);
    view.setUint32(object + 12, DOM_ROW_KEYS.length, true);
    view.setUint32(object + 24, emptyKey, true);
    number(next, 0, node._corePublication.handle);
    number(next + 32, 1, node._corePublicationIndex);
    number(next + 64, 2, node._inspectionSourceNodeIndex);
    number(next + 96, 3, node.sourceRevision);
    const children = node.children;
    const childrenAt = next + 128;
    if (children == null) {
      field(childrenAt, 4, 0);
    } else {
      field(childrenAt, 4, 5);
      view.setUint32(childrenAt + 8, next + 32 * DOM_ROW_KEYS.length, true);
      view.setUint32(childrenAt + 12, children.length, true);
    }
    number(next + 160, 5, node.scrollLeft);
    number(next + 192, 6, node.scrollTop);
    next += 32 * DOM_ROW_KEYS.length;
    if (children != null) {
      for (let child = 0; child < children.length; child++) {
        view.setUint32(next + 4, 1, true);
        view.setFloat64(next + 16, children[child], true);
        view.setUint32(next + 24, emptyKey, true);
        next += 32;
      }
    }
  }
  return core.status("engine_direct_publish", pointer, length, -1);
}

const directSceneFields = new Map([
  "display", "layoutDisplay", "children", "width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight",
  "aspectRatio", "boxSizing", "position", "zIndex", "top", "right", "bottom", "left", "margin", "padding", "border",
  "marginTop", "marginRight", "marginBottom", "marginLeft", "borderColor", "borderStyle", "borderRadius", "outline",
  "bg", "opacity", "blendMode", "isolation", "visibility", "overflow", "overflowX", "overflowY", "overflowClipMargin",
  "visualBox", "offset", "scrollLeft", "scrollTop", "direction", "writingMode", "float", "clear", "bfc", "inlineCtx",
  "fontIndex", "fontSize", "fontWeight", "fontStyle", "color", "textAlign", "textDecoration", "textOverflow", "whiteSpace",
  "overflowWrap", "verticalAlign", "lineHeight", "letterSpacing", "flexDirection", "flexWrap", "flexGrow", "flexShrink",
  "flexBasis", "alignItems", "alignSelf", "alignContent", "justifyItems", "justifySelf", "justifyContent", "layoutAlignItems",
  "layoutJustifyContent", "gap", "rowGap", "columnGap", "columnWidth", "columnCount", "breakInside", "orphans", "widows",
  "columnRuleWidth", "columnRuleStyle", "columnRuleColor", "columnSpan", "columnFill", "gridTemplateColumns", "gridTemplateRows", "gridTemplateAreas",
  "gridAutoColumns", "gridAutoRows", "gridAutoFlow", "gridRowStart", "gridRowEnd", "gridColumnStart", "gridColumnEnd",
  "gridRow", "gridColumn", "gridArea", "tableLayout", "borderCollapse", "captionSide", "emptyCells", "colSpan", "rowSpan",
  "borderSpacing", "imageIndex", "objectFit", "objectPosition", "imageRendering", "backgroundGradient", "backgroundImages",
  "resolvedBackgroundImages", "backgroundAttachment", "backgroundClip", "backgroundOrigin", "boxShadows", "textShadows",
  "filter", "backdropFilter", "masks", "resolvedMasks", "borderImage", "clipPath", "svgFillGradient", "svgStrokeGradient", "viewBox",
  "preserveAspectRatio", "fill", "stroke", "fillOpacity", "strokeOpacity", "strokeWidth", "fillRule", "strokeLinecap",
  "strokeLinejoin", "svgTextAnchor", "svgTextX", "svgTextY", "resolvedPathIndex", "resolvedPathBbox", "resolvedStrokePathIndex",
  "resolvedStrokePathBbox", "resolvedCoordinateScale", "transform", "transformOrigin", "kind", "components", "value", "radians",
  "xRadians", "yRadians", "scale", "rotate", "translate", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry",
  "xMin", "yMin", "xMax", "yMax", "pixels", "percentage", "px", "g", "b", "a", "topLeft", "topRight", "bottomRight", "bottomLeft",
  "style", "gradient", "stops", "angle", "repeating", "shape", "size", "center", "interpolationSpace", "hueMethod", "missingComponents",
  "attachment", "repeat", "origin", "clip", "mode", "composite", "type", "amount", "dx", "dy", "sigma", "offsetX", "offsetY", "blur",
  "spread", "inset", "slice", "outset", "sourceWidth", "sourceHeight", "radius", "radii", "_nativePublication", "_nativeTransformOverride",
  "text", "sourceRevision", "_inspectionSourceNodeIndex", "_nativePublicationIndex", "_nativeTextPublication",
].map((name) => [name, hashName(name)]));

const DOM_ROW_KEYS = [
  "_nativePublication", "_nativePublicationIndex", "_inspectionSourceNodeIndex",
  "sourceRevision", "children", "scrollLeft", "scrollTop",
];
const DOM_ROW_KEY_BYTES = DOM_ROW_KEYS.map((key) => utf8.encode(key));
const DOM_ROW_KEY_HASHES = DOM_ROW_KEYS.map((key) => directSceneFields.get(key));
const DOM_ROW_STRING_BYTES = DOM_ROW_KEY_BYTES.reduce((total, bytes) => total + bytes.length, 0);
