const FRAME_FIELDS = new Set([
  "pixels",
  "png",
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
  "dirtyRectangles",
  "readbackByteLength",
  "frameSequence",
  "scrollbars",
  "timeMilliseconds",
  "inspection",
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
  "colors",
  "role",
  "clip",
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
    colors: scrollbar.colors,
    role: scrollbar.role,
    clip: scrollbar.clip ?? null,
  };
}

export function componentAdapterFrameRecord(frame) {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
    throw new TypeError("Component frame must be an object");
  }
  rejectUnknownFields(frame, FRAME_FIELDS, "Component frame");
  const {
    pixels,
    png,
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
    dirtyRectangles,
    readbackByteLength,
    frameSequence,
    scrollbars,
    timeMilliseconds,
  } = frame;
  if (!ArrayBuffer.isView(pixels) || pixels instanceof DataView) {
    throw new TypeError("Component frame pixels must be a typed array");
  }
  if (png !== null && png !== undefined && !(png instanceof Uint8Array)) {
    throw new TypeError("Component frame PNG must be a Uint8Array, null, or absent");
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
      dirtyRectangles,
      readbackByteLength,
      frameSequence,
      scrollbars: scrollbars.map((scrollbar) =>
        scrollbarRecord(scrollbar, inspection)
      ),
      timeMilliseconds,
      pixelsPresent: true,
      pixelsType: pixels.constructor.name,
      pngPresent: png instanceof Uint8Array,
      ...(inspection
        ? { inspection: componentAdapterInspectionRecord(inspection) }
        : {}),
    },
    binary: new Map([
      [
        "pixels",
        new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength),
      ],
      ...(png instanceof Uint8Array
        ? [["png", new Uint8Array(png.buffer, png.byteOffset, png.byteLength)]]
        : []),
    ]),
  };
}
