import { readBinaryFile } from "../host.js";
import { createGifRecorder } from "../output/gif.js";
import { encodeImage, validateOutputRequest } from "../output/image.js";
import { generateAdaptiveImage } from "../output/gain-map.js";
import { encodeGainMapJpegPackage } from "../output/jpeg-gain-map.js";
import {
  createModuleExecutor,
  createPreprocessorRegistry,
  selectPreprocessor,
} from "./input-preprocessors.js";
import { createRenderSurface } from "./render-surface.js";
import { SDDocument } from "./node.js";
import { serializeToScene } from "./serialize.js";
import { resolvedElementFields } from "./style.js";
import { createLayoutArtifact } from "../scene-renderer.js";
import { DocumentSession } from "./document-session.js";
import { createPreparedDocument } from "./prepared-document.js";

const REC2100_PQ_OUTPUT_ENCODING = Object.freeze({
  primaries: "rec2020",
  transferFunction: "pq",
  transferFunctionParameters: null,
  whitePoint: "d65",
  referenceWhiteLuminance: 203,
  profile: null,
});

const JPEG_XL_OUTPUT_REQUEST = Object.freeze({
  format: "jpeg-xl",
  colorEncoding: REC2100_PQ_OUTPUT_ENCODING,
  dynamicRange: "high",
  bitDepth: "float16",
  masteringDisplay: Object.freeze({
    maxLuminance: 1000,
    minLuminance: 0.005,
  }),
});

const ADAPTIVE_OUTPUT_REQUEST = Object.freeze({
  format: "jpeg-gain-map",
  colorEncoding: Object.freeze({
    primaries: "srgb",
    transferFunction: "srgb",
    transferFunctionParameters: null,
    whitePoint: "d65",
    referenceWhiteLuminance: 203,
    profile: null,
  }),
  dynamicRange: "adaptive",
  bitDepth: 8,
  alphaMode: "straight",
  toneMap: "bt2390",
  targetPeakLuminance: 203,
  masteringDisplay: Object.freeze({
    maxLuminance: 1000,
    minLuminance: 0.005,
  }),
});

async function digest(bytes) {
  const digestBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes),
  );
  return `sha256:${
    Array.from(digestBytes, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    )
  }`;
}
const preparedInputStates = new WeakMap();

function preparedInputState(preparedInput) {
  const state = preparedInputStates.get(preparedInput);
  if (!state) {
    throw new TypeError("operation requires a prepared render input");
  }
  if (state.released) {
    throw new Error("prepared render input has been released");
  }
  if (state.active) {
    throw new Error("prepared render input already has an active operation");
  }
  return state;
}

async function performPreparedOperation(preparedInput, operation) {
  const state = preparedInputState(preparedInput);
  state.active = true;
  try {
    return await operation(state);
  } finally {
    state.active = false;
  }
}

function frameMetadata(frame) {
  return Object.freeze({
    sequence: frame.sequence ?? frame.frameSequence - 1,
    timeMilliseconds: frame.timeMilliseconds,
    durationMilliseconds: frame.durationMilliseconds ?? 0,
    dirtyRectangles: frame.dirtyRectangles,
    readbackByteLength: frame.readbackByteLength,
  });
}

