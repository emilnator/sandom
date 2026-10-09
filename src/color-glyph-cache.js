// The color glyph cache (plans/PLAN-color-glyphs.md slice 3, decision 2).
//
// The engine paints a COLR glyph of axis-aligned, unscaled text as one
// CMD_IMAGE whose index names a cache slot (engine-color-glyph.watpart,
// layout.js COLOR_GLYPH_CACHE_INDEX_BASE): a glyph program at one font size
// and, for a glyph that paints the text color, that color. This module
// gives each slot an entry in an RGBA atlas page for each device scale:
//
//   - prepare (before the frame's raster plan): the slots the frame draws
//     get a place in the device scale's page layout, and each slot's raster
//     image resource names its box in device pixels from the glyph's
//     snapped origin and its texels in the page.
//   - imagesFor (in the frame's render context, before the frame's render):
//     the entries no page texture of that context's backend holds yet are
//     rendered. The engine writes the commands the glyph emits uncached
//     (color_glyph_cache_stream_append), each glyph with its origin on a
//     whole device pixel inside its entry, the commands are rendered into
//     a transparent target the size of the page, and the entries' texels
//     are copied into the page texture.
//
// The raster plan draws an instance as its entry's texels at the device
// pixel the uncached glyph's layers snap their origin to, so the entry
// holds exactly the pixels the glyph's commands paint over transparency at
// that origin's position within a pixel (the origin is whole).
import {
  CMD_IMAGE,
  CMD_IMAGE_FLAG_GLYPH_BITMAP,
  CMD_IMAGE_OFFSET_FLAGS,
  CMD_IMAGE_OFFSET_INDEX,
  COLOR_GLYPH_CACHE_INDEX_BASE,
  COLOR_GLYPH_CACHE_PAGE_INDEX_BASE,
  COLOR_GLYPH_CACHE_RESOURCE_COUNT,
  commandByteSize,
  GRADIENT_STOP_POOL_BASE,
  RASTER_RESOURCE_IMAGE,
} from "./wasm/layout.js";
import {
  createColorGlyphCachePage,
  createRenderContext,
  render,
} from "./rasterize.js";

// Device pixels around an entry's box: a layer's antialiased edge reaches
// half a pixel past its outline; the rest is room for the MSDF distance
// field's own error at the outline.
const ENTRY_MARGIN = 2;
const PAGE_SIZE = 1024;
// A layout that needs more pages starts again with the frame's slots.
const MAX_PAGES = 8;
const TRANSPARENT = Object.freeze({ r: 0, g: 0, b: 0, a: 0 });

