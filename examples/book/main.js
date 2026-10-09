// A library of books rendered with VGPU: a hardcover, a paperback, a
// saddle-stitched booklet, a ring-bound notebook and a top-bound sketchpad.
// Leaves turn under simulated physics (book-model.js) about the pivots of
// their binding (bindings.js); the printed matter is a Sandom document per
// book, rasterized on the same GPUDevice and copied texture to texture into
// the page sheet. A document written in the sidebar editor can replace the
// numbered pages; flow.js cuts it into pages.
//
// Everything loads at run time from beside this file or from the import
// map's pinned packages, so any static file server runs the example.
import {
  bindProjectedInput,
  createRenderSurface,
  createSandomDOM,
  createSceneRenderer,
  loadFont,
} from "sandom";
// Sandom's own HTML parser, and the window object a document's classic
// scripts run against; the package exports both under src/.
import { DOMParser } from "sandom/src/dom/node.js";
import { createInputWindow } from "sandom/src/dom/input-preprocessors.js";
import { compute, draw, effect, frame, init, sampler, storage, surface, target, texture } from "vgpu";
import { MAXIMUM_LEAVES, bookType, printedPageSize } from "./bindings.js";
import { BookModel, CURVE_SAMPLES, LEAF_STRIDE, MAXIMUM_TURNING_LEAVES, PARTICLES_PER_LEAF } from "./book-model.js";
import { DEVICE_SCALE, PIXELS_PER_MM, bookDocument } from "./book-document.js";
import { MAXIMUM_RING_LOOPS, bookUniformValues, ringLoops, toBinding, toWorld } from "./book-uniform.js";
import { PageFlow } from "./flow.js";
import { ESSAY_CSS, ESSAY_HTML, WEBSITE_CSS, WEBSITE_HTML } from "./sample-document.js";