export async function renderDocumentAnimation(document, options = {}) {
  const {
    format = "gif",
    width = 1280,
    height = 720,
    deviceScale = 1,
    frameBudget,
    durationMilliseconds,
    loopCount = 0,
    resolveResource = null,
    adaptiveCodecOptions = {},
    graphicsBackend = "auto",
  } = options;
  if (!["gif", "png", "jpeg-xl", "jpeg-gain-map"].includes(format)) {
    throw new RangeError(`Unsupported render format ${JSON.stringify(format)}`);
  }
  if (
    !Number.isFinite(width) || width <= 0 || !Number.isFinite(height) ||
    height <= 0
  ) {
    throw new RangeError("width and height must be positive numbers");
  }
  if (!Number.isFinite(deviceScale) || deviceScale <= 0) {
    throw new RangeError("deviceScale must be a positive number");
  }
  if (format === "gif" && (!Number.isInteger(frameBudget) || frameBudget < 1)) {
    throw new RangeError("frameBudget must be a positive integer");
  }
  if (!(document instanceof SDDocument)) {
    throw new TypeError("renderDocumentAnimation requires an SDDocument");
  }
  if (!document.documentElement) {
    throw new Error("The preprocessor did not populate a document element");
  }

  const highDynamicRangeStillOutput = format === "jpeg-xl" ||
    format === "jpeg-gain-map";
  await document._readyForRendering();
  const surface = createRenderSurface(document.documentElement, {
    viewportWidth: width,
    viewportHeight: height,
    deviceScale,
    resolveResource,
    encodePixels: highDynamicRangeStillOutput ? null : undefined,
    renderMode: highDynamicRangeStillOutput ? "high-dynamic-range" : undefined,
    renderPrecision: highDynamicRangeStillOutput ? "rgba16float" : undefined,
    graphicsBackend,
  });
  try {
    const initialFrame = await surface.renderNow();
    surface.stop();
    if (format !== "gif") {
      const frame = frameMetadata(initialFrame);
      const descriptor = {
        pixels: initialFrame.pixels,
        width: initialFrame.width,
        height: initialFrame.height,
        rowStride: initialFrame.rowStride,
        channelLayout: initialFrame.channelLayout,
        sampleType: initialFrame.sampleType,
        bitsPerSample: initialFrame.bitsPerSample,
        colorEncoding: initialFrame.colorEncoding,
        alphaMode: initialFrame.alphaMode,
        metadata: initialFrame.metadata,
      };
      let bytes;
      let outputFacts;
      if (format === "png") {
        bytes = await initialFrame.png;
      } else if (format === "jpeg-xl") {
        bytes = await encodeImage(descriptor, JPEG_XL_OUTPUT_REQUEST, {
          renderPrecision: "rgba16float",
        });
      } else {
        const request = validateOutputRequest({
          ...ADAPTIVE_OUTPUT_REQUEST,
          codecOptions: adaptiveCodecOptions,
        }, { renderPrecision: "rgba16float" });
        const encoded = await encodeGainMapJpegPackage(
          generateAdaptiveImage(descriptor, request),
        );
        bytes = encoded.bytes;
        outputFacts = encoded.facts;
      }
      return Object.freeze({
        bytes,
        ...(format === "png" ? { png: bytes } : {}),
        ...(outputFacts === undefined ? {} : { outputFacts }),
        pixels: new Float32Array(initialFrame.pixels),
        rowStride: initialFrame.rowStride,
        channelLayout: initialFrame.channelLayout,
        sampleType: initialFrame.sampleType,
        bitsPerSample: initialFrame.bitsPerSample,
        colorEncoding: initialFrame.colorEncoding,
        alphaMode: initialFrame.alphaMode,
        metadata: initialFrame.metadata,
        format,
        width: initialFrame.width,
        height: initialFrame.height,
        deviceScale: initialFrame.deviceScale,
        graphicsBackend: initialFrame.graphicsBackend,
        graphicsBackendInfo: initialFrame.graphicsBackendInfo,
        dirtyRectangles: initialFrame.dirtyRectangles,
        readbackByteLength: initialFrame.readbackByteLength,
        frameSequence: initialFrame.frameSequence,
        scrollbars: initialFrame.scrollbars,
        timeMilliseconds: initialFrame.timeMilliseconds,
        durationMilliseconds: 0,
        frameCount: 1,
        frames: Object.freeze([frame]),
      });
    }

    const recorder = createGifRecorder({
      width: Math.ceil(width * deviceScale),
      height: Math.ceil(height * deviceScale),
      loopCount,
    });
    const frames = [];
    for await (
      const frame of surface.captureFrames({
        frameBudget,
        durationMilliseconds,
      })
    ) {
      recorder.addFrame({
        pixels: frame.pixels,
        candidateRectangles: frame.dirtyRectangles,
        durationMilliseconds: frame.durationMilliseconds,
      });
      frames.push(frameMetadata(frame));
    }
    const bytes = recorder.finish();
    return Object.freeze({
      bytes,
      format: "gif",
      width: Math.ceil(width * deviceScale),
      height: Math.ceil(height * deviceScale),
      graphicsBackend: initialFrame.graphicsBackend,
      graphicsBackendInfo: initialFrame.graphicsBackendInfo,
      durationMilliseconds: durationMilliseconds ??
        frames.reduce(
          (total, frame) => total + frame.durationMilliseconds,
          0,
        ),
      frameCount: frames.length,
      fullReadbackByteLength: initialFrame.readbackByteLength,
      frames: Object.freeze(frames),
    });
  } finally {
    await surface.shutdown();
  }
}

