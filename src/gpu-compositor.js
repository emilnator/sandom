import { GlyphResourceManager } from "./glyph-resource-manager.js";
import { validateClosedRecord } from "./closed-record.js";
import { clipUniformFloats } from "./gpu-composition-clip.js";
import { createGpuCompositionOperations } from "./rasterize.js";
import { shapeFontText } from "./shaping.js";
import { decodeWebFont } from "./web-font.js";

const IDENTITY_TRANSFORM = Object.freeze({
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  e: 0,
  f: 0,
});
const DEFAULT_TEXT_COLOR = Object.freeze([1, 1, 1, 1]);
const DEFAULT_CLEAR_COLOR = Object.freeze([0, 0, 0, 1]);
const TEXTURE_LAYER_FIELDS = new Set([
  "textureView",
  "destinationRectangle",
  "opacity",
  "clipRectangle",
  "transform",
]);
const TEXT_LAYER_FIELDS = new Set([
  "fontBytes",
  "text",
  "fontSize",
  "baselinePosition",
  "color",
  "letterSpacing",
  "weight",
  "opticalSize",
  "opacity",
  "clipRectangle",
  "transform",
]);

function validateFiniteNumber(value, name) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be finite`);
  }
  return value;
}

function validateUnitInterval(value, name) {
  validateFiniteNumber(value, name);
  if (value < 0 || value > 1) {
    throw new RangeError(`${name} must be between 0 and 1`);
  }
  return value;
}

function validateRectangle(value, name) {
  validateClosedRecord(value, new Set(["x", "y", "width", "height"]), name);
  const rectangle = {
    x: validateFiniteNumber(value.x, `${name}.x`),
    y: validateFiniteNumber(value.y, `${name}.y`),
    width: validateFiniteNumber(value.width, `${name}.width`),
    height: validateFiniteNumber(value.height, `${name}.height`),
  };
  if (rectangle.width <= 0 || rectangle.height <= 0) {
    throw new RangeError(`${name} width and height must be positive`);
  }
  return Object.freeze(rectangle);
}

function validatePosition(value, name) {
  validateClosedRecord(value, new Set(["x", "y"]), name);
  return Object.freeze({
    x: validateFiniteNumber(value.x, `${name}.x`),
    y: validateFiniteNumber(value.y, `${name}.y`),
  });
}

function validateTransform(value, name) {
  validateClosedRecord(value, new Set(["a", "b", "c", "d", "e", "f"]), name);
  const transform = Object.freeze({
    a: validateFiniteNumber(value.a, `${name}.a`),
    b: validateFiniteNumber(value.b, `${name}.b`),
    c: validateFiniteNumber(value.c, `${name}.c`),
    d: validateFiniteNumber(value.d, `${name}.d`),
    e: validateFiniteNumber(value.e, `${name}.e`),
    f: validateFiniteNumber(value.f, `${name}.f`),
  });
  if (transform.a * transform.d - transform.b * transform.c === 0) {
    throw new RangeError(`${name} must be invertible`);
  }
  return transform;
}

function validateColor(value, name, { opaque = false } = {}) {
  if (!Array.isArray(value) && !(value instanceof Float32Array)) {
    throw new TypeError(`${name} must be a four-component array`);
  }
  if (value.length !== 4) {
    throw new RangeError(`${name} must contain four components`);
  }
  const color = Object.freeze(Array.from(value, (component, index) =>
    validateFiniteNumber(component, `${name}[${index}]`)
  ));
  validateUnitInterval(color[3], `${name}[3]`);
  if (opaque && color[3] !== 1) {
    throw new RangeError(`${name} must be opaque`);
  }
  return color;
}

function normalizeClipRectangle(value, name) {
  return value === null ? null : validateRectangle(value, name);
}

function normalizeTextureRecord(record, previous = null) {
  validateClosedRecord(record, TEXTURE_LAYER_FIELDS, "texture layer");
  const textureView = record.textureView === undefined
    ? previous?.textureView
    : record.textureView;
  if (
    textureView === null ||
    (typeof textureView !== "object" && typeof textureView !== "function")
  ) {
    throw new TypeError("texture layer textureView must be a GPUTextureView");
  }
  const destinationRectangle = record.destinationRectangle === undefined
    ? previous?.destinationRectangle
    : validateRectangle(
      record.destinationRectangle,
      "texture layer destinationRectangle",
    );
  if (!destinationRectangle) {
    throw new TypeError("texture layer destinationRectangle is required");
  }
  return Object.freeze({
    textureView,
    destinationRectangle,
    opacity: record.opacity === undefined
      ? previous?.opacity ?? 1
      : validateUnitInterval(record.opacity, "texture layer opacity"),
    clipRectangle: record.clipRectangle === undefined
      ? previous?.clipRectangle ?? null
      : normalizeClipRectangle(
        record.clipRectangle,
        "texture layer clipRectangle",
      ),
    transform: record.transform === undefined
      ? previous?.transform ?? IDENTITY_TRANSFORM
      : validateTransform(record.transform, "texture layer transform"),
  });
}

function normalizeTextRecord(record, previous = null) {
  validateClosedRecord(record, TEXT_LAYER_FIELDS, "text layer");
  const fontBytes = record.fontBytes === undefined
    ? previous?.fontBytes
    : record.fontBytes;
  if (!(fontBytes instanceof Uint8Array)) {
    throw new TypeError("text layer fontBytes must be a Uint8Array");
  }
  const text = record.text === undefined ? previous?.text : record.text;
  if (typeof text !== "string") {
    throw new TypeError("text layer text must be a string");
  }
  const fontSize = record.fontSize === undefined
    ? previous?.fontSize
    : validateFiniteNumber(record.fontSize, "text layer fontSize");
  if (fontSize === undefined || fontSize <= 0) {
    throw new RangeError("text layer fontSize must be positive");
  }
  const baselinePosition = record.baselinePosition === undefined
    ? previous?.baselinePosition
    : validatePosition(record.baselinePosition, "text layer baselinePosition");
  if (!baselinePosition) {
    throw new TypeError("text layer baselinePosition is required");
  }
  const weight = record.weight === undefined
    ? previous?.weight ?? 400
    : validateFiniteNumber(record.weight, "text layer weight");
  const opticalSize = record.opticalSize === undefined
    ? previous?.opticalSize ?? fontSize
    : validateFiniteNumber(record.opticalSize, "text layer opticalSize");
  if (opticalSize <= 0) {
    throw new RangeError("text layer opticalSize must be positive");
  }
  return Object.freeze({
    fontBytes,
    text,
    fontSize,
    baselinePosition,
    color: record.color === undefined
      ? previous?.color ?? DEFAULT_TEXT_COLOR
      : validateColor(record.color, "text layer color"),
    letterSpacing: record.letterSpacing === undefined
      ? previous?.letterSpacing ?? 0
      : validateFiniteNumber(record.letterSpacing, "text layer letterSpacing"),
    weight,
    opticalSize,
    opacity: record.opacity === undefined
      ? previous?.opacity ?? 1
      : validateUnitInterval(record.opacity, "text layer opacity"),
    clipRectangle: record.clipRectangle === undefined
      ? previous?.clipRectangle ?? null
      : normalizeClipRectangle(record.clipRectangle, "text layer clipRectangle"),
    transform: record.transform === undefined
      ? previous?.transform ?? IDENTITY_TRANSFORM
      : validateTransform(record.transform, "text layer transform"),
  });
}

function clipState(clipRectangle) {
  if (clipRectangle === null) return { entries: [] };
  return {
    entries: [{
      x: clipRectangle.x,
      y: clipRectangle.y,
      w: clipRectangle.width,
      h: clipRectangle.height,
      radiiX: [0, 0, 0, 0],
      radiiY: [0, 0, 0, 0],
      mode: 1,
      axisBits: 3,
      inverseAffine: [1, 0, 0, 1, 0, 0],
    }],
  };
}

function transformFloats(transform) {
  return [
    transform.a,
    transform.b,
    transform.c,
    transform.d,
    transform.e,
    transform.f,
  ];
}

function textureInstance(record) {
  const rectangle = record.destinationRectangle;
  return new Float32Array([
    rectangle.x,
    rectangle.y,
    rectangle.width,
    rectangle.height,
    0,
    0,
    1,
    1,
    ...transformFloats(record.transform),
    0,
    0,
    0,
    0,
  ]);
}

function textInstances(record, shaped, atlas) {
  const instances = [];
  const fontScale = record.fontSize / shaped.upem;
  const range = 6;
  let penX = 0;
  let penY = 0;
  for (let index = 0; index < shaped.glyphs.length; index++) {
    const glyph = shaped.glyphs[index];
    const information = atlas.glyphInfo(
      glyph.g,
      record.weight,
      record.opticalSize,
      record.fontSize,
    );
    if (information && information.w > 0 && information.h > 0) {
      const boundingWidth = information.metrics.bboxXMax - information.metrics.bboxXMin;
      const boundingHeight = information.metrics.bboxYMax - information.metrics.bboxYMin;
      const maximumDimension = Math.max(boundingWidth, boundingHeight);
      const usableTexels = Math.max(information.w, information.h) - 2 * range;
      const shrinkage = maximumDimension / usableTexels;
      const quadLeft = information.metrics.bboxXMin - range * shrinkage;
      const quadRight = information.metrics.bboxXMin +
        (information.w - range) * shrinkage;
      const quadBottom = information.metrics.bboxYMin - range * shrinkage;
      const quadTop = information.metrics.bboxYMin +
        (information.h - range) * shrinkage;
      const glyphX = record.baselinePosition.x +
        (penX + glyph.dx) * fontScale + index * record.letterSpacing;
      const glyphBaseline = record.baselinePosition.y -
        (penY + glyph.dy) * fontScale;
      const x0 = glyphX + quadLeft * fontScale;
      const x1 = glyphX + quadRight * fontScale;
      const y0 = glyphBaseline - quadTop * fontScale;
      const y1 = glyphBaseline - quadBottom * fontScale;
      const screenSize = Math.max(x1 - x0, y1 - y0);
      const textureSize = Math.max(information.w, information.h);
      instances.push(
        x0,
        y0,
        x1 - x0,
        y1 - y0,
        information.u,
        information.v,
        information.uW,
        information.vH,
        record.color[0],
        record.color[1],
        record.color[2],
        record.color[3] * record.opacity,
        range * (screenSize / textureSize),
        0,
        ...transformFloats(record.transform),
      );
    }
    penX += glyph.ax;
    penY += glyph.ay;
  }
  return new Float32Array(instances);
}

export async function createGpuCompositor(options) {
  validateClosedRecord(options, new Set(["device"]), "GPU compositor options");
  const device = options.device;
  if (
    !device || typeof device.createBuffer !== "function" ||
    typeof device.createTexture !== "function" ||
    typeof device.createCommandEncoder !== "function" ||
    typeof device.pushErrorScope !== "function" ||
    typeof device.popErrorScope !== "function" ||
    typeof device.queue?.submit !== "function"
  ) {
    throw new TypeError("GPU compositor device must be a GPUDevice");
  }

  const operations = await createGpuCompositionOperations({
    colorFormat: "rgba16float",
    device,
  });
  const texturePipeline = operations.getImagePipeline();
  const textPipeline = operations.textPipeline;
  const glyphResourceManager = new GlyphResourceManager();
  const layers = new Set();
  const layerEncoders = new WeakMap();
  let disposed = false;

  function requireActive() {
    if (disposed) throw new Error("GPU compositor is disposed");
  }

  const decodedFontPromises = new WeakMap();
  async function decodedFont(fontBytes) {
    let promise = decodedFontPromises.get(fontBytes);
    if (!promise) {
      promise = decodeWebFont(fontBytes);
      decodedFontPromises.set(fontBytes, promise);
    }
    return await promise;
  }
  function createTextureLayer(record) {
    requireActive();
    let current = normalizeTextureRecord(record);
    let layerDisposed = false;
    const uniformBuffer = device.createBuffer({
      size: 656,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const instanceBuffer = device.createBuffer({
      size: 18 * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    const sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    let bindGroup = null;
    let instanceData = textureInstance(current);
    const uniformData = new Float32Array(164);
    function updateUniformData() {
      const clip = clipState(current.clipRectangle);
      uniformData[2] = clip.entries.length;
      uniformData[3] = current.opacity;
      uniformData.set(clipUniformFloats(clip), 4);
    }
    updateUniformData();

    const layer = Object.freeze({
      kind: "texture",
      update(changes) {
        requireActive();
        if (layerDisposed) throw new Error("texture layer is disposed");
        const next = normalizeTextureRecord(changes, current);
        if (next.textureView !== current.textureView) bindGroup = null;
        current = next;
        instanceData = textureInstance(current);
        updateUniformData();
      },
      async dispose() {
        if (layerDisposed) return;
        layerDisposed = true;
        layers.delete(layer);
        uniformBuffer.destroy();
        instanceBuffer.destroy();
        current = null;
        bindGroup = null;
        instanceData = null;
      },
    });
    layerEncoders.set(layer, (renderPass, width, height) => {
      if (layerDisposed) throw new Error("texture layer is disposed");
      if (bindGroup === null) {
        bindGroup = device.createBindGroup({
          layout: texturePipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: 1, resource: current.textureView },
            { binding: 2, resource: sampler },
          ],
        });
      }
      uniformData[0] = width;
      uniformData[1] = height;
      device.queue.writeBuffer(uniformBuffer, 0, uniformData);
      device.queue.writeBuffer(instanceBuffer, 0, instanceData);
      renderPass.setPipeline(texturePipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.setVertexBuffer(0, operations.quadBuffer);
      renderPass.setVertexBuffer(1, instanceBuffer);
      renderPass.draw(6, 1);
    });
    layers.add(layer);
    return layer;
  }

  const textLayerStates = new Map();
  const textSampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
  });
  let textResourceRevision = 0;
  let preparedTextResourceRevision = -1;
  let sharedTextLease = null;

  let settledShaping = Promise.resolve();

  function shapeTextRecord(record) {
    const operation = settledShaping.then(async () => {
      const decodedFontBytes = await decodedFont(record.fontBytes);
      const shaped = await shapeFontText(
        decodedFontBytes,
        record.text,
        record.fontSize,
        {
          variations: [["wght", record.weight], ["opsz", record.opticalSize]],
        },
      );
      return { decodedFontBytes, shaped };
    });
    settledShaping = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  function updateTextUniformData(state) {
    const clip = clipState(state.current.clipRectangle);
    state.uniformData.fill(0);
    state.uniformData[2] = clip.entries.length;
    state.uniformData[5] = 1;
    state.uniformData.set(clipUniformFloats(clip), 8);
  }

  function updateTextInstances(state) {
    if (state.atlas === null) {
      state.instances = new Float32Array(0);
      return;
    }
    const instances = textInstances(
      state.current,
      state.shaped,
      state.atlas,
    );
    if (instances.byteLength > state.instanceCapacity) {
      state.instanceBuffer.destroy();
      state.instanceCapacity = instances.byteLength;
      state.instanceBuffer = device.createBuffer({
        size: state.instanceCapacity,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    state.instances = instances;
  }

  function releaseSharedTextResources() {
    for (const state of textLayerStates.values()) {
      state.atlas = null;
      state.bindGroup = null;
      state.instances = new Float32Array(0);
    }
    // Atlas textures are owned by the atlases (WasmAtlas.deviceTexture);
    // releasing the lease is what retires them.
    if (sharedTextLease !== null) {
      const lease = sharedTextLease;
      sharedTextLease = null;
      lease.release();
    }
  }

  async function ensureSharedTextResources() {
    if (preparedTextResourceRevision === textResourceRevision) return;
    if (sharedTextLease !== null) {
      await device.queue.onSubmittedWorkDone();
      releaseSharedTextResources();
    }
    const requestedRevision = textResourceRevision;
    const states = [...textLayerStates.values()].filter((state) =>
      !state.disposed
    );
    if (states.length === 0) {
      preparedTextResourceRevision = textResourceRevision;
      return;
    }
    const lease = await glyphResourceManager.acquire(
      states.map((state) => ({
        fontBytes: state.decodedFontBytes,
        glyphIds: state.shaped.glyphs.map((glyph) => glyph.g),
        weight: state.current.weight,
        opticalSize: state.current.opticalSize,
        devicePixelSize: state.current.fontSize,
      })),
      { generationBackend: { kind: "cpu" } },
    );
    if (textResourceRevision !== requestedRevision) {
      lease.release();
      return await ensureSharedTextResources();
    }
    try {
      for (let index = 0; index < states.length; index++) {
        const state = states[index];
        const atlas = lease.atlases[index];
        state.atlas = atlas;
        state.bindGroup = device.createBindGroup({
          layout: textPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: state.uniformBuffer } },
            {
              binding: 1,
              resource: atlas.deviceTexture(device).createView(),
            },
            { binding: 2, resource: textSampler },
          ],
        });
        updateTextInstances(state);
      }
    } catch (error) {
      lease.release();
      for (const state of states) {
        state.atlas = null;
        state.bindGroup = null;
        state.instances = new Float32Array(0);
      }
      throw error;
    }
    sharedTextLease = lease;
    preparedTextResourceRevision = requestedRevision;
  }

  async function createTextLayer(record) {
    requireActive();
    const current = normalizeTextRecord(record);
    const shapedRecord = await shapeTextRecord(current);
    requireActive();
    const state = {
      current,
      decodedFontBytes: shapedRecord.decodedFontBytes,
      shaped: shapedRecord.shaped,
      atlas: null,
      bindGroup: null,
      instances: new Float32Array(0),
      instanceCapacity: 4,
      instanceBuffer: device.createBuffer({
        size: 4,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      }),
      uniformBuffer: device.createBuffer({
        size: 672,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
      uniformData: new Float32Array(168),
      disposed: false,
      settledUpdate: Promise.resolve(),
    };
    updateTextUniformData(state);

    const layer = Object.freeze({
      kind: "text",
      update(changes) {
        requireActive();
        if (state.disposed) {
          return Promise.reject(new Error("text layer is disposed"));
        }
        const operation = state.settledUpdate.then(async () => {
          const next = normalizeTextRecord(changes, state.current);
          const resourceChanged =
            next.fontBytes !== state.current.fontBytes ||
            next.text !== state.current.text ||
            next.fontSize !== state.current.fontSize ||
            next.weight !== state.current.weight ||
            next.opticalSize !== state.current.opticalSize;
          if (resourceChanged) {
            const nextShapedRecord = await shapeTextRecord(next);
            state.current = next;
            state.decodedFontBytes = nextShapedRecord.decodedFontBytes;
            state.shaped = nextShapedRecord.shaped;
            textResourceRevision++;
          } else {
            state.current = next;
            updateTextInstances(state);
          }
          updateTextUniformData(state);
        });
        state.settledUpdate = operation.then(
          () => undefined,
          () => undefined,
        );
        return operation;
      },
      async dispose() {
        if (state.disposed) return;
        state.disposed = true;
        layers.delete(layer);
        await state.settledUpdate;
        textLayerStates.delete(layer);
        textResourceRevision++;
        state.instanceBuffer.destroy();
        state.uniformBuffer.destroy();
        state.atlas = null;
        state.bindGroup = null;
        state.instances = new Float32Array(0);
        state.current = null;
        state.decodedFontBytes = null;
        state.shaped = null;
      },
    });
    textLayerStates.set(layer, state);
    textResourceRevision++;
    layerEncoders.set(layer, (renderPass, width, height) => {
      if (state.disposed) throw new Error("text layer is disposed");
      if (state.instances.byteLength === 0) return;
      if (state.bindGroup === null) {
        throw new Error("text layer resources are not prepared");
      }
      state.uniformData[0] = width;
      state.uniformData[1] = height;
      device.queue.writeBuffer(
        state.uniformBuffer,
        0,
        state.uniformData,
      );
      device.queue.writeBuffer(state.instanceBuffer, 0, state.instances);
      renderPass.setPipeline(textPipeline);
      renderPass.setBindGroup(0, state.bindGroup);
      renderPass.setVertexBuffer(0, operations.quadBuffer);
      renderPass.setVertexBuffer(1, state.instanceBuffer);
      renderPass.draw(6, state.instances.length / 20);
    });
    layers.add(layer);
    return layer;
  }

  const compositor = Object.freeze({
    createTextureLayer,
    createTextLayer,
    async compose(record) {
      requireActive();
      validateClosedRecord(
        record,
        new Set(["targetView", "width", "height", "layers", "clearColor"]),
        "GPU composition",
      );
      if (
        record.targetView === null ||
        (typeof record.targetView !== "object" && typeof record.targetView !== "function")
      ) {
        throw new TypeError("GPU composition targetView must be a GPUTextureView");
      }
      if (!Number.isInteger(record.width) || record.width < 1) {
        throw new RangeError("GPU composition width must be a positive integer");
      }
      if (!Number.isInteger(record.height) || record.height < 1) {
        throw new RangeError("GPU composition height must be a positive integer");
      }
      if (!Array.isArray(record.layers)) {
        throw new TypeError("GPU composition layers must be an array");
      }
      for (const layer of record.layers) {
        if (!layers.has(layer)) {
          throw new TypeError("GPU composition layers must belong to this compositor");
        }
      }
      const clearColor = record.clearColor === undefined
        ? DEFAULT_CLEAR_COLOR
        : validateColor(record.clearColor, "GPU composition clearColor", { opaque: true });
      await ensureSharedTextResources();
      device.pushErrorScope("validation");
      let synchronousError = null;
      try {
        const commandEncoder = device.createCommandEncoder();
        const renderPass = commandEncoder.beginRenderPass({
          colorAttachments: [{
            view: record.targetView,
            clearValue: {
              r: clearColor[0],
              g: clearColor[1],
              b: clearColor[2],
              a: clearColor[3],
            },
            loadOp: "clear",
            storeOp: "store",
          }],
        });
        for (const layer of record.layers) {
          layerEncoders.get(layer)(renderPass, record.width, record.height);
        }
        renderPass.end();
        device.queue.submit([commandEncoder.finish()]);
      } catch (error) {
        synchronousError = error;
      }
      const validationError = await device.popErrorScope();
      if (synchronousError !== null && validationError !== null) {
        throw new AggregateError(
          [synchronousError, validationError],
          "GPU composition failed validation",
        );
      }
      if (synchronousError !== null) throw synchronousError;
      if (validationError !== null) {
        throw new Error(
          `GPU composition failed validation: ${validationError.message}`,
          { cause: validationError },
        );
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      const errors = [];
      for (const layer of [...layers]) {
        try {
          await layer.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await device.queue.onSubmittedWorkDone();
      } catch (error) {
        errors.push(error);
      }
      try {
        releaseSharedTextResources();
      } catch (error) {
        errors.push(error);
      }
      try {
        await glyphResourceManager.shutdown();
      } catch (error) {
        errors.push(error);
      }
      try {
        operations.dispose();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "GPU compositor disposal failed");
      }
    },
  });

  return compositor;
}