// The fonts the printed documents name. Inter ships in the sandom package;
// Crimson Text loads from the Google Fonts repository at a pinned commit.
const PACKAGE_FONTS = new URL("../test-assets/", import.meta.resolve("sandom"));
const CRIMSON_TEXT = "https://cdn.jsdelivr.net/gh/google/fonts@7085eb89a950e85db5b166b7a58d414544b4140c/ofl/crimsontext/";
const FONTS = [
  // Inter is variable: its weight axis spans 100 … 900.
  ["Inter", new URL("Inter-Variable.ttf", PACKAGE_FONTS), { weight: [100, 900] }],
  ["Crimson Text", `${CRIMSON_TEXT}CrimsonText-Regular.ttf`, {}],
  ["Crimson Text", `${CRIMSON_TEXT}CrimsonText-Italic.ttf`, { style: "italic" }],
  ["Crimson Text", `${CRIMSON_TEXT}CrimsonText-SemiBold.ttf`, { weight: 600 }],
];
const shaderText = async (name) => {
  const url = new URL(name, import.meta.url);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Shader ${url} returned ${response.status}`);
  return response.text();
};

const canvas = document.getElementById("scene");
const status = document.getElementById("status");
const control = (identifier) => document.getElementById(identifier);
const KEY_MAP_SIZE = 2048;
// The paper grain map: extent in millimetres and texels per side (about
// 0.05 mm a texel), and the largest slope its signed channels hold.
const GRAIN_EXTENT = 216;
const GRAIN_TEXELS = 4096;
const GRAIN_SLOPE_RANGE = 4;
const KEY_MAP_HALF_EXTENT = 240;
const KEY_MAP_DEPTH = 1200;
const SKY_MAP_SIZE = 1024;
const SKY_TOP = 400;
const SKY_HALF_EXTENT = 280;
const FIELD_OF_VIEW = Math.PI / 6;
// The spine outline: every leaf's bound edge, the faces of the two stacks'
// outer leaves, and the two joints.
const MAXIMUM_SHELL_POINTS = MAXIMUM_LEAVES + 6;
const CURVE_FLOATS = MAXIMUM_LEAVES * LEAF_STRIDE + 4 * MAXIMUM_SHELL_POINTS;

// ---------------------------------------------------------------- matrices (column-major, WebGPU depth)

const subtract = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalize = (a) => { const length = Math.sqrt(dot(a, a)); return a.map((value) => value / length); };

const multiply = (a, b) => {
  const result = new Array(16).fill(0);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) result[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
    }
  }
  return result;
};

const lookAt = (eye, center, up) => {
  const forward = normalize(subtract(center, eye));
  const right = normalize(cross(forward, up));
  const upward = cross(right, forward);
  return [
    right[0], upward[0], -forward[0], 0,
    right[1], upward[1], -forward[1], 0,
    right[2], upward[2], -forward[2], 0,
    -dot(right, eye), -dot(upward, eye), dot(forward, eye), 1,
  ];
};

const perspective = (fieldOfView, aspect, near, far) => {
  const focal = 1 / Math.tan(fieldOfView / 2);
  return [
    focal / aspect, 0, 0, 0,
    0, focal, 0, 0,
    0, 0, far / (near - far), -1,
    0, 0, near * far / (near - far), 0,
  ];
};

const orthographic = (halfExtent, near, far) => [
  1 / halfExtent, 0, 0, 0,
  0, 1 / halfExtent, 0, 0,
  0, 0, -1 / (far - near), 0,
  0, 0, -near / (far - near), 1,
];

try {
  if (!navigator.gpu) throw new Error("this example needs WebGPU, which this browser does not offer");
  const [geometrySource, shadingSource, paperSource, grainBakeSource, grainMipSource] = await Promise.all([
    shaderText("book-geometry.wgsl"),
    shaderText("book-shading.wgsl"),
    shaderText("paper.wgsl"),
    shaderText("paper-grain-bake.wgsl"),
    shaderText("paper-grain-mip.wgsl"),
    ...FONTS.map(([family, url, face]) => loadFont(family, url, face)),
  ]);

  const gpu = await init();
  const output = surface(gpu, canvas, { dpr: [1, 2] });
  // Asynchronous GPU failures surface in the status line with WebGPU's own message.
  gpu.onError((error) => {
    const detail = `${error.where ?? error.code}: ${error.cause?.message ?? error.message}`;
    status.textContent = `GPU error — ${detail}`;
    console.error(detail);
  });

  // The book on the table: its model, printed matter and page sheet.
  let model = null;
  let printed = null;
  let sheet = null;
  let sheetSurface = null;
  let sheetReady = false;
  let curvesVersion = -1;
  // An edited document flowed across the numbered pages, while the
  // Printed pages control selects the editor.
  let flow = null;
  // A page of the flowed document the book is turning toward, or null.
  let navigationTarget = null;

  // ---------------------------------------------------------------- page sheet with mipmaps

  // Each level averages four texels of the one above in linear light.
  const mipSource = `
    @group(0) @binding(0) var source: texture_2d<f32>;
    @group(0) @binding(1) var destination: texture_storage_2d<rgba16float, write>;
    fn toLinear(c: vec3f) -> vec3f { return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045)); }
    fn toEncoded(c: vec3f) -> vec3f { return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308)); }
    @compute @workgroup_size(8, 8)
    fn main(@builtin(global_invocation_id) id: vec3u) {
      let size = textureDimensions(destination);
      if (id.x >= size.x || id.y >= size.y) { return; }
      let limit = vec2i(textureDimensions(source)) - 1;
      let base = vec2i(id.xy) * 2;
      var sum = vec3f(0);
      for (var y = 0; y < 2; y++) {
        for (var x = 0; x < 2; x++) {
          sum += toLinear(textureLoad(source, min(base + vec2i(x, y), limit), 0).rgb);
        }
      }
      textureStore(destination, vec2i(id.xy), vec4f(toEncoded(sum * 0.25), 1.0));
    }
  `;
  const createSheet = (width, height) => {
    const levels = Math.floor(Math.log2(Math.max(width, height))) + 1;
    const created = texture(gpu, {
      kind: "2d", size: [width, height], format: "rgba16float", mipLevelCount: levels,
      usage: ["texture_binding", "copy_dst", "storage_binding"], label: "sandom-page-sheet",
    });
    const passes = [];
    for (let level = 1; level < levels; level++) {
      passes.push({
        size: [Math.max(1, width >> level), Math.max(1, height >> level)],
        kernel: compute(gpu, mipSource, {
          label: `sheet-mip-${level}`,
          set: {
            source: created.gpu.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }),
            destination: created.gpu.createView({ baseMipLevel: level, mipLevelCount: 1 }),
          },
        }),
      });
    }
    const mipmaps = () => {
      for (const { size, kernel } of passes) kernel.dispatch(Math.ceil(size[0] / 8), Math.ceil(size[1] / 8));
    };
    return { created, mipmaps };
  };

  // ---------------------------------------------------------------- paper grain map

  // The paper stock is baked once into a mipmapped grain map covering
  // GRAIN_EXTENT millimetres, the largest sheet or board of any book type;
  // the shaded pass reads it instead of evaluating the noise per pixel.
  const grainLevels = Math.log2(GRAIN_TEXELS) + 1;
  const grain = texture(gpu, {
    kind: "2d", size: [GRAIN_TEXELS, GRAIN_TEXELS], format: "rgba8snorm", mipLevelCount: grainLevels,
    usage: ["texture_binding", "storage_binding"], label: "paper-grain",
  });
  const grainLevel = (level) => grain.gpu.createView({ baseMipLevel: level, mipLevelCount: 1 });
  const grainBake = compute(gpu, `${paperSource}\n${grainBakeSource}`, {
    label: "paper-grain-bake",
    constants: { GRAIN_TEXEL: GRAIN_EXTENT / GRAIN_TEXELS, GRAIN_SLOPE_RANGE },
    set: { grain: grainLevel(0) },
  });
  const grainReductions = [];
  for (let level = 1; level < grainLevels; level++) {
    grainReductions.push({
      size: GRAIN_TEXELS >> level,
      kernel: compute(gpu, grainMipSource, {
        label: `paper-grain-mip-${level}`,
        set: { source: grainLevel(level - 1), destination: grainLevel(level) },
      }),
    });
  }
  let bakedStock = null;
  const bakeGrain = (stockIndex) => {
    if (bakedStock === stockIndex) return;
    bakedStock = stockIndex;
    grainBake.set({ bake: { stock: stockIndex, unused: [0, 0, 0] } });
    grainBake.dispatch(GRAIN_TEXELS / 8, GRAIN_TEXELS / 8);
    for (const { size, kernel } of grainReductions) kernel.dispatch(Math.ceil(size / 8), Math.ceil(size / 8));
  };
  const grainSampler = sampler(gpu, {
    minFilter: "linear", magFilter: "linear", mipmapFilter: "linear", maxAnisotropy: 16,
    addressModeU: "repeat", addressModeV: "repeat",
  });

  // ---------------------------------------------------------------- draws

  const particleBytes = MAXIMUM_TURNING_LEAVES * PARTICLES_PER_LEAF * 16;
  const particleData = new Float32Array(particleBytes / 4);
  const particles = storage(gpu, particleBytes, "read");
  const curveData = new Float32Array(CURVE_FLOATS);
  const curves = storage(gpu, CURVE_FLOATS * 4, "read");
  const shadedSource = `${geometrySource}\n${paperSource}\n${shadingSource}`;
  const occluderSource = `${geometrySource}\n@fragment fn fs_occluder() -> @location(0) vec4f { return vec4f(0.0); }`;
  const keyTarget = target(gpu, { size: [KEY_MAP_SIZE, KEY_MAP_SIZE], format: "r8unorm", depth: "depth32float", label: "key-light-map" });
  const skyTarget = target(gpu, { size: [SKY_MAP_SIZE, SKY_MAP_SIZE], format: "r8unorm", depth: "depth32float", label: "sky-map" });
  const sceneTarget = target(gpu, { size: output.size, format: "rgba16float", depth: true, msaa: true, label: "book-scene" });
  const sheetSampler = sampler(gpu, {
    minFilter: "linear", magFilter: "linear", mipmapFilter: "linear", maxAnisotropy: 16,
    addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
  });
  const shadowSampler = sampler(gpu, { minFilter: "linear", magFilter: "linear", compare: "less-equal" });

  const GEOMETRY = [
    { name: "leaf", vertex: "vs_leaf", vertices: 88 * 56 * 6, instances: MAXIMUM_TURNING_LEAVES },
    // A turning leaf lying on a stack, board or the table is a caliper above
    // it, closer than the spline between its particles can follow a curved
    // gutter; the resting surfaces draw pushed back so the leaf in front
    // always wins. The table is pushed back as far, so a gutter that runs
    // down near it does not lose to it.
    {
      name: "stack", vertex: "vs_stack", instances: 6, restingBias: true,
      vertices: 6 * Math.max((CURVE_SAMPLES - 1) * 8, (MAXIMUM_LEAVES + 1) * 4),
    },
    {
      name: "stack-ends", vertex: "vs_stack_ends", instances: 4, restingBias: true,
      vertices: 6 * (MAXIMUM_LEAVES + 1) * (CURVE_SAMPLES - 1),
    },
    { name: "board", vertex: "vs_board", vertices: 6 * 4 * (MAXIMUM_SHELL_POINTS - 1), instances: 3, restingBias: true },
    { name: "rings", vertex: "vs_rings", vertices: 6 * 48 * 8, instances: MAXIMUM_RING_LOOPS },
    { name: "staples", vertex: "vs_staples", vertices: 36, instances: 6 },
    { name: "table", vertex: "vs_table", vertices: 6, instances: 1, shadedOnly: true, restingBias: true },
  ];
  const views = [
    { kind: 2, target: skyTarget, source: occluderSource, fragment: "fs_occluder" },
    { kind: 1, target: keyTarget, source: occluderSource, fragment: "fs_occluder" },
    { kind: 0, target: sceneTarget, source: shadedSource, fragment: "fs_main" },
  ];
  for (const view of views) {
    view.draws = GEOMETRY.filter((geometry) => view.kind === 0 || !geometry.shadedOnly).map((geometry) => ({
      geometry,
      drawable: draw(gpu, {
        shader: view.source,
        label: `${geometry.name}-view-${view.kind}`,
        entry: { vertex: geometry.vertex, fragment: view.fragment },
        constants: view.kind === 0
          ? { VIEW: view.kind, CURVE_SAMPLES, GRAIN_EXTENT, GRAIN_SLOPE_RANGE }
          : { VIEW: view.kind, CURVE_SAMPLES },
        vertices: geometry.vertices,
        instances: geometry.instances,
        // Occluders render both faces so a leaf edge-on to the light still casts.
        cull: "none",
        ...(view.kind === 0 && geometry.restingBias ? { depth: { bias: 1500, biasSlopeScale: 2 } } : {}),
      }),
    }));
  }
  // Each draw is sized to what the open book has: turning leaves, the leaves
  // of the fuller stack, ring loops, staples. The shaders hide anything past
  // those counts, so the full-size draws only cost vertex work.
  const callCounts = (name) => {
    switch (name) {
      case "leaf": return { instances: model.turning.length };
      case "stack-ends": {
        const fuller = Math.max(model.leftCount, model.leafCount - model.rightStart);
        return { vertices: fuller === 0 ? 0 : 6 * (fuller + 1) * (CURVE_SAMPLES - 1) };
      }
      case "rings": return { instances: ringLoops(model) };
      case "staples": return { instances: model.type.binding === "saddle" ? 6 : 0 };
      default: return null;
    }
  };
  const present = effect(gpu, `
    @group(0) @binding(0) var image: texture_2d<f32>;
    @group(0) @binding(1) var imageSampler: sampler;
    fn encode(c: vec3f) -> vec3f { return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308)); }
    @fragment fn fs_main(@location(0) uv: vec2f, @builtin(position) position: vec4f) -> @location(0) vec4f {
      let color = textureSampleLevel(image, imageSampler, uv, 0.0).rgb;
      let noise = fract(sin(dot(position.xy, vec2f(12.9898, 78.233))) * 43758.5453) - 0.5;
      return vec4f(encode(color) + noise / 255.0, 1.0);
    }
  `, { label: "present", set: { image: sceneTarget, imageSampler: sampler(gpu, { minFilter: "nearest", magFilter: "nearest" }) } });

  // ---------------------------------------------------------------- camera and uniforms

  // `pan` shifts the point the camera orbits, in world millimetres.
  const camera = { yaw: 0, pitch: 0.8, distance: 540, pan: [0, 0, 0] };
  const light = { elevation: 40, azimuth: 125 };
  const paper = { tone: "ivory", stock: 1 };
  // A closed book is centred on its cover; an open one on its binding.
  const cameraTarget = () => {
    const across = model.leafAcross / 2 * Math.max(0, Math.cos(model.frontOpening() / 2));
    const height = model.board ? model.hingeHeight : model.blockThickness / 2;
    return toWorld(model, [across, 0, height]).map((value, axis) => value + camera.pan[axis]);
  };
  const cameraBasis = () => {
    const cosinePitch = Math.cos(camera.pitch);
    const center = cameraTarget();
    const eye = [
      center[0] + camera.distance * Math.sin(camera.yaw) * cosinePitch,
      center[1] - camera.distance * Math.cos(camera.yaw) * cosinePitch,
      center[2] + camera.distance * Math.sin(camera.pitch),
    ];
    const forward = normalize(subtract(center, eye));
    const right = normalize(cross(forward, [0, 0, 1]));
    const up = cross(right, forward);
    return { eye, center, forward, right, up };
  };
  const lightDirection = () => {
    const elevation = light.elevation * Math.PI / 180;
    const azimuth = light.azimuth * Math.PI / 180;
    return [Math.cos(elevation) * Math.cos(azimuth), Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation)];
  };
  const sceneUniform = () => {
    const { eye, center } = cameraBasis();
    const [width, height] = output.size;
    const viewProjection = multiply(perspective(FIELD_OF_VIEW, width / height, 20, 5000), lookAt(eye, center, [0, 0, 1]));
    const toLight = lightDirection();
    const lightCenter = [0, 0, 30];
    const lightEye = lightCenter.map((value, axis) => value + toLight[axis] * KEY_MAP_DEPTH / 2);
    const lightUp = Math.abs(toLight[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
    return {
      viewProjection,
      keyLightViewProjection: multiply(orthographic(KEY_MAP_HALF_EXTENT, 1, KEY_MAP_DEPTH), lookAt(lightEye, lightCenter, lightUp)),
      skyViewProjection: multiply(orthographic(SKY_HALF_EXTENT, 0, SKY_TOP), lookAt([0, 0, SKY_TOP], [0, 0, 0], [0, 1, 0])),
      eye: [...eye, 1],
      keyLight: [...toLight, 1.6],
      sky: [SKY_TOP, SKY_TOP, SKY_HALF_EXTENT, 0],
      keyMap: [KEY_MAP_HALF_EXTENT, KEY_MAP_DEPTH - 1, KEY_MAP_SIZE, 0.06],
    };
  };

  let drawQueued = false;
  let lastTime = null;
  // Book frames drawn, for globalThis.example.
  let sceneFrames = 0;
  let mapsModel = null;
  let lastMapsKey = "";
  const render = (time) => {
    drawQueued = false;
    if (!sheetReady) return;
    const moving = model.isActive();
    if (moving) {
      const elapsed = lastTime === null ? 1 / 60 : (time - lastTime) / 1000;
      model.step(elapsed);
      lastTime = time;
    } else {
      lastTime = null;
    }
    model.writeParticles(particleData);
    particles.write(particleData);
    if (model.curves.version !== curvesVersion) {
      curvesVersion = model.writeCurves(curveData);
      curves.write(curveData);
    }
    const sceneValues = sceneUniform();
    const bookValues = bookUniformValues({ model, document: printed, paper, flow: flowUniform() });
    for (const view of views) {
      for (const { drawable } of view.draws) {
        drawable.set({ scene: sceneValues, book: bookValues, particles, curves });
        if (view.kind === 0) {
          drawable.set({ sheet: sheet.created, sheetSampler, keyShadow: keyTarget.depth, shadowSampler, skyDepth: skyTarget.depth, grain, grainSampler,
            flowSheet: flow ? flow.sheet.created : emptyFlowSheet });
        }
      }
    }
    // The key-light and sky maps depend on the book's shape and the light,
    // not on the camera, so orbiting and zooming reuse them.
    const mapsKey = [light.elevation, light.azimuth, model.grammage, model.leftCount, model.rightStart,
      model.board?.angle, model.turning.length].join(" ");
    const redrawMaps = moving || model !== mapsModel || mapsKey !== lastMapsKey;
    mapsModel = model;
    lastMapsKey = mapsKey;
    frame(gpu, (currentFrame) => {
      for (const view of views) {
        if (view.kind !== 0 && !redrawMaps) continue;
        currentFrame.pass({ target: view.target, clear: [0.02, 0.02, 0.02, 1], clearDepth: 1 }, (pass) => {
          for (const { geometry, drawable } of view.draws) {
            const counts = callCounts(geometry.name);
            if (counts === null) pass.draw(drawable);
            else if ((counts.instances ?? 1) > 0 && (counts.vertices ?? 1) > 0) pass.draw(drawable, counts);
          }
        });
      }
      currentFrame.pass(output, present);
    });
    sceneFrames++;
    updateStatus();
    // A page the document moved to: turn one leaf toward it at a time.
    if (navigationTarget !== null && flow && model.turning.length === 0) {
      const firstFace = 2 * firstPageLeaf();
      const leftPage = 2 * model.leftCount - 1 - firstFace;
      const rightPage = 2 * model.rightStart - firstFace;
      const turned = (navigationTarget > rightPage && model.turnForward()) ||
        (navigationTarget < leftPage && model.turnBackward());
      if (!turned) navigationTarget = null;
    }
    if (model.isActive()) requestDraw();
  };
  const requestDraw = () => {
    if (drawQueued || !sheetReady) return;
    drawQueued = true;
    requestAnimationFrame(render);
  };
  output.onResize(() => {
    sceneTarget.resize(output.size);
    present.set({ image: sceneTarget });
    requestDraw();
  });

  // ---------------------------------------------------------------- the edited document

  // Bound in place of the flow sheet while the book prints its own pages.
  const emptyFlowSheet = texture(gpu, { kind: "2d", size: [1, 1], format: "rgba16float", usage: ["texture_binding"], label: "flow-sheet-empty" });
  const firstPageLeaf = () => model.type.pageLeaves[0];
  const flowCapacity = () => {
    const lastPageLeaf = model.leafCount - (model.type.leafCount - model.type.pageLeaves[1]);
    return 2 * (lastPageLeaf - firstPageLeaf() + 1);
  };
  // Asks the flow for the pages the book shows, which it keeps current: the
  // open spread, the turning leaves and the faces they uncover; and for the
  // next leaves on either side, which need only be ready. Returns the faces
  // its cells hold for the book uniform.
  const flowUniform = () => {
    if (!flow) return null;
    const firstFace = 2 * firstPageLeaf();
    const capacity = flowCapacity();
    const left = model.leftCount;
    const right = model.rightStart;
    const toPages = (faces) => [...new Set(faces.map((face) => face - firstFace))].filter((page) => page >= 0 && page < capacity);
    flow.want({
      visible: toPages([
        2 * left - 1, 2 * right,
        ...model.turning.flatMap((leaf) => [2 * leaf.index, 2 * leaf.index + 1, 2 * leaf.index - 1, 2 * leaf.index + 2]),
      ]),
      prefetch: toPages([2 * right + 1, 2 * right + 2, 2 * left - 2, 2 * left - 3, 2 * right + 3, 2 * right + 4]),
    });
    return {
      faces: flow.cellContents().map((page) => page < 0 || page >= capacity ? -1 : page + firstFace),
      grid: [1 / flow.columns, 1 / flow.rows, flow.columns, 0],
    };
  };
  const updateFlowStatus = () => {
    const line = control("flow-status");
    let text;
    line.toggleAttribute("data-error", Boolean(flow?.error));
    if (!flow) {
      text = "Choose the document in the editor to print it across the book's numbered pages.";
    } else if (flow.error) {
      text = `The document failed to lay out: ${flow.error.message}`;
    } else {
      const count = flow.pages.length;
      const capacity = flowCapacity();
      const rasters = flow.timings.pages;
      const raster = rasters.length === 0 ? "" : `, ${rasters.length} rasterized, the last in ${rasters.at(-1).toFixed(0)} ms`;
      const layout = `laid out in ${flow.timings.layout.toFixed(0)} ms${raster}`;
      text = count > capacity
        ? `The document runs to ${count} pages and the book holds ${capacity}; pages ${capacity + 1} to ${count} are not printed. ${layout}.`
        : `${count} ${count === 1 ? "page" : "pages"}, ${layout}.`;
    }
    if (line.textContent !== text) line.textContent = text;
  };
  const editedContent = () => ({ html: control("content-html").value, css: control("content-css").value });
  let flowInput = null;
  // Flows opened: one live surface each. Loading another document into the
  // editor replaces the content of the open flow and leaves this alone.
  let flowsOpened = 0;
  const closeFlow = async () => {
    const closing = flow;
    flow = null;
    flowInput?.dispose();
    flowInput = null;
    updateFlowStatus();
    requestDraw();
    await closing?.shutdown();
  };
  const openFlow = () => {
    const { pageWidth, pageHeight } = printedPageSize(model.type);
    try {
      flow = new PageFlow({
        device: gpu.gpu, createSheet, createRenderSurface, createSceneRenderer, createSandomDOM, createInputWindow, DOMParser,
        pageWidth, pageHeight, deviceScale: DEVICE_SCALE,
        onChange: () => {
          updateFlowStatus();
          requestDraw();
        },
        onNavigate: (page) => {
          navigationTarget = page;
          requestDraw();
        },
      });
    } catch (error) {
      const line = control("flow-status");
      line.toggleAttribute("data-error", true);
      line.textContent = `The editor cannot print into this book: ${error.message}`;
      throw error;
    }
    flowsOpened++;
    flow.setContent(editedContent());
    flow.interact();
    // A point in a resting page's text block goes to the document; the
    // margins, the fore edge and everything else stay with the book. The
    // input sink follows the caret on the printed page, so the browser's
    // composition window opens there.
    flowInput = bindProjectedInput({
      host: canvas,
      backend: flow.backend,
      root: flow.root,
      project: (event, { target }) => flowPoint(event, target !== null),
      unproject: flowClientPoint,
      claimWheel: () => true,
      // Page Down and Page Up turn the book even while a field has the keyboard.
      claimKey: (event) => {
        if (event.key !== "PageDown" && event.key !== "PageUp") return false;
        if (event.type === "keydown") (event.key === "PageDown" ? turnForward : turnBackward)();
        return true;
      },
      // The binding asks again with no event when the pointer leaves.
      cursor: (point, event) => point === null && event ? hostCursor(event) : null,
      label: "Printed document input",
    });
  };
  const loadDocument = (html, css) => {
    control("content-html").value = html;
    control("content-css").value = css;
    onEdit();
  };
  control("content-html").value = ESSAY_HTML;
  control("content-css").value = ESSAY_CSS;
  control("content-source").addEventListener("change", async (event) => {
    await closeFlow();
    if (event.target.value === "editor") openFlow();
  });
  // Every edit, and every document loaded into the editor, goes into the
  // open flow: `setContent` replaces the body and style sheet of its live
  // document. The flow's surface, renderer, glyph caches, GPU targets, page
  // sheet and input binding stay, so a different document costs its own
  // layout and the pages in view, not a new engine. The flow lays out once
  // for however many edits arrived during the layout before.
  const onEdit = () => {
    if (flow) {
      flow.setContent(editedContent());
      return;
    }
    control("content-source").value = "editor";
    openFlow();
  };
  control("content-html").addEventListener("input", onEdit);
  control("content-css").addEventListener("input", onEdit);
  control("load-essay").addEventListener("click", () => loadDocument(ESSAY_HTML, ESSAY_CSS));
  control("load-website").addEventListener("click", () => loadDocument(WEBSITE_HTML, WEBSITE_CSS));

  // ---------------------------------------------------------------- choosing a book

  // Builds the model and prints the book's own document into a fresh sheet.
  const openBook = async (name) => {
    const type = bookType(name);
    sheetReady = false;
    await closeFlow();
    // The old book's Sandom surface finishes any frame it is presenting first.
    await sheetSurface?.shutdown();
    sheet?.created.destroy();
    printed = bookDocument(type);
    model = new BookModel({ type: name });
    curvesVersion = -1;
    paper.tone = type.tone;
    paper.stock = type.stock;
    bakeGrain(paper.stock);
    control("paper-weight").value = String(model.grammage);
    control("paper-stock").value = String(type.stock);
    control("paper-tone").value = type.tone;
    camera.distance = 540 * Math.max(type.leafAcross, type.leafAlong) / 200;
    camera.pan = [0, 0, 0];
    canvas.setAttribute("aria-label", `Three-dimensional ${type.label.toLowerCase()} with turning pages printed by Sandom`);
    const sheetWidth = printed.documentWidth * DEVICE_SCALE;
    const sheetHeight = printed.documentHeight * DEVICE_SCALE;
    const created = createSheet(sheetWidth, sheetHeight);
    sheet = created;
    const documentSource = new DOMParser().parseFromString(printed.source, "text/html");
    sheetSurface = createRenderSurface(documentSource.documentElement, {
      viewportWidth: printed.documentWidth,
      viewportHeight: printed.documentHeight,
      deviceScale: DEVICE_SCALE,
      createPersistentRenderer: (options) => createSceneRenderer({ ...options, graphicsDevice: gpu.gpu }),
      presentFrame: (sandomFrame) => {
        if (sandomFrame.device !== gpu.gpu || !sandomFrame.textureImage?.texture) {
          throw new Error("Sandom frame is not on the book's GPU device");
        }
        const { texture: source, width, height, format } = sandomFrame.textureImage;
        if (width !== sheetWidth || height !== sheetHeight || format !== "rgba16float") {
          throw new Error(`Sandom sheet is ${width}×${height} ${format}; the book expects ${sheetWidth}×${sheetHeight} rgba16float`);
        }
        const encoder = gpu.gpu.createCommandEncoder({ label: "copy-sandom-sheet" });
        encoder.copyTextureToTexture({ texture: source }, { texture: created.created.gpu, mipLevel: 0 }, [width, height, 1]);
        gpu.gpu.queue.submit([encoder.finish()]);
        created.mipmaps();
        requestDraw();
      },
    });
    await sheetSurface.renderNow();
    sheetReady = true;
    lastStatus = "";
    if (control("content-source").value === "editor") openFlow();
    requestDraw();
  };

  // ---------------------------------------------------------------- status

  let lastStatus = "";
  // The face showing at a leaf, as a reader names it.
  const faceName = (leaf, recto) => {
    const type = model.type;
    const firstPage = type.pageLeaves[0];
    const lastPage = model.leafCount - (type.leafCount - type.pageLeaves[1]);
    if (leaf < firstPage) return type.endpapers ? "the front endpaper" : "the inside front cover";
    if (leaf > lastPage) return type.endpapers ? "the back endpaper" : "the inside back cover";
    return `page ${2 * (leaf - firstPage) + (recto ? 1 : 2)}`;
  };
  const updateStatus = () => {
    let text;
    const label = model.type.label.toLowerCase();
    if (model.turning.length > 0) text = "A leaf is turning.";
    else if (model.frontOpening() < Math.PI / 2) text = `The ${label} is closed.`;
    else if (model.rightStart >= model.leafCount) text = `Turned to the back: ${faceName(model.leftCount - 1, false)} faces you.`;
    else if (model.leftCount === 0) text = `The front board is open; ${faceName(model.rightStart, true)} faces you.`;
    else text = `Open at ${faceName(model.leftCount - 1, false)} and ${faceName(model.rightStart, true)}.`;
    if (text !== lastStatus) {
      lastStatus = text;
      status.textContent = text;
    }
    control("paper-weight").disabled = model.turning.length > 0;
  };

  // ---------------------------------------------------------------- pointer: turning leaves, the board, and orbiting

  // A ray from the camera through the pointer, in the binding's frame.
  const rayFor = (event) => {
    const box = canvas.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * 2 - 1;
    const y = 1 - ((event.clientY - box.top) / box.height) * 2;
    const { eye, forward, right, up } = cameraBasis();
    const tangent = Math.tan(FIELD_OF_VIEW / 2);
    const aspect = box.width / box.height;
    const direction = normalize(forward.map((value, axis) =>
      value + x * tangent * aspect * right[axis] + y * tangent * up[axis]));
    return { origin: toBinding(model, eye), direction: toBinding(model, direction) };
  };
  const intersectPlane = (ray, point, normal) => {
    const denominator = dot(ray.direction, normal);
    if (Math.abs(denominator) < 1e-6) return null;
    const distance = dot(subtract(point, ray.origin), normal) / denominator;
    if (distance <= 0) return null;
    return ray.origin.map((value, axis) => value + ray.direction[axis] * distance);
  };

  const ORBIT_PER_PIXEL = 0.006;
  const ORBIT_PER_KEY = 0.1;
  const orbit = (deltaRight, deltaDown) => {
    // Dragging right carries the book right; dragging down tips its far edge toward you.
    camera.yaw -= deltaRight;
    camera.pitch = Math.min(1.5, Math.max(0.2, camera.pitch + deltaDown));
    requestDraw();
  };
  let gesture = null;
  // A pointer on the text block of a resting page of the flowed document,
  // as a surface viewport point; null anywhere else, or while the book is
  // moving. `tracking` follows a pressed gesture past the block's edge. The
  // page position mirrors the shader's (book-shading.wgsl).
  const flowPoint = (event, tracking) => {
    if (!flow || !sheetReady || gesture || model.turning.length > 0) return null;
    const ray = rayFor(event);
    const hit = model.raycast(ray.origin, ray.direction);
    if (hit?.kind !== "stack") return null;
    const recto = hit.side > 0;
    const leaf = recto ? model.rightStart : model.leftCount - 1;
    const page = 2 * leaf + (recto ? 0 : 1) - 2 * firstPageLeaf();
    const across = model.leafAcross;
    const length = model.leafAlong;
    const [x, y] = model.type.orientation === "top"
      ? [hit.y + 0.5 * length, recto ? hit.arc : across - hit.arc]
      : [recto ? hit.arc : across - hit.arc, 0.5 * length - hit.y];
    const point = flow.documentPoint(page, x * PIXELS_PER_MM, y * PIXELS_PER_MM, tracking);
    if (point !== null) flow.focus(page);
    return point;
  };
  // A point on the top face of a resting stack (`side` 1 right, −1 left;
  // `arc` from the binding, `along` the bound edge, in millimetres) as a
  // client point on the canvas; null when it is covered or out of view.
  const stackClientPoint = (side, arc, along) => {
    const point = model.stackPoint(side, arc, along);
    if (point === null) return null;
    // Covered unless the ray from the eye meets the stack at the point first.
    const { eye, forward, right, up } = cameraBasis();
    const origin = toBinding(model, eye);
    const toPoint = subtract(point, origin);
    const distance = Math.sqrt(dot(toPoint, toPoint));
    const hit = model.raycast(origin, toPoint.map((value) => value / distance));
    if (hit?.kind !== "stack" || hit.side !== side || Math.abs(hit.distance - distance) > 0.5) return null;
    // rayFor, inverted.
    const box = canvas.getBoundingClientRect();
    const relative = subtract(toWorld(model, point), eye);
    const depth = dot(relative, forward);
    const tangent = Math.tan(FIELD_OF_VIEW / 2);
    const horizontal = dot(relative, right) / (depth * tangent * box.width / box.height);
    const vertical = dot(relative, up) / (depth * tangent);
    if (!(depth > 0) || Math.abs(horizontal) > 1 || Math.abs(vertical) > 1) return null;
    return { x: box.left + (horizontal + 1) / 2 * box.width, y: box.top + (1 - vertical) / 2 * box.height };
  };
  // The inverse of flowPoint: a surface viewport point of the flowed
  // document as a client point on the canvas, through the page in use, its
  // place on the resting stack and the camera; null unless that page rests
  // on top of its stack with the point uncovered and in view.
  const flowClientPoint = ({ x, y }) => {
    if (!flow || !sheetReady || model.turning.length > 0) return null;
    const onPage = flow.pagePoint(x, y);
    if (onPage === null) return null;
    const recto = onPage.page % 2 === 0;
    const leaf = firstPageLeaf() + Math.floor(onPage.page / 2);
    if (leaf !== (recto ? model.rightStart : model.leftCount - 1)) return null;
    const across = model.leafAcross;
    const length = model.leafAlong;
    const pageX = onPage.x / PIXELS_PER_MM;
    const pageY = onPage.y / PIXELS_PER_MM;
    const [arc, along] = model.type.orientation === "top"
      ? [recto ? pageY : across - pageY, pageX - 0.5 * length]
      : [recto ? pageX : across - pageX, 0.5 * length - pageY];
    return stackClientPoint(recto ? 1 : -1, arc, along);
  };
  // The book's own cursor: a hand over what can be turned, else the table's.
  const hostCursor = (event) => {
    const ray = rayFor(event);
    const hit = model.raycast(ray.origin, ray.direction);
    const grabbable = hit && (hit.kind !== "board" || !model.boardLocked()) &&
      (hit.kind !== "stack" || model.canTurnFrom(hit.side));
    return gesture ? (gesture.kind === "orbit" ? "grabbing" : "pointer") : grabbable ? "pointer" : "grab";
  };
  // Space held turns a drag into a pan; a tap of Space still turns a page.
  const pan = { held: false, moved: false };
  canvas.addEventListener("pointerdown", (event) => {
    if (!sheetReady) return;
    if (pan.held) {
      canvas.setPointerCapture(event.pointerId);
      gesture = { pointer: event.pointerId, kind: "pan", x: event.clientX, y: event.clientY };
      pan.moved = true;
      canvas.style.cursor = "grabbing";
      return;
    }
    if (flowPoint(event, false) !== null) return;
    canvas.setPointerCapture(event.pointerId);
    const ray = rayFor(event);
    const hit = model.raycast(ray.origin, ray.direction);
    const facing = toBinding(model, cameraBasis().forward);
    // A hand turns a page about the binding: the grip moves in the plane
    // across the binding through the grab point, so pointer motion becomes
    // turning rather than dragging the corner along the bound edge. When the
    // view looks almost across that plane, the plane facing the camera is used.
    const turningPlane = Math.abs(facing[1]) > 0.25 ? [0, 1, 0] : facing;
    if (hit?.kind === "board" && model.holdBoard(hit.point)) {
      gesture = { pointer: event.pointerId, kind: "board", point: hit.point, normal: [0, 1, 0] };
    } else if (hit?.kind === "leaf") {
      model.hold(hit.leaf, hit.column, hit.row);
      gesture = { pointer: event.pointerId, kind: "leaf", leaf: hit.leaf, point: hit.point, normal: turningPlane };
    } else if (hit?.kind === "stack" && model.canTurnFrom(hit.side)) {
      const leaf = model.liftFromStack(hit.side, hit.arc, hit.y);
      gesture = { pointer: event.pointerId, kind: "leaf", leaf, point: hit.point, normal: turningPlane };
    } else {
      gesture = { pointer: event.pointerId, kind: "orbit", x: event.clientX, y: event.clientY };
    }
    canvas.style.cursor = gesture.kind === "orbit" ? "grabbing" : "pointer";
    requestDraw();
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!sheetReady) return;
    if (gesture?.pointer !== event.pointerId) {
      if (!gesture && !flow) canvas.style.cursor = hostCursor(event);
      return;
    }
    if (gesture.kind === "pan") {
      // The book follows the pointer: the view centre moves against the drag,
      // by the distance the drag covers at the centre's depth.
      const { right, up } = cameraBasis();
      const worldPerPixel = 2 * camera.distance * Math.tan(FIELD_OF_VIEW / 2) / canvas.getBoundingClientRect().height;
      const deltaX = (event.clientX - gesture.x) * worldPerPixel;
      const deltaY = (event.clientY - gesture.y) * worldPerPixel;
      camera.pan = camera.pan.map((value, axis) => value - right[axis] * deltaX + up[axis] * deltaY);
      gesture.x = event.clientX;
      gesture.y = event.clientY;
      requestDraw();
      return;
    }
    if (gesture.kind === "orbit") {
      orbit((event.clientX - gesture.x) * ORBIT_PER_PIXEL, (event.clientY - gesture.y) * ORBIT_PER_PIXEL);
      gesture.x = event.clientX;
      gesture.y = event.clientY;
      return;
    }
    const point = intersectPlane(rayFor(event), gesture.point, gesture.normal);
    if (!point) return;
    if (gesture.kind === "board") model.moveBoardHand(point);
    else model.moveLeafHand(gesture.leaf, point);
    requestDraw();
  });
  const endGesture = (event) => {
    if (gesture?.pointer !== event.pointerId) return;
    model.release();
    gesture = null;
    canvas.style.cursor = "grab";
    requestDraw();
  };
  canvas.addEventListener("pointerup", endGesture);
  canvas.addEventListener("pointercancel", endGesture);
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    camera.distance = Math.max(160, Math.min(1400, camera.distance * Math.exp(event.deltaY * 0.001)));
    requestDraw();
  }, { passive: false });

  const turnForward = () => {
    if (!sheetReady || !model.turnForward()) return;
    requestDraw();
  };
  const turnBackward = () => {
    if (!sheetReady || !model.turnBackward()) return;
    requestDraw();
  };
  canvas.addEventListener("keydown", (event) => {
    const orbitKeys = {
      ArrowRight: [ORBIT_PER_KEY, 0], ArrowLeft: [-ORBIT_PER_KEY, 0],
      ArrowDown: [0, ORBIT_PER_KEY], ArrowUp: [0, -ORBIT_PER_KEY],
    };
    if (event.key in orbitKeys) {
      event.preventDefault();
      orbit(...orbitKeys[event.key]);
    } else if (event.key === " ") {
      event.preventDefault();
      if (event.repeat) return;
      pan.held = true;
      pan.moved = false;
      canvas.style.cursor = "grab";
    } else if (event.key === "PageDown") {
      event.preventDefault();
      turnForward();
    } else if (event.key === "PageUp") {
      event.preventDefault();
      turnBackward();
    }
  });
  const releaseSpace = () => {
    if (!pan.held) return;
    pan.held = false;
    if (!pan.moved) turnForward();
  };
  canvas.addEventListener("keyup", (event) => {
    if (event.key === " ") releaseSpace();
  });
  canvas.addEventListener("blur", () => { pan.held = false; });
  control("next").addEventListener("click", turnForward);
  control("previous").addEventListener("click", turnBackward);

  // ---------------------------------------------------------------- controls

  const updateLight = () => {
    light.elevation = Number(control("elevation").value);
    light.azimuth = Number(control("azimuth").value);
    control("elevation-value").textContent = `${light.elevation}°`;
    control("azimuth-value").textContent = `${light.azimuth}°`;
    requestDraw();
  };
  for (const identifier of ["elevation", "azimuth"]) control(identifier).addEventListener("input", updateLight);
  control("paper-tone").addEventListener("input", () => { paper.tone = control("paper-tone").value; requestDraw(); });
  control("paper-stock").addEventListener("input", () => { paper.stock = Number(control("paper-stock").value); bakeGrain(paper.stock); requestDraw(); });
  control("paper-weight").addEventListener("input", () => {
    model.setGrammage(Number(control("paper-weight").value));
    curvesVersion = -1;
    requestDraw();
  });
  // Books open one at a time, in the order chosen. A choice is committed by
  // the select's change event, whether a person or a script makes it.
  let opening = Promise.resolve();
  control("book-type").addEventListener("change", () => {
    const name = control("book-type").value;
    gesture = null;
    opening = opening.then(() => openBook(name)).catch((error) => {
      status.textContent = `Book failed: ${error.message}`;
      console.error(error);
    });
  });
  updateLight();

  await openBook(control("book-type").value);

  addEventListener("pagehide", () => {
    sheetSurface?.shutdown();
    flow?.shutdown();
    gpu.dispose();
  }, { once: true });
  // Leaving the page releases the GPU device, so a page the browser restores
  // from its back/forward cache has nothing to draw with; load it afresh.
  addEventListener("pageshow", (event) => {
    if (event.persisted) location.reload();
  });

  // Read-only state, read by automation and handy in the console: the open
  // spread, the flowed document's pages and its surface's counters, and the
  // projections from the printed page and the stacks to client points.
  const flowElement = (selector) => flow?.document.querySelector(selector) ?? null;
  globalThis.example = Object.freeze({
    get ready() {
      return sheetReady && sceneFrames > 0;
    },
    get sceneFrames() {
      return sceneFrames;
    },
    get status() {
      return status.textContent;
    },
    get book() {
      return {
        type: model.type.name,
        leftCount: model.leftCount,
        rightStart: model.rightStart,
        // Radians the front cover stands open: 0 closed, π flat open.
        frontOpening: model.frontOpening(),
        turning: model.turning.length,
        moving: model.isActive(),
        leafAcross: model.leafAcross,
        leafAlong: model.leafAlong,
      };
    },
    get flow() {
      if (!flow) return null;
      const { serializations, layoutPasses, retainedCleanFrames, scrollOnlyFrames } = flow.surface.frameStageCounters;
      return {
        opened: flowsOpened,
        pages: flow.pages.length,
        focusPage: flow.focusPage,
        visiblePages: [...flow.visiblePages],
        cells: flow.cellContents(),
        working: flow.working,
        error: flow.error?.message ?? null,
        title: flow.document.querySelector("h1")?.textContent ?? null,
        counters: { serializations, layoutPasses, retainedCleanFrames, scrollOnlyFrames },
      };
    },
    // The printed page holding an element of the flowed document, by its
    // place in the column.
    pageOf(selector) {
      const element = flowElement(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      const middle = flow.scrollTop + (box.top + box.bottom) / 2;
      return flow.pages.findIndex((span) => middle < span.bottom);
    },
    // An element's centre as a client point on the canvas, while its page
    // is the page in use and rests uncovered on its stack.
    clientPointOf(selector) {
      const element = flowElement(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return flowClientPoint({ x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 });
    },
    value(selector) {
      return flowElement(selector)?.value ?? null;
    },
    focusedSelector() {
      const active = flow?.document.activeElement;
      return active?.id ? `#${active.id}` : active?.localName ?? null;
    },
    // A point on a resting stack's top face, as fractions of the leaf
    // across from the binding and along its bound edge from its middle.
    stackClientPoint: (side, acrossFraction, alongFraction) =>
      stackClientPoint(side, acrossFraction * model.leafAcross, alongFraction * model.leafAlong),
  });
} catch (error) {
  status.textContent = `Book failed: ${error.message}`;
  console.error(error);
}