export async function prepareRenderInput(input, options = {}) {
  let inputURL;
  let inputBytes;
  if (input instanceof URL || typeof input === "string") {
    inputURL = input instanceof URL ? new URL(input.href) : new URL(input);
    inputBytes = await readBinaryFile(inputURL);
  } else if (input && typeof input === "object" && !Array.isArray(input)) {
    inputURL = input.url instanceof URL
      ? new URL(input.url.href)
      : new URL(input.url);
    inputBytes = input.bytes === undefined
      ? await readBinaryFile(inputURL)
      : input.bytes;
  } else {
    throw new TypeError(
      "input must be a URL, absolute URL string, or { url, bytes } object",
    );
  }
  if (!(inputBytes instanceof Uint8Array)) {
    throw new TypeError("input.bytes must be a Uint8Array");
  }

  const {
    preprocessors = [],
    preprocessor: explicitPreprocessor,
    resolveResource: callerResolveResource = null,
  } = options;
  const registry = createPreprocessorRegistry(preprocessors);
  const selectedPreprocessor = selectPreprocessor(
    registry,
    inputURL,
    explicitPreprocessor,
  );
  const preparedDocument = await createPreparedDocument({
    url: inputURL,
    resolveResource: callerResolveResource,
  });
  const {
    document,
    window,
    resolveResource,
  } = preparedDocument;
  const normalizedInput = Object.freeze({ url: inputURL, bytes: inputBytes });
  let inputRecord;
  try {
    const preparationResult = await selectedPreprocessor.prepare(Object.freeze({
      input: normalizedInput,
      document,
      window,
      executeModule: createModuleExecutor(window),
      resolveResource,
    }));
    if (preparationResult !== undefined) {
      throw new TypeError(
        `Preprocessor ${
          JSON.stringify(selectedPreprocessor.name)
        } must not return a value`,
      );
    }
    await document._readyForRendering();
    inputRecord = Object.freeze({
      url: inputURL.href,
      finalURL: inputURL.href,
      byteLength: inputBytes.byteLength,
      digest: await digest(inputBytes),
      preprocessor: selectedPreprocessor.name,
    });
  } catch (preparationError) {
    try {
      await preparedDocument.release();
    } catch (cleanupError) {
      throw new AggregateError(
        [
          preparationError,
          ...(cleanupError instanceof AggregateError
            ? cleanupError.errors
            : [cleanupError]),
        ],
        "Prepared input setup and resource release failed",
      );
    }
    throw preparationError;
  }

  const state = {
    active: false,
    released: false,
    resolveResource,
    preparedDocument,
    resourceRecords: () => preparedDocument.resources,
    diagnosticRecords: () => preparedDocument.diagnostics,
  };
  const preparedInput = Object.freeze({
    document,
    input: inputRecord,
    get resources() {
      return preparedDocument.resources;
    },
    get diagnostics() {
      return preparedDocument.diagnostics;
    },
    async release() {
      if (state.released) return;
      if (state.active) {
        throw new Error(
          "cannot release a prepared render input during an active operation",
        );
      }
      state.released = true;
      await state.preparedDocument.release();
    },
  });
  preparedInputStates.set(preparedInput, state);
  return preparedInput;
}

function renderRequestFromPlan(plan) {
  if (plan.version !== 1) {
    throw new RangeError(`Unsupported render plan version ${plan.version}`);
  }
  const format = plan.output?.format;
  const width = plan.viewport?.width;
  const height = plan.viewport?.height;
  const deviceScale = plan.viewport?.deviceScale;
  const graphicsBackend = plan.graphicsBackend ?? "auto";
  if (!["auto", "webgpu", "webgl2"].includes(graphicsBackend)) {
    throw new RangeError("render plan graphics backend is unsupported");
  }
  if (!["png", "gif", "jpeg-xl", "jpeg-gain-map"].includes(format)) {
    throw new RangeError("render plan output format is unsupported");
  }
  if (
    ![width, height, deviceScale].every((value) =>
      Number.isFinite(value) && value > 0
    )
  ) {
    throw new RangeError(
      "render plan viewport width, height, and deviceScale must be positive",
    );
  }
  if (format !== "gif") {
    if (plan.capture?.kind !== "still") {
      throw new RangeError("non-GIF render plans must describe still capture");
    }
    return {
      format,
      width,
      height,
      deviceScale,
      graphicsBackend,
      ...(format === "jpeg-gain-map"
        ? { adaptiveCodecOptions: plan.output.codecOptions ?? {} }
        : {}),
    };
  }
  const durationMilliseconds = plan.capture?.durationMilliseconds;
  const frameBudget = plan.capture?.sampling?.recommendedFrameBudget;
  if (!(Number.isFinite(durationMilliseconds) && durationMilliseconds > 0)) {
    throw new RangeError(
      "animated render plan durationMilliseconds must be positive",
    );
  }
  if (!(Number.isInteger(frameBudget) && frameBudget > 0)) {
    throw new RangeError(
      "animated render plan recommendedFrameBudget must be a positive integer",
    );
  }
  const repetition = plan.capture?.repetition;
  const loopCount = repetition?.kind === "infinite"
    ? 0
    : repetition?.kind === "count" && Number.isInteger(repetition.count) &&
        repetition.count > 0
    ? repetition.count
    : null;
  if (loopCount === null) {
    throw new RangeError("animated render plan repetition is invalid");
  }
  return {
    format,
    width,
    height,
    deviceScale,
    graphicsBackend,
    durationMilliseconds,
    frameBudget,
    loopCount,
  };
}

