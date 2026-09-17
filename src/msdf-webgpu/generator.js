// WebGPU MSDF generator.
//
// Consumes prepared-glyph-geometry buffers (design/prepared-glyph-geometry.md,
// produced by vendor/msdfgen.wasm's prepare_outline_msdf_geometry) and
// generates the three-channel field on the GPU through the WGSL port in
// shader.js. GlyphResourceManager selects it for eligible multi-glyph batches.
//
// Failure policy: no silent fallback anywhere. Malformed buffers, unknown
// format versions, glyphs above the contour cap, device loss, and exceeded
// device limits all throw WebGpuMsdfError with a machine-readable code.

import {
  MAX_CONTOURS,
  MSDF_ATLAS_POPULATION_WGSL,
  MSDF_COMPUTE_WGSL,
  WORKGROUP_SIZE,
} from './shader.js';

const HEADER_BYTES = 96;
const CONTOUR_BYTES = 12;
const EDGE_BYTES = 72;
const FORMAT_VERSION = 1;
const GLYPH_RECORD_WORDS = 16; // 8 u32 + 8 f32, mirrors shader GlyphRecord

const MIN_DEVIATION_RATIO = 1.11111111111111111; // ErrorCorrectionConfig default
const PROTECTION_RADIUS_TOLERANCE = 1.001;

export class WebGpuMsdfError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'WebGpuMsdfError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Parses one prepared-geometry buffer. Throws WebGpuMsdfError on any
 * malformed input. Returns { empty: true } for a header-only buffer.
 */
