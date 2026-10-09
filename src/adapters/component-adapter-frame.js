// Own keys of a published component-session frame (render-surface.js frame
// object plus render-component.js publication fields). The allow-list is
// exact so a new surface field is a deliberate protocol decision, not a
// silent leak across the realm boundary.
const FRAME_FIELDS = new Set([
  "pixels",
  "textureImage",
  "device",
  "rowStride",
  "channelLayout",
  "sampleType",
  "bitsPerSample",
  "colorEncoding",
  "alphaMode",
  "metadata",
  "width",
  "height",
  "deviceScale",
  "graphicsBackend",
  "graphicsBackendInfo",
  "dirtyRectangles",
  "pixelRegions",
  "readbackByteLength",
  "frameSequence",
  "scrollbars",
  "timeMilliseconds",
  "renderTimings",
  "inspection",
  "documentRevision",
  "interactionRevision",
  "presentationRevision",
  "accessibilityRevision",
  "focusIdentifier",
  "accessibility",
  "interactiveTextGeometry",
  "changedControlStates",
]);

const SCROLLBAR_FIELDS = new Set([
  "element",
  "orientation",
  "value",
  "minimum",
  "maximum",
  "range",
  "viewportLength",
  "scrollLength",
  "thickness",
  "track",
  "thumb",
  "side",
  "colors",
  "role",
  "clip",
  "visibility",
]);

function rejectUnknownFields(value, allowed, name) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`${name} contains unknown field ${String(key)}`);
    }
  }
}

function elementRecord(element) {
  if (!element) return null;
  const attributeNames = typeof element.getAttributeNames === "function"
    ? element.getAttributeNames()
    : [];
  return {
    nodeType: element.nodeType,
    nodeName: element.nodeName,
    localName: element.localName ?? null,
    id: element.id ?? "",
    className: typeof element.className === "string" ? element.className : "",
    textContent: element.textContent ?? "",
    ...(["input", "select", "textarea"].includes(element.localName)
      ? { value: element.value }
      : {}),
    attributes: attributeNames.map((name) => ({
      name,
      value: element.getAttribute(name),
    })),
  };
}

export function componentAdapterInspectionRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Component inspection must be an object");
  }
  return {
    sceneNodes: value.sceneNodes,
    layoutBoxes: value.layoutBoxes,
    paintArtifact: value.paintArtifact,
    elements: value.elementAtIndex.map(elementRecord),
  };
}

function scrollbarRecord(scrollbar, inspection) {
  rejectUnknownFields(scrollbar, SCROLLBAR_FIELDS, "Component scrollbar");
  const elementIndex = inspection?.elementAtIndex.indexOf(scrollbar.element) ?? -1;
  let owner = "element";
  if (elementIndex < 0) {
    if (scrollbar.element?.nodeType !== undefined) {
      throw new TypeError("Component scrollbar element is absent from inspection");
    }
    owner = "viewport";
  }
  return {
    owner,
    elementIndex: elementIndex < 0 ? null : elementIndex,
    orientation: scrollbar.orientation,
    value: scrollbar.value,
    minimum: scrollbar.minimum,
    maximum: scrollbar.maximum,
    range: scrollbar.range,
    viewportLength: scrollbar.viewportLength,
    scrollLength: scrollbar.scrollLength,
    thickness: scrollbar.thickness,
    track: scrollbar.track,
    thumb: scrollbar.thumb,
    side: scrollbar.side ?? null,
    colors: scrollbar.colors,
    role: scrollbar.role,
    clip: scrollbar.clip ?? null,
    visibility: scrollbar.visibility ?? null,
  };
}

// The realm protocol ships a pixel frame: the plain frame fields in the
// structured header and the pixel bytes as one byte field. Not transported:
// `textureImage` and `device` (GPU handles, null on a pixel frame),
// `pixelRegions` (per-region typed arrays; the full pixels already ship),
// and the session-only lazy getters `accessibility`,
// `interactiveTextGeometry`, and `changedControlStates` (resolved against
// the live document on demand, never as part of a frame record).
export function componentAdapterFrameRecord(frame) {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
    throw new TypeError("Component frame must be an object");
  }
  rejectUnknownFields(frame, FRAME_FIELDS, "Component frame");
  const {
    pixels,
    inspection,
    rowStride,
    channelLayout,
    sampleType,
    bitsPerSample,
    colorEncoding,
    alphaMode,
    metadata,
    width,
    height,
    deviceScale,
    graphicsBackend,
    graphicsBackendInfo,
    dirtyRectangles,
    readbackByteLength,
    frameSequence,
    scrollbars,
    timeMilliseconds,
    renderTimings,
    documentRevision,
    interactionRevision,
    presentationRevision,
    accessibilityRevision,
    focusIdentifier,
  } = frame;
  if (!ArrayBuffer.isView(pixels) || pixels instanceof DataView) {
    throw new TypeError("Component frame pixels must be a typed array");
  }
  if (!Array.isArray(scrollbars)) {
    throw new TypeError("Component frame scrollbars must be an array");
  }
  return {
    value: {
      rowStride,
      channelLayout,
      sampleType,
      bitsPerSample,
      colorEncoding,
      alphaMode,
      metadata,
      width,
      height,
      deviceScale,
      graphicsBackend,
      graphicsBackendInfo,
      dirtyRectangles,
      readbackByteLength,
      frameSequence,
      scrollbars: scrollbars.map((scrollbar) =>
        scrollbarRecord(scrollbar, inspection)
      ),
      timeMilliseconds,
      renderTimings,
      documentRevision,
      interactionRevision,
      presentationRevision,
      accessibilityRevision,
      focusIdentifier,
      pixelsPresent: true,
      pixelsType: pixels.constructor.name,
      ...(inspection
        ? { inspection: componentAdapterInspectionRecord(inspection) }
        : {}),
    },
    binary: new Map([
      [
        "pixels",
        new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength),
      ],
    ]),
  };
}