export function createColorGlyphCache({
  engine,
  graphicsStateOwner,
  // The path atlas the entries draw their layers from. Not the frame's:
  // a retained raster plan holds texel positions in the frame's atlas,
  // which a rebuild for the entries' paths would move.
  pathAtlas,
  // (view, bytes, deviceScale) => { entries, ensures }: the path atlas
  // entries a command stream draws (scene-renderer.js svgPathEnsures).
  svgPathEnsures,
  // (atlas, pathIndices): writes the paths' raster resources.
  synchronizePathRasterResources,
  // (pathIndices): restores the raster resources of the frame's atlas.
  restorePathRasterResources,
}) {
  // deviceScale -> { generation, pages: [{ width, height, shelves, top }],
  // entries: slot -> entry }. An entry is { page, x, y, width, height, left,
  // top }: its texels in the page and its box from the snapped origin.
  const layouts = new Map();
  let layoutGeneration = 0;
  // slot -> the entry whose records the engine's resource table holds.
  const writtenRecords = new Map();
  // context.shared -> "renderMode deviceScale" -> { generation, pages,
  // rendered: slot -> entry, scratch }.
  const gpuStates = new Map();

  function layoutFor(deviceScale) {
    let layout = layouts.get(deviceScale);
    if (layout === undefined) {
      layout = { generation: ++layoutGeneration, pages: [], entries: new Map() };
      layouts.set(deviceScale, layout);
    }
    return layout;
  }

  // Shelf packing; a box wider or taller than a page gets a page of its own.
  function place(layout, width, height) {
    for (let page = 0; page < layout.pages.length; page++) {
      const shelves = layout.pages[page];
      for (const shelf of shelves.shelves) {
        if (height <= shelf.height && shelf.x + width <= shelves.width) {
          const position = { page, x: shelf.x, y: shelf.y };
          shelf.x += width;
          return position;
        }
      }
      if (shelves.top + height <= shelves.height && width <= shelves.width) {
        shelves.shelves.push({ y: shelves.top, height, x: width });
        const position = { page, x: 0, y: shelves.top };
        shelves.top += height;
        return position;
      }
    }
    if (layout.pages.length === MAX_PAGES) return null;
    layout.pages.push({
      width: Math.max(PAGE_SIZE, width),
      height: Math.max(PAGE_SIZE, height),
      shelves: [{ y: 0, height, x: width }],
      top: height,
    });
    return { page: layout.pages.length - 1, x: 0, y: 0 };
  }

  function allocate(layout, slots, deviceScale) {
    for (const slot of slots) {
      if (layout.entries.has(slot)) continue;
      const box = [0, 1, 2, 3].map((corner) => engine.exports.color_glyph_cache_box(slot, corner));
      const left = Math.floor(box[0] * deviceScale) - ENTRY_MARGIN;
      const top = Math.floor(box[1] * deviceScale) - ENTRY_MARGIN;
      const width = Math.ceil(box[2] * deviceScale) + ENTRY_MARGIN - left;
      const height = Math.ceil(box[3] * deviceScale) + ENTRY_MARGIN - top;
      const position = place(layout, width, height);
      if (position === null) return false;
      layout.entries.set(slot, { ...position, width, height, left, top });
    }
    return true;
  }

  function writeRecords(layout, slot) {
    const entry = layout.entries.get(slot);
    if (writtenRecords.get(slot) === entry) return;
    const imageIndex = COLOR_GLYPH_CACHE_INDEX_BASE + slot;
    const pointer = engine.exports.raster_resource_table_reserve(
      RASTER_RESOURCE_IMAGE,
      imageIndex,
      COLOR_GLYPH_CACHE_RESOURCE_COUNT,
    );
    if (pointer === 0) {
      throw new Error(`color glyph cache: raster image resource ${imageIndex} could not be reserved`);
    }
    const page = layout.pages[entry.page];
    new Float32Array(engine.memory.buffer, pointer, COLOR_GLYPH_CACHE_RESOURCE_COUNT * 3).set([
      page.width,
      page.height,
      0,
      entry.left,
      entry.top,
      entry.width,
      entry.height,
      entry.x,
      entry.y,
      COLOR_GLYPH_CACHE_PAGE_INDEX_BASE + entry.page,
      0,
      0,
    ]);
    writtenRecords.set(slot, entry);
  }

  // The cache slots `view` draws, placed in the layout of `deviceScale`
  // with their resources written; null for a stream without one. The
  // frame's `generation` changes when the layout starts again, which moves
  // entries a retained raster plan has packed.
  function prepare(view, bytes, deviceScale) {
    let slots = null;
    for (let offset = 0; offset < bytes; offset += commandByteSize(view, offset)) {
      if (
        view.getUint8(offset) === CMD_IMAGE &&
        (view.getUint8(offset + CMD_IMAGE_OFFSET_FLAGS) & CMD_IMAGE_FLAG_GLYPH_BITMAP) !== 0
      ) {
        const index = view.getUint16(offset + CMD_IMAGE_OFFSET_INDEX, true);
        if (index >= COLOR_GLYPH_CACHE_INDEX_BASE) (slots ??= new Set()).add(index - COLOR_GLYPH_CACHE_INDEX_BASE);
      }
    }
    if (slots === null) return null;
    const count = engine.exports.color_glyph_cache_count();
    for (const slot of slots) {
      if (slot >= count) {
        throw new Error(
          `CMD_IMAGE names color glyph cache slot ${slot}, but the engine registered ${count}; ` +
            "the command buffer and the engine disagree",
        );
      }
    }
    let layout = layoutFor(deviceScale);
    if (!allocate(layout, slots, deviceScale)) {
      layouts.delete(deviceScale);
      layout = layoutFor(deviceScale);
      if (!allocate(layout, slots, deviceScale)) {
        throw new Error(
          `color glyph cache: the ${slots.size} glyphs of one frame need more than ${MAX_PAGES} pages ` +
            `of ${PAGE_SIZE}x${PAGE_SIZE} device pixels at device scale ${deviceScale}`,
        );
      }
    }
    for (const slot of slots) writeRecords(layout, slot);
    return { deviceScale, layout, slots, generation: layout.generation };
  }

  async function gpuStateFor(context, deviceScale, layout) {
    let byKey = gpuStates.get(context.shared);
    if (byKey === undefined) {
      byKey = new Map();
      gpuStates.set(context.shared, byKey);
    }
    const key = `${context.renderMode ?? "standard"} ${deviceScale}`;
    let state = byKey.get(key);
    if (state !== undefined && state.generation !== layout.generation) {
      await destroyGpuState(state);
      state = undefined;
    }
    if (state === undefined) {
      state = { generation: layout.generation, pages: [], rendered: new Map(), scratch: null };
      byKey.set(key, state);
    }
    return state;
  }

  function destroyGpuState(state) {
    for (const page of state.pages) page.gpu.destroy();
    state.pages.length = 0;
    state.rendered.clear();
    const scratch = state.scratch;
    state.scratch = null;
    return scratch?.destroy();
  }

  async function renderPage(context, state, frame, pageNumber, slots) {
    const { layout, deviceScale } = frame;
    const shelves = layout.pages[pageNumber];
    if (state.scratch !== null &&
      (state.scratch.width < shelves.width || state.scratch.height < shelves.height)) {
      await state.scratch.destroy();
      state.scratch = null;
    }
    state.scratch ??= await createRenderContext({
      width: shelves.width,
      height: shelves.height,
      graphicsBackend: context.kind,
      sharedStateOwner: graphicsStateOwner,
      renderMode: context.renderMode,
      renderPrecision: context.renderPrecision,
    });
    const scratch = state.scratch;
    engine.exports.color_glyph_cache_stream_reset();
    const rects = [];
    for (const slot of slots) {
      const entry = layout.entries.get(slot);
      // The glyph origin on the entry's whole device pixel: the raster
      // plan snaps it there as it snaps the instance's.
      engine.exports.color_glyph_cache_stream_append(
        slot,
        (entry.x - entry.left) / deviceScale,
        (entry.y - entry.top) / deviceScale,
      );
      rects.push(entry);
    }
    const pointer = engine.exports.color_glyph_cache_stream_pointer();
    const length = engine.exports.color_glyph_cache_stream_length();
    if (length > 0) {
      const stream = new DataView(new Uint8Array(engine.memory.buffer, pointer, length).slice().buffer);
      const { entries, ensures } = svgPathEnsures(stream, length, deviceScale);
      const pathIndices = entries.map((entry) => entry.pathIndex);
      await pathAtlas.ensurePaths(ensures);
      pathAtlas.rebuildAtlas();
      synchronizePathRasterResources(pathAtlas, pathIndices);
      let plan;
      try {
        plan = engine.exports.raster_plan_prepare(
          pointer,
          length,
          0,
          scratch.width,
          scratch.height,
          deviceScale,
          context.renderMode === "high-dynamic-range" ? 1 : 0,
          0,
          GRADIENT_STOP_POOL_BASE,
          0,
          0,
          scratch.width / deviceScale,
          scratch.height / deviceScale,
          0,
          0,
        );
      } finally {
        restorePathRasterResources(pathIndices);
      }
      if (plan === 0) {
        throw new Error(`color glyph cache: raster_plan_prepare rejected ${length} command bytes`);
      }
      try {
        await render(scratch, {
          background: TRANSPARENT,
          atlases: new Map(),
          images: new Map(),
          svgPathAtlas: pathAtlas,
          scrollTable: new Float32Array(0),
          deviceScale,
          rasterPlan: { memory: engine.memory, plan, exports: engine.exports },
          readback: "none",
        });
      } finally {
        engine.exports.raster_plan_release(plan);
      }
    }
    // An entry whose glyph appended nothing (its font changed) copies the
    // cleared target: transparent.
    let page = state.pages[pageNumber];
    if (page === undefined) {
      const gpu = createColorGlyphCachePage(context, shelves.width, shelves.height);
      page = {
        gpu,
        image: {
          kind: "color-glyph-cache-page",
          width: shelves.width,
          height: shelves.height,
          texture: gpu.texture,
        },
      };
      state.pages[pageNumber] = page;
    }
    page.gpu.copyFrom(scratch, rects);
    for (const slot of slots) state.rendered.set(slot, layout.entries.get(slot));
  }

  // `images` with the pages of `frame` for `context`, after rendering the
  // entries of the frame's slots the context's pages do not hold.
  async function imagesFor(frame, context, images) {
    const state = await gpuStateFor(context, frame.deviceScale, frame.layout);
    const missing = new Map();
    for (const slot of frame.slots) {
      const entry = frame.layout.entries.get(slot);
      if (state.rendered.get(slot) === entry) continue;
      let slots = missing.get(entry.page);
      if (slots === undefined) missing.set(entry.page, slots = []);
      slots.push(slot);
    }
    for (const [pageNumber, slots] of missing) {
      await renderPage(context, state, frame, pageNumber, slots);
    }
    const frameImages = new Map(images);
    for (let pageNumber = 0; pageNumber < state.pages.length; pageNumber++) {
      const page = state.pages[pageNumber];
      if (page !== undefined) frameImages.set(COLOR_GLYPH_CACHE_PAGE_INDEX_BASE + pageNumber, page.image);
    }
    return frameImages;
  }

  async function release() {
    for (const byKey of gpuStates.values()) {
      for (const state of byKey.values()) await destroyGpuState(state);
    }
    gpuStates.clear();
  }

  return { prepare, imagesFor, release };
}