export function parsePreparedGeometry(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < HEADER_BYTES) {
    throw new WebGpuMsdfError('malformed-buffer', `prepared buffer too small (${bytes?.length ?? 'none'} bytes)`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const version = view.getUint32(0, true);
  if (version !== FORMAT_VERSION) {
    throw new WebGpuMsdfError('unknown-format-version', `prepared buffer version ${version}, expected ${FORMAT_VERSION}`);
  }
  const flags = view.getUint32(4, true);
  const contourCount = view.getUint32(88, true);
  const edgeCount = view.getUint32(92, true);
  const expected = HEADER_BYTES + contourCount * CONTOUR_BYTES + edgeCount * EDGE_BYTES;
  if (bytes.length !== expected) {
    throw new WebGpuMsdfError('malformed-buffer', `prepared buffer is ${bytes.length} bytes, records need ${expected}`);
  }
  if (contourCount === 0) {
    return { empty: true, flags };
  }
  const parsed = {
    empty: false,
    flags,
    flipY: (flags & 1) !== 0,
    width: view.getUint32(8, true),
    height: view.getUint32(12, true),
    scale: view.getFloat64(16, true),
    translateX: view.getFloat64(24, true),
    translateY: view.getFloat64(32, true),
    rangeLower: view.getFloat64(40, true),
    rangeUpper: view.getFloat64(48, true),
    boundsLeft: view.getFloat64(56, true),
    boundsBottom: view.getFloat64(64, true),
    boundsRight: view.getFloat64(72, true),
    boundsTop: view.getFloat64(80, true),
    contours: [],
    edges: [],
  };
  if (parsed.width === 0 || parsed.height === 0) {
    throw new WebGpuMsdfError('malformed-buffer', 'inked glyph with zero output dimensions');
  }
  let expectedStart = 0;
  for (let c = 0; c < contourCount; c++) {
    const base = HEADER_BYTES + c * CONTOUR_BYTES;
    const edgeStart = view.getUint32(base, true);
    const contourEdges = view.getUint32(base + 4, true);
    const winding = view.getInt32(base + 8, true);
    if (edgeStart !== expectedStart || edgeStart + contourEdges > edgeCount) {
      throw new WebGpuMsdfError('malformed-buffer', `contour ${c} edge range is not contiguous`);
    }
    expectedStart = edgeStart + contourEdges;
    parsed.contours.push({ edgeStart, edgeCount: contourEdges, winding });
  }
  if (expectedStart !== edgeCount) {
    throw new WebGpuMsdfError('malformed-buffer', 'contour ranges do not cover all edges');
  }
  const edgeBase = HEADER_BYTES + contourCount * CONTOUR_BYTES;
  for (let e = 0; e < edgeCount; e++) {
    const base = edgeBase + e * EDGE_BYTES;
    const type = view.getUint32(base, true);
    const color = view.getUint32(base + 4, true);
    if (type < 1 || type > 3) {
      throw new WebGpuMsdfError('malformed-buffer', `edge ${e} has unknown type ${type}`);
    }
    if (color < 1 || color > 7) {
      throw new WebGpuMsdfError('malformed-buffer', `edge ${e} has invalid color mask ${color}`);
    }
    const points = new Float64Array(8);
    for (let i = 0; i < 8; i++) points[i] = view.getFloat64(base + 8 + i * 8, true);
    parsed.edges.push({ type, color, points });
  }
  return parsed;
}

function growBuffer(device, current, neededBytes, usage, label) {
  if (current && current.size >= neededBytes) return current;
  if (current) current.destroy();
  // Deliberate growth: next power of two, so repeated warm batches reuse.
  let size = 256;
  while (size < neededBytes) size *= 2;
  return device.createBuffer({ label, size, usage });
}

/**
 * Creates the per-device generator. Owns pipelines, layouts, and reusable
 * buffers; call shutdown() to release everything.
 */
export async function createWebGpuMsdfGenerator(options = {}) {
  const pipelineCreationStartedAt = performance.now();
  let device = options.device ?? null;
  let ownsDevice = false;
  if (!device) {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new WebGpuMsdfError('no-adapter', 'navigator.gpu.requestAdapter() returned null');
    device = await adapter.requestDevice();
    ownsDevice = true;
  }

  let broken = null;
  device.lost.then((info) => {
    broken = new WebGpuMsdfError('device-lost', `WebGPU device lost: ${info.message}`, { reason: info.reason });
  }).catch(() => {
    // device.lost never rejects per spec; guard anyway so an exotic
    // runtime rejection cannot become an unhandled promise.
    broken = new WebGpuMsdfError('device-lost', 'WebGPU device lost');
  });

  const limits = device.limits;
  const module = device.createShaderModule({ label: 'msdf-compute', code: MSDF_COMPUTE_WGSL });

  const bindGroupLayout = device.createBindGroupLayout({
    label: 'msdf-compute-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ],
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
  const passNames = ['pass_field', 'pass_protect', 'pass_find_errors_base', 'pass_find_errors_shape', 'pass_pack'];
  const pipelines = passNames.map((entryPoint) => device.createComputePipeline({
    label: `msdf-${entryPoint}`,
    layout: pipelineLayout,
    compute: { module, entryPoint },
  }));
  const populationModule = device.createShaderModule({
    label: 'msdf-atlas-population',
    code: MSDF_ATLAS_POPULATION_WGSL,
  });
  const populationBindGroupLayout = device.createBindGroupLayout({
    label: 'msdf-atlas-population-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: 'write-only', format: 'rgba8unorm' },
      },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ],
  });
  const populationPipeline = device.createComputePipeline({
    label: 'msdf-atlas-population',
    layout: device.createPipelineLayout({
      bindGroupLayouts: [populationBindGroupLayout],
    }),
    compute: { module: populationModule, entryPoint: 'populate_atlas' },
  });
  const pipelineCreationMilliseconds =
    performance.now() - pipelineCreationStartedAt;

  // Reusable buffers, grown deliberately, released on shutdown.
  const buffers = {
    glyphs: null, contours: null, edgeMeta: null, edgePoints: null,
    texelGlyph: null, field: null, stencil: null, output: null,
    params: device.createBuffer({
      label: 'msdf-params', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }),
    populationPlacements: null,
    populationParams: device.createBuffer({
      label: 'msdf-atlas-population-params',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }),
    readback: null,
  };
  let shutdownDone = false;

  function ensureUsable() {
    if (shutdownDone) throw new WebGpuMsdfError('shut-down', 'generator was shut down');
    if (broken) throw broken;
  }

  // Splits parsed glyphs into sub-batches that respect device limits.
  // Deterministic: greedy in input order, split when any buffer would
  // exceed maxStorageBufferBindingSize.
  function splitBatches(parsedList) {
    const maxBind = Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize);
    const batches = [];
    let current = null;
    for (const item of parsedList) {
      if (item.parsed.empty) continue;
      const texels = item.parsed.width * item.parsed.height;
      const edges = item.parsed.edges.length;
      const contours = item.parsed.contours.length;
      const candidate = current ? {
        texels: current.texels + texels,
        edges: current.edges + edges,
        contours: current.contours + contours,
        glyphCount: current.items.length + 1,
      } : { texels, edges, contours, glyphCount: 1 };
      const fits =
        candidate.texels * 12 <= maxBind && // field: 3 f32
        candidate.texels * 4 <= maxBind && // stencil/output/texelGlyph
        candidate.edges * 32 <= maxBind && // edgePoints: 8 f32
        candidate.glyphCount * GLYPH_RECORD_WORDS * 4 <= maxBind;
      if (!current || !fits) {
        if (current) batches.push(current);
        current = { items: [], texels: 0, edges: 0, contours: 0 };
      }
      current.items.push(item);
      current.texels += texels;
      current.edges += edges;
      current.contours += contours;
    }
    if (current && current.items.length > 0) batches.push(current);
    return batches;
  }

  function packBatch(batch) {
    const glyphWords = new ArrayBuffer(batch.items.length * GLYPH_RECORD_WORDS * 4);
    const glyphU32 = new Uint32Array(glyphWords);
    const glyphF32 = new Float32Array(glyphWords);
    const contourData = new Uint32Array(batch.contours * 4);
    const edgeMetaData = new Uint32Array(batch.edges * 2);
    const edgePointData = new Float32Array(batch.edges * 8);
    const texelGlyphData = new Uint32Array(batch.texels);

    let contourCursor = 0;
    let edgeCursor = 0;
    let texelCursor = 0;
    batch.items.forEach((item, glyphIndex) => {
      const p = item.parsed;
      const base = glyphIndex * GLYPH_RECORD_WORDS;
      const rangeWidth = p.rangeUpper - p.rangeLower;
      const invRangeWidth = 1 / rangeWidth;
      const spanUnit = invRangeWidth / p.scale;
      glyphU32[base + 0] = contourCursor;
      glyphU32[base + 1] = p.contours.length;
      glyphU32[base + 2] = p.width;
      glyphU32[base + 3] = p.height;
      glyphU32[base + 4] = texelCursor;
      glyphU32[base + 5] = texelCursor; // output shares texel indexing
      glyphU32[base + 6] = p.flipY ? 1 : 0;
      glyphU32[base + 7] = 0;
      glyphF32[base + 8] = p.scale;
      glyphF32[base + 9] = p.translateX;
      glyphF32[base + 10] = p.translateY;
      glyphF32[base + 11] = invRangeWidth;
      glyphF32[base + 12] = MIN_DEVIATION_RATIO * spanUnit;
      glyphF32[base + 13] = MIN_DEVIATION_RATIO * spanUnit * Math.SQRT2;
      glyphF32[base + 14] = PROTECTION_RADIUS_TOLERANCE * spanUnit;
      glyphF32[base + 15] = PROTECTION_RADIUS_TOLERANCE * spanUnit * Math.SQRT2;

      for (const contour of p.contours) {
        contourData[contourCursor * 4 + 0] = edgeCursor + contour.edgeStart;
        contourData[contourCursor * 4 + 1] = contour.edgeCount;
        contourData[contourCursor * 4 + 2] = contour.winding + 1;
        contourData[contourCursor * 4 + 3] = 0;
        contourCursor++;
      }
      p.edges.forEach((edge, e) => {
        edgeMetaData[(edgeCursor + e) * 2] = edge.type;
        edgeMetaData[(edgeCursor + e) * 2 + 1] = edge.color;
        edgePointData.set(Float32Array.from(edge.points), (edgeCursor + e) * 8);
      });
      edgeCursor += p.edges.length;
      const texels = p.width * p.height;
      texelGlyphData.fill(glyphIndex, texelCursor, texelCursor + texels);
      item.fieldOffset = texelCursor;
      texelCursor += texels;
    });

    return { glyphWords, contourData, edgeMetaData, edgePointData, texelGlyphData, totalTexels: texelCursor };
  }

  const STORAGE = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;

  async function runBatch(batch, readBack, directAtlas, timings) {
    const packStart = performance.now();
    const packed = packBatch(batch);
    timings.cpuPackMilliseconds += performance.now() - packStart;

    const uploadStart = performance.now();
    buffers.glyphs = growBuffer(device, buffers.glyphs, packed.glyphWords.byteLength, STORAGE, 'msdf-glyphs');
    buffers.contours = growBuffer(device, buffers.contours, packed.contourData.byteLength, STORAGE, 'msdf-contours');
    buffers.edgeMeta = growBuffer(device, buffers.edgeMeta, packed.edgeMetaData.byteLength, STORAGE, 'msdf-edge-meta');
    buffers.edgePoints = growBuffer(device, buffers.edgePoints, packed.edgePointData.byteLength, STORAGE, 'msdf-edge-points');
    buffers.texelGlyph = growBuffer(device, buffers.texelGlyph, packed.texelGlyphData.byteLength, STORAGE, 'msdf-texel-glyph');
    buffers.field = growBuffer(device, buffers.field, packed.totalTexels * 12, GPUBufferUsage.STORAGE, 'msdf-field');
    buffers.stencil = growBuffer(device, buffers.stencil, packed.totalTexels * 4, GPUBufferUsage.STORAGE, 'msdf-stencil');
    buffers.output = growBuffer(
      device, buffers.output, packed.totalTexels * 4,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, 'msdf-output',
    );

    const workgroups = Math.ceil(packed.totalTexels / WORKGROUP_SIZE);
    const maxPerDim = limits.maxComputeWorkgroupsPerDimension;
    const xGroups = Math.min(workgroups, maxPerDim);
    const yGroups = Math.ceil(workgroups / xGroups);
    if (yGroups > maxPerDim) {
      throw new WebGpuMsdfError('batch-too-large', `batch needs ${workgroups} workgroups, device caps ${maxPerDim}^2`, { totalTexels: packed.totalTexels });
    }
    const paramsData = new Uint32Array([packed.totalTexels, xGroups * WORKGROUP_SIZE, 0, 0]);

    device.queue.writeBuffer(buffers.params, 0, paramsData);
    // Deno's writeBuffer rejects a bare ArrayBuffer; hand it a view.
    device.queue.writeBuffer(buffers.glyphs, 0, new Uint8Array(packed.glyphWords));
    device.queue.writeBuffer(buffers.contours, 0, packed.contourData);
    device.queue.writeBuffer(buffers.edgeMeta, 0, packed.edgeMetaData);
    device.queue.writeBuffer(buffers.edgePoints, 0, packed.edgePointData);
    device.queue.writeBuffer(buffers.texelGlyph, 0, packed.texelGlyphData);
    timings.uploadMilliseconds += performance.now() - uploadStart;
    let populationPlacementData = null;
    if (directAtlas) {
      populationPlacementData = new Uint32Array(batch.items.length * 8);
      for (let index = 0; index < batch.items.length; index++) {
        const item = batch.items[index];
        const placement = directAtlas.placements[item.inputIndex];
        const base = index * 8;
        populationPlacementData[base] = item.fieldOffset;
        populationPlacementData[base + 1] = item.parsed.width;
        populationPlacementData[base + 2] = item.parsed.height;
        populationPlacementData[base + 3] = placement.x;
        populationPlacementData[base + 4] = placement.y;
      }
      buffers.populationPlacements = growBuffer(
        device,
        buffers.populationPlacements,
        populationPlacementData.byteLength,
        STORAGE,
        'msdf-atlas-population-placements',
      );
      device.queue.writeBuffer(
        buffers.populationPlacements,
        0,
        populationPlacementData,
      );
      device.queue.writeBuffer(
        buffers.populationParams,
        0,
        new Uint32Array([batch.items.length, 0, 0, 0]),
      );
    }

    const encodeStart = performance.now();
    const bindGroup = device.createBindGroup({
      label: 'msdf-batch',
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: buffers.glyphs } },
        { binding: 1, resource: { buffer: buffers.contours } },
        { binding: 2, resource: { buffer: buffers.edgeMeta } },
        { binding: 3, resource: { buffer: buffers.edgePoints } },
        { binding: 4, resource: { buffer: buffers.texelGlyph } },
        { binding: 5, resource: { buffer: buffers.field } },
        { binding: 6, resource: { buffer: buffers.stencil } },
        { binding: 7, resource: { buffer: buffers.output } },
        { binding: 8, resource: { buffer: buffers.params } },
      ],
    });
    const encoder = device.createCommandEncoder({ label: 'msdf-batch' });
    for (const pipeline of pipelines) {
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(xGroups, yGroups);
      pass.end();
    }
    if (directAtlas) {
      const populationEncodingStartedAt = performance.now();
      const populationBindGroup = device.createBindGroup({
        label: 'msdf-atlas-population',
        layout: populationBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: buffers.output } },
          { binding: 1, resource: { buffer: buffers.populationPlacements } },
          { binding: 2, resource: directAtlas.texture.createView() },
          { binding: 3, resource: { buffer: buffers.populationParams } },
        ],
      });
      const maximumGlyphTexels = batch.items.reduce(
        (maximum, item) =>
          Math.max(maximum, item.parsed.width * item.parsed.height),
        0,
      );
      const populationPass = encoder.beginComputePass();
      populationPass.setPipeline(populationPipeline);
      populationPass.setBindGroup(0, populationBindGroup);
      populationPass.dispatchWorkgroups(
        Math.ceil(maximumGlyphTexels / WORKGROUP_SIZE),
        batch.items.length,
      );
      populationPass.end();
      timings.directAtlasPopulationMilliseconds +=
        performance.now() - populationEncodingStartedAt;
    }
    if (readBack) {
      buffers.readback = growBuffer(
        device, buffers.readback, packed.totalTexels * 4,
        GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, 'msdf-readback',
      );
      encoder.copyBufferToBuffer(buffers.output, 0, buffers.readback, 0, packed.totalTexels * 4);
    }
    timings.encodeMilliseconds += performance.now() - encodeStart;

    const submitStart = performance.now();
    device.queue.submit([encoder.finish()]);
    timings.submitMilliseconds += performance.now() - submitStart;

    // Exactly ONE GPU-completion await per submitted batch (Deno resolves
    // GPU async work on a fixed poll cadence — never chain completions).
    const completionStart = performance.now();
    if (readBack) {
      await buffers.readback.mapAsync(GPUMapMode.READ, 0, packed.totalTexels * 4);
      timings.completionMilliseconds += performance.now() - completionStart;
      const readStart = performance.now();
      const rgba = new Uint8Array(buffers.readback.getMappedRange(0, packed.totalTexels * 4));
      for (const item of batch.items) {
        const p = item.parsed;
        const texels = p.width * p.height;
        const pixels = new Uint8Array(texels * 3);
        const base = item.fieldOffset * 4;
        for (let i = 0; i < texels; i++) {
          pixels[i * 3] = rgba[base + i * 4];
          pixels[i * 3 + 1] = rgba[base + i * 4 + 1];
          pixels[i * 3 + 2] = rgba[base + i * 4 + 2];
        }
        item.result.pixels = pixels;
      }
      buffers.readback.unmap();
      timings.readbackMilliseconds += performance.now() - readStart;
    } else {
      await device.queue.onSubmittedWorkDone();
      timings.completionMilliseconds += performance.now() - completionStart;
    }
    if (broken) throw broken;
  }

  return {
    device,
    limits: {
      maxContoursPerGlyph: MAX_CONTOURS,
      maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
    },
    pipelineCreationMilliseconds,

    /**
     * Generates fields for a list of prepared-geometry buffers
     * (Uint8Array each). Returns { results, timings }. Each result is
     * { width, height, pixels } — pixels is a Uint8Array of RGB rows in
     * output orientation when readBack is set, null otherwise; empty
     * glyphs yield width 0, height 0, pixels null.
     */
    async generate(
      preparedBuffers,
      { readBack = false, directAtlas = null } = {},
    ) {
      if (readBack && directAtlas) {
        throw new WebGpuMsdfError(
          'invalid-output-policy',
          'readback and direct atlas population are mutually exclusive',
        );
      }
      if (
        directAtlas &&
        (
          !directAtlas.texture ||
          !Array.isArray(directAtlas.placements) ||
          directAtlas.placements.length !== preparedBuffers.length
        )
      ) {
        throw new WebGpuMsdfError(
          'malformed-atlas-target',
          'direct atlas target needs one placement per prepared glyph',
        );
      }
      ensureUsable();
      const timings = {
        cpuPackMilliseconds: 0,
        uploadMilliseconds: 0,
        encodeMilliseconds: 0,
        submitMilliseconds: 0,
        completionMilliseconds: 0,
        directAtlasPopulationMilliseconds: 0,
        readbackMilliseconds: 0,
        totalMilliseconds: 0,
        batchCount: 0,
      };
      const totalStart = performance.now();
      const parsedList = preparedBuffers.map((bytes, index) => {
        const parsed = parsePreparedGeometry(bytes);
        if (!parsed.empty && parsed.contours.length > MAX_CONTOURS) {
          throw new WebGpuMsdfError(
            'contour-cap-exceeded',
            `glyph ${index} has ${parsed.contours.length} contours, mechanism cap is ${MAX_CONTOURS}`,
            { glyphIndex: index, contourCount: parsed.contours.length },
          );
        }
        const result = parsed.empty
          ? { width: 0, height: 0, pixels: null }
          : { width: parsed.width, height: parsed.height, pixels: null };
        return { parsed, result, fieldOffset: 0, inputIndex: index };
      });

      const batches = splitBatches(parsedList);
      timings.batchCount = batches.length;
      for (const batch of batches) {
        await runBatch(batch, readBack, directAtlas, timings);
      }
      timings.totalMilliseconds = performance.now() - totalStart;
      return { results: parsedList.map((item) => item.result), timings };
    },

    shutdown() {
      if (shutdownDone) return;
      shutdownDone = true;
      for (const key of Object.keys(buffers)) {
        if (buffers[key]) {
          buffers[key].destroy();
          buffers[key] = null;
        }
      }
      if (ownsDevice) device.destroy();
    },
  };
}