export async function renderPreparedInput(preparedInput, renderRequest = {}) {
  const plan = renderRequest?.kind === "render-plan" ? renderRequest : null;
  const exactRequest = plan === null
    ? renderRequest
    : renderRequestFromPlan(plan);
  return await performPreparedOperation(preparedInput, async (state) => {
    const rendered = await renderDocumentAnimation(
      preparedInput.document,
      {
        ...exactRequest,
        resolveResource: state.resolveResource,
      },
    );
    return Object.freeze({
      ...rendered,
      ...(plan === null ? {} : { plan }),
      input: preparedInput.input,
      resources: state.resourceRecords(),
      diagnostics: state.diagnosticRecords(),
    });
  });
}

export async function startPreparedRenderSurface(preparedInput, options = {}) {
  const state = preparedInputState(preparedInput);
  state.active = true;
  let surface;
  try {
    surface = createRenderSurface(preparedInput.document.documentElement, {
      ...options,
      resolveResource: state.resolveResource,
    });
    await surface.renderNow();
    surface.start();
  } catch (error) {
    if (surface) await surface.shutdown();
    state.active = false;
    throw error;
  }
  let released = false;
  return Object.freeze({
    surface,
    async release() {
      if (released) return;
      released = true;
      try {
        await surface.shutdown();
      } finally {
        state.active = false;
      }
    },
  });
}

export async function renderAnimationInput(input, options = {}) {
  const {
    preprocessors = [],
    preprocessor,
    resolveResource = null,
    ...renderRequest
  } = options;
  const preparedInput = await prepareRenderInput(input, {
    preprocessors,
    preprocessor,
    resolveResource,
  });
  const session = new DocumentSession(preparedInput);
  try {
    return await session.renderOnce(renderRequest);
  } finally {
    await session.dispose();
  }
}

// The inspected style facts of a scene node: a declared pixel size and
// whether it paints a background. A DOM-backed box answers from its
// resolved fields (its scene node carries no style); a scene-written node
// from its own fields.
function inspectedStyle(sceneNode, element) {
  if (sceneNode._coreBox !== undefined && element !== null) {
    const fields = resolvedElementFields(element);
    return {
      hasBackground: fields.bg !== undefined ||
        fields.backgroundImages?.length > 0,
      declaredWidth: Number.isFinite(fields.width) ? fields.width : null,
      declaredHeight: Number.isFinite(fields.height) ? fields.height : null,
    };
  }
  return {
    hasBackground: sceneNode.bg !== undefined ||
      sceneNode.backgroundImages?.length > 0,
    declaredWidth: Number.isFinite(sceneNode.width) ? sceneNode.width : null,
    declaredHeight: Number.isFinite(sceneNode.height)
      ? sceneNode.height
      : null,
  };
}

function immutableLayoutFacts(
  document,
  viewport,
  serialized,
  artifact,
) {
  const elementsBySceneIndex = new Map();
  for (const [element, sceneIndex] of serialized.indexOf) {
    if (sceneIndex !== null) elementsBySceneIndex.set(sceneIndex, element);
  }
  const parentIndexBySceneIndex = new Map();
  for (
    let parentIndex = 0;
    parentIndex < serialized.nodes.length;
    parentIndex++
  ) {
    for (const childIndex of serialized.nodes[parentIndex].children ?? []) {
      parentIndexBySceneIndex.set(childIndex, parentIndex);
    }
  }
  const core = document._domCore;
  const styles = new Array(serialized.nodes.length);
  const documentElement = document.documentElement;
  const documentBody = document.body;
  const inspection = core.status(
    "frame_inspection_begin", serialized.nodes.length, viewport.width, viewport.height,
  );
  try {
  const input = core.status("frame_inspection_input", inspection);
  let view = new DataView(core.refreshBytes().buffer);
  for (let index = 0; index < serialized.nodes.length; index++) {
    const sceneNode = serialized.nodes[index];
    const element = elementsBySceneIndex.get(index) ?? null;
    const style = styles[index] = inspectedStyle(sceneNode, element);
    const box = artifact.boxes[index];
    const at = input + index * 96;
    const flags =
      (sceneNode.display === "svg" ? 1 : 0) |
      (sceneNode.src ? 2 : 0) |
      (style.hasBackground ? 4 : 0) |
      (element === documentElement || element === documentBody ? 8 : 0) |
      (element?.nodeName?.toLowerCase() === "svg" ? 16 : 0);
    if (view.buffer !== core.memory.buffer) view = new DataView(core.refreshBytes().buffer);
    view.setInt32(at, parentIndexBySceneIndex.get(index) ?? -1, true);
    view.setUint32(at + 4, flags, true);
    view.setFloat64(at + 8, style.declaredWidth ?? NaN, true);
    view.setFloat64(at + 16, style.declaredHeight ?? NaN, true);
    view.setFloat64(at + 24, box?.borderBox.x ?? 0, true);
    view.setFloat64(at + 32, box?.borderBox.y ?? 0, true);
    view.setFloat64(at + 40, box?.borderBox.width ?? 0, true);
    view.setFloat64(at + 48, box?.borderBox.height ?? 0, true);
    view.setFloat64(at + 56, box?.scroll.width ?? 0, true);
    view.setFloat64(at + 64, box?.scroll.height ?? 0, true);
    view.setFloat64(at + 72, box?.contentBox.width ?? 0, true);
    view.setFloat64(at + 80, box?.contentBox.height ?? 0, true);
  }
  globalThis[Symbol.for("sandom.domCore.measurement")]?.record({
    category: "geometry", operation: "frame_inspection_input",
    direction: "host-to-core", bytes: serialized.nodes.length * 88,
  });
  core.status("frame_inspection_resolve", inspection);
  const aggregate = core.exports.abi_output_pointer();
  view = new DataView(core.refreshBytes().buffer);
  const scrollWidth = view.getFloat64(aggregate, true);
  const scrollHeight = view.getFloat64(aggregate + 8, true);
  const overflowLeft = view.getFloat64(aggregate + 16, true);
  const overflowTop = view.getFloat64(aggregate + 24, true);
  const overflowRight = view.getFloat64(aggregate + 32, true);
  const overflowBottom = view.getFloat64(aggregate + 40, true);
  const nodes = serialized.nodes.map((sceneNode, sceneIndex) => {
    const element = elementsBySceneIndex.get(sceneIndex) ?? null;
    const box = artifact.boxes[sceneIndex];
    if (view.buffer !== core.memory.buffer) view = new DataView(core.refreshBytes().buffer);
    const flags = view.getUint32(input + sceneIndex * 96 + 88, true);
    const nodeScrollWidth = view.getFloat64(input + sceneIndex * 96 + 56, true);
    const nodeScrollHeight = view.getFloat64(input + sceneIndex * 96 + 64, true);
    const participatesInLayout = (flags & 1) !== 0;
    const style = styles[sceneIndex];
    return Object.freeze({
      nodeIndex: sceneIndex,
      parentIndex: parentIndexBySceneIndex.get(sceneIndex) ?? null,
      nodeName: element?.nodeName ?? null,
      id: element?.getAttribute?.("id") ?? null,
      display: sceneNode.display,
      participatesInLayout,
      hasText: typeof sceneNode.text === "string" &&
        sceneNode.text.trim().length > 0,
      hasImage: sceneNode.src !== undefined,
      hasBackground: style.hasBackground,
      children: Object.freeze([...(sceneNode.children ?? [])]),
      declaredWidth: style.declaredWidth,
      declaredHeight: style.declaredHeight,
      borderBox: participatesInLayout
        ? Object.freeze({ ...box.borderBox })
        : null,
      scroll: participatesInLayout
        ? Object.freeze(
            {
              left: box.scroll.left,
              top: box.scroll.top,
              width: nodeScrollWidth,
              height: nodeScrollHeight,
            },
          )
        : null,
      intrinsicDimensions: (flags & 2) !== 0
        ? Object.freeze({
          width: box.contentBox.width,
          height: box.contentBox.height,
        })
        : null,
      viewportSizedBackground: (flags & 4) !== 0,
    });
  });
  globalThis[Symbol.for("sandom.domCore.measurement")]?.record({
    category: "geometry", operation: "frame_inspection_resolve",
    direction: "core-to-host", bytes: serialized.nodes.length * 20 + 48,
  });
  return Object.freeze({
    kind: "layout-facts",
    version: 1,
    viewport: Object.freeze({ ...viewport }),
    documentScrollBounds: Object.freeze({
      width: scrollWidth,
      height: scrollHeight,
    }),
    overflow: Object.freeze({
      left: overflowLeft,
      top: overflowTop,
      right: overflowRight,
      bottom: overflowBottom,
    }),
    nodes: Object.freeze(nodes),
    textLineBoxes: Object.freeze(
      artifact.lineBoxes.map((line) => Object.freeze({ ...line })),
    ),
    mediaQueries: Object.freeze({
      environment: Object.freeze({
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
      }),
    }),
    containerQueries: Object.freeze({
      supported: false,
      states: Object.freeze([]),
    }),
    diagnostics: Object.freeze(
      [...document.styleSheets].flatMap((sheet) => sheet.diagnostics),
    ),
  });
  } finally {
    core.status("frame_inspection_dispose", inspection);
  }
}

export async function inspectDocumentLayout(
  renderRoot,
  viewport,
  {
    createArtifact = createLayoutArtifact,
    resolveResource = null,
  } = {},
) {
  const document = renderRoot.ownerDocument;
  const width = Number(viewport.width);
  const height = Number(viewport.height);
  const deviceScale = Number(viewport.deviceScale ?? 1);
  if (!(width > 0) || !(height > 0) || !(deviceScale > 0)) {
    throw new RangeError(
      "inspection viewport width, height, and deviceScale must be positive",
    );
  }
  const previousCallbackSuppression = document._suppressAuthoredCallbacks;
  const styleSystem = document._styleSystem;
  const previousEnvironment = { ...styleSystem.environment };
  document._suppressAuthoredCallbacks = true;
  let inspectionError = null;
  let layout;
  try {
    await document._readyForRendering();
    styleSystem.setEnvironment({
      viewportWidth: width,
      viewportHeight: height,
    });
    await document._readyForRendering();
    const serialized = serializeToScene(renderRoot, {
      viewportWidth: width,
      viewportHeight: height,
    });
    const artifact = await createArtifact({
      width,
      height,
      nodes: serialized.nodes,
      imageSources: serialized.imageSources,
    }, {
      resolveResource,
    });
    layout = immutableLayoutFacts(
      document,
      { width, height, deviceScale },
      serialized,
      artifact,
    );
  } catch (error) {
    inspectionError = error;
  }
  let restorationError = null;
  try {
    styleSystem.setEnvironment(previousEnvironment);
    await document._readyForRendering();
  } catch (error) {
    restorationError = error;
  } finally {
    document._suppressAuthoredCallbacks = previousCallbackSuppression;
  }
  if (inspectionError && restorationError) {
    throw new AggregateError(
      [inspectionError, restorationError],
      "Analytical inspection and environment restoration failed",
    );
  }
  if (inspectionError) throw inspectionError;
  if (restorationError) throw restorationError;
  return layout;
}

export async function inspectPreparedInput(
  preparedInput,
  request = {},
  inspectionDependencies = {},
) {
  return await performPreparedOperation(preparedInput, async (state) => {
    const {
      createSurface = createRenderSurface,
      createArtifact = createLayoutArtifact,
    } = inspectionDependencies;
    const { mode = "observed", viewport = {} } = request;
    if (!["observed", "analytical-layout"].includes(mode)) {
      throw new RangeError(
        `Unsupported inspection mode ${JSON.stringify(mode)}`,
      );
    }
    const width = Number(viewport.width);
    const height = Number(viewport.height);
    const deviceScale = Number(viewport.deviceScale ?? 1);
    if (!(width > 0) || !(height > 0) || !(deviceScale > 0)) {
      throw new RangeError(
        "inspection viewport width, height, and deviceScale must be positive",
      );
    }
    const document = preparedInput.document;

    if (mode === "analytical-layout") {
      const layout = await inspectDocumentLayout(
        document.documentElement,
        { width, height, deviceScale },
        {
          createArtifact,
          resolveResource: state.resolveResource,
        },
      );
      return Object.freeze({
        kind: "prepared-render-inspection",
        version: 1,
        mode,
        input: preparedInput.input,
        resources: state.resourceRecords(),
        diagnostics: state.diagnosticRecords(),
        layout,
        motion: null,
      });
    }

    await document._readyForRendering();

    const surface = createSurface(document.documentElement, {
      viewportWidth: width,
      viewportHeight: height,
      deviceScale,
      now: () => 0,
      requestFrame: () => 0,
      cancelFrame: () => {},
      resolveResource: state.resolveResource,
      initializePersistentRenderer: false,
    });
    try {
      const preparedState = await surface.prepareNow();
      surface.stop();
      const artifact = await createArtifact(
        preparedState.scene,
        { resolveResource: state.resolveResource },
      );
      const motion = surface.inspectMotion();
      return Object.freeze({
        kind: "prepared-render-inspection",
        version: 1,
        mode,
        input: preparedInput.input,
        resources: state.resourceRecords(),
        diagnostics: state.diagnosticRecords(),
        layout: immutableLayoutFacts(
          document,
          { width, height, deviceScale },
          preparedState.serialized,
          artifact,
        ),
        motion: Object.freeze({
          kind: "motion-facts",
          version: 1,
          ...motion,
        }),
      });
    } finally {
      await surface.shutdown();
    }
  });
}

function inspectionRectangle(logicalRectangle, deviceScale) {
  return Object.freeze({
    logical: Object.freeze({ ...logicalRectangle }),
    devicePixels: Object.freeze({
      x: logicalRectangle.x * deviceScale,
      y: logicalRectangle.y * deviceScale,
      width: logicalRectangle.width * deviceScale,
      height: logicalRectangle.height * deviceScale,
    }),
  });
}

export async function inspectAnimationPreparedInput(
  preparedInput,
  inspectionRequest = {},
) {
  return await performPreparedOperation(preparedInput, async (state) => {
    const {
      width = 1280,
      height = 720,
      deviceScale = 1,
      renderMode = "standard-dynamic-range",
      graphicsBackend = "auto",
    } = inspectionRequest;
    if (
      !Number.isFinite(width) || width <= 0 || !Number.isFinite(height) ||
      height <= 0
    ) {
      throw new RangeError("width and height must be positive numbers");
    }
    if (!Number.isFinite(deviceScale) || deviceScale <= 0) {
      throw new RangeError("deviceScale must be a positive number");
    }
    if (
      renderMode !== "standard-dynamic-range" &&
      renderMode !== "high-dynamic-range"
    ) {
      throw new RangeError(
        `Unsupported render mode ${JSON.stringify(renderMode)}`,
      );
    }
    if (!preparedInput.document.documentElement) {
      throw new Error("The preprocessor did not populate a document element");
    }

    await preparedInput.document._readyForRendering();
    const highDynamicRange = renderMode === "high-dynamic-range";
    const surface = createRenderSurface(
      preparedInput.document.documentElement,
      {
        viewportWidth: width,
        viewportHeight: height,
        deviceScale,
        resolveResource: state.resolveResource,
        encodePixels: null,
        renderMode: highDynamicRange ? "high-dynamic-range" : undefined,
        renderPrecision: highDynamicRange ? "rgba16float" : undefined,
        capturePaintArtifact: true,
        graphicsBackend,
      },
    );
    try {
      const frame = await surface.renderNow();
      surface.stop();
      if (!frame?.inspection) {
        throw new Error(
          "The render surface did not return inspection artifacts",
        );
      }
      const {
        sceneNodes,
        elementAtIndex,
        layoutBoxes,
        paintArtifact,
      } = frame.inspection;
      const parentIndices = new Array(sceneNodes.length).fill(null);
      sceneNodes.forEach((sceneNode, sceneIndex) => {
        for (const childIndex of sceneNode.children ?? []) {
          parentIndices[childIndex] = sceneIndex;
        }
      });
      const nodeIdentifier = (sceneIndex) => `scene-node-${sceneIndex}`;
      const nodes = sceneNodes.map((sceneNode, sceneIndex) => {
        const sourceNode = elementAtIndex[sceneIndex];
        let source;
        if (sourceNode?.nodeType === 1) {
          source = {
            kind: "element",
            localName: sourceNode.localName,
            namespace: sourceNode.namespaceURI,
            ...(sourceNode.id === "" ? {} : { id: sourceNode.id }),
            ...(typeof sceneNode.text === "string"
              ? { text: sceneNode.text }
              : {}),
          };
        } else if (sourceNode?.nodeType === 3) {
          source = { kind: "text", text: sourceNode.data };
        } else {
          source = {
            kind: sceneIndex === 0 ? "viewport" : "generated",
            display: sceneNode.display,
          };
        }
        return Object.freeze({
          identifier: nodeIdentifier(sceneIndex),
          sceneIndex,
          parentIdentifier: parentIndices[sceneIndex] === null
            ? null
            : nodeIdentifier(parentIndices[sceneIndex]),
          childIdentifiers: Object.freeze(
            (sceneNode.children ?? []).map(nodeIdentifier),
          ),
          source: Object.freeze(source),
        });
      });
      const layoutRectangles = layoutBoxes.map((box, sceneIndex) =>
        Object.freeze({
          nodeIdentifier: nodeIdentifier(sceneIndex),
          rectangleKind: "border-box",
          rectangle: inspectionRectangle({
            x: box.x,
            y: box.y,
            width: box.w,
            height: box.h,
          }, deviceScale),
        })
      );
      const paintOperations = paintArtifact.operations.map((operation) =>
        Object.freeze({
          operationIndex: operation.operationIndex,
          commandIndex: operation.commandIndex,
          operationKind: operation.kind,
          nodeIdentifier: nodeIdentifier(operation.nodeIndex),
          rectangle: inspectionRectangle(
            operation.logicalRectangle,
            deviceScale,
          ),
          ...(operation.text === undefined ? {} : {
            text: operation.text,
            fontSize: operation.fontSize,
            lineHeight: operation.lineHeight,
            ascent: operation.ascent,
            descent: operation.descent,
            baseline: operation.baseline,
            glyphAdvances: Object.freeze([...operation.glyphAdvances]),
          }),
          affine: operation.affine,
          clip: Object.freeze({
            entries: Object.freeze(
              operation.clipEntries.map((entry) =>
                Object.freeze({
                  rectangle: inspectionRectangle({
                    x: entry.x,
                    y: entry.y,
                    width: entry.width,
                    height: entry.height,
                  }, deviceScale),
                  radii: Object.freeze([...entry.radii]),
                  affine: entry.affine,
                  pathMask: entry.pathMask,
                })
              ),
            ),
          }),
          opacity: operation.opacity,
          blendMode: operation.blendMode,
          compositingGroupIdentifiers: Object.freeze(
            [...operation.compositingGroupIdentifiers],
          ),
          stackingContextIdentifiers: Object.freeze(
            [...operation.stackingContextIdentifiers],
          ),
        })
      );
      const textChunks = paintOperations.filter((operation) =>
        operation.operationKind === "text" ||
        operation.operationKind === "text-shadow"
      );
      const compositingGroups = paintArtifact.compositingGroups.map((group) =>
        Object.freeze({
          identifier: group.identifier,
          groupKind: group.kind,
          nodeIdentifier: group.nodeIndex === null
            ? null
            : nodeIdentifier(group.nodeIndex),
          startCommandIndex: group.startCommandIndex,
          endCommandIndex: group.endCommandIndex,
          startOperationIndex: group.startOperationIndex,
          endOperationIndex: group.endOperationIndex,
          stackingContext: group.stackingContext,
          ...(group.opacity === undefined ? {} : { opacity: group.opacity }),
          ...(group.blendMode === undefined
            ? {}
            : { blendMode: group.blendMode }),
        })
      );
      return Object.freeze({
        input: preparedInput.input,
        resources: state.resourceRecords(),
        diagnostics: state.diagnosticRecords(),
        requestedGraphicsBackend: graphicsBackend,
        graphicsBackend: frame.graphicsBackend,
        graphicsBackendInfo: frame.graphicsBackendInfo,
        viewport: Object.freeze({
          width,
          height,
          deviceScale,
          devicePixelWidth: frame.width,
          devicePixelHeight: frame.height,
          renderMode,
        }),
        nodes: Object.freeze(nodes),
        layout: Object.freeze({
          rectangles: Object.freeze(layoutRectangles),
        }),
        paint: Object.freeze({
          operations: Object.freeze(paintOperations),
          textChunks: Object.freeze(textChunks),
          compositingGroups: Object.freeze(compositingGroups),
        }),
      });
    } finally {
      await surface.shutdown();
    }
  });
}

export async function inspectAnimationInput(input, options = {}) {
  const {
    preprocessors = [],
    preprocessor,
    resolveResource = null,
    ...inspectionRequest
  } = options;
  const preparedInput = await prepareRenderInput(input, {
    preprocessors,
    preprocessor,
    resolveResource,
  });
  const session = new DocumentSession(preparedInput);
  try {
    return await inspectAnimationPreparedInput(
      preparedInput,
      inspectionRequest,
    );
  } finally {
    await session.dispose();
  }
}

export async function renderHTMLAnimation(source, options = {}) {
  const { baseURL = "about:blank", format = "gif", ...renderOptions } = options;
  if (format !== "gif") {
    throw new RangeError(
      `Unsupported animation format ${JSON.stringify(format)}`,
    );
  }
  return await renderAnimationInput({
    url: new URL(baseURL),
    bytes: new TextEncoder().encode(String(source)),
  }, {
    ...renderOptions,
    preprocessor: "html",
    format: "gif",
  });
}
