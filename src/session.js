const domMeasurementKey = Symbol.for('sandom.domCore.measurement');

// RenderSession — persistent render context with mutation coalescing.
//
// Owns the WASM engine, GPU context, and tile state. Mutations are
// applied via mutate(fn), which writes to the layout buffer directly.
// Mutations within one microtask tick coalesce into a single frame.
//
// Usage:
//   const session = await createSession({ width, height, tileSize });
//   session.mutate((buf, helpers) => { helpers.writeNode(0, { ... }); });
//   session.mutate((buf, helpers) => { helpers.writeNode(1, { ... }); });
//   // Both mutations produce one frame on the next microtask.
//   session.onFrame((frame) => { /* { pixels, dirtyRects, stats } */ });

import { loadEngine } from './wasm/loader.js';
import { createRenderContext, render } from './rasterize.js';
import { createAnimationController } from './animations.js';
import { horizontalOriginAtHigh } from './dom/logical-axes.js';
import {
  COMMAND_BUFFER_BASE,
  HEADER_BASE,
  HEADER_OFFSET_GENERATION,
  LAYOUT_NODE_OFFSET_BG_COLOR,
  LAYOUT_NODE_OFFSET_BORDER_BOTTOM,
  LAYOUT_NODE_OFFSET_BORDER_COLOR_TOP,
  LAYOUT_NODE_OFFSET_BORDER_LEFT,
  LAYOUT_NODE_OFFSET_BORDER_RADIUS_TOP_LEFT,
  LAYOUT_NODE_OFFSET_BORDER_RIGHT,
  LAYOUT_NODE_OFFSET_BORDER_TOP,
  LAYOUT_NODE_OFFSET_CHANGED_GEN,
  LAYOUT_NODE_OFFSET_CHILD_COUNT,
  LAYOUT_NODE_OFFSET_CHILD_OFFSET,
  LAYOUT_NODE_OFFSET_DIRECTION_RTL,
  LAYOUT_NODE_OFFSET_FLAGS,
  LAYOUT_NODE_OFFSET_HEIGHT,
  LAYOUT_NODE_OFFSET_HEIGHT_TAG,
  LAYOUT_NODE_OFFSET_INSET_LEFT,
  LAYOUT_NODE_OFFSET_INSET_LEFT_TAG,
  LAYOUT_NODE_OFFSET_INSET_TOP,
  LAYOUT_NODE_OFFSET_INSET_TOP_TAG,
  LAYOUT_NODE_OFFSET_OPACITY,
  LAYOUT_NODE_OFFSET_OVERFLOW_CLIP_BOX,
  LAYOUT_NODE_OFFSET_OVERFLOW_CLIP_MARGIN,
  LAYOUT_NODE_OFFSET_PADDING_BOTTOM,
  LAYOUT_NODE_OFFSET_PADDING_LEFT,
  LAYOUT_NODE_OFFSET_PADDING_RIGHT,
  LAYOUT_NODE_OFFSET_PADDING_TOP,
  LAYOUT_NODE_OFFSET_POSITION,
  LAYOUT_NODE_OFFSET_SCROLL_LEFT,
  LAYOUT_NODE_OFFSET_SCROLL_TOP,
  LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_X,
  LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_X_PERCENT,
  LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_Y,
  LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_Y_PERCENT,
  LAYOUT_NODE_OFFSET_WIDTH,
  LAYOUT_NODE_OFFSET_WIDTH_TAG,
  LAYOUT_NODE_SIZE,
  LAYOUT_UNIT,
  POSITION_ABSOLUTE,
  SIZE_TAG_LENGTH,
  TILE_CONFIG_BASE,
  TILE_DIRTY_MAP_BASE,
} from './wasm/layout.js';

export async function createSession(options) {
  const {
    width,
    height,
    tileSize = 64,
    background = { r: 0, g: 0, b: 0, a: 0 },
    graphicsBackend = 'auto',
    layoutNodeCapacity = Infinity,
  } = options;
  if (
    layoutNodeCapacity !== Infinity &&
    (!Number.isSafeInteger(layoutNodeCapacity) || layoutNodeCapacity < 1)
  ) {
    throw new RangeError(
      `Layout node capacity must be a positive integer; received ${layoutNodeCapacity}`,
    );
  }

  const engine = await loadEngine();
  // The layout buffer moves when the engine grows its node capacity; its
  // base is re-read after every reservation.
  let layoutBufferBase = engine.exports.layout_buffer_base();
  function ensureNodeCapacity(count) {
    if (count <= engine.exports.node_capacity()) return;
    if (!engine.exports.node_tables_reserve(count)) {
      throw new RangeError(`Node count ${count} exceeds what the engine could allocate`);
    }
    layoutBufferBase = engine.exports.layout_buffer_base();
  }
  // Long-lived view over the shared engine+HarfBuzz memory — re-derived
  // on HarfBuzz heap growth (the one refresh rule, src/wasm/loader.js).
  let engineView = new DataView(engine.memory.buffer);
  engine.onMemoryGrowth(() => {
    engineView = new DataView(engine.memory.buffer);
  });
  const context = await createRenderContext({ width, height, graphicsBackend });

  const columns = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);

  // Write tile config into WASM memory.
  engineView.setUint32(TILE_CONFIG_BASE + 0x00, tileSize, true);
  engineView.setUint32(TILE_CONFIG_BASE + 0x04, columns, true);
  engineView.setUint32(TILE_CONFIG_BASE + 0x08, rows, true);
  engineView.setUint32(TILE_CONFIG_BASE + 0x0C, width, true);
  engineView.setUint32(TILE_CONFIG_BASE + 0x10, height, true);

  let nodeCount = 0;
  let dirty = false;
  let flushTimer = null;
  let stopped = false; // set by shutdown(); gates new work so nothing restarts the pipeline
  // The header is the single generation source shared by JS mutations and
  // engine-side animation ticks.
  engineView.setUint32(HEADER_BASE + HEADER_OFFSET_GENERATION, 1, true);
  let firstFrame = true;
  const frameListeners = [];
  const animationEventListeners = [];
  const animations = createAnimationController(engine, {
    onEvent(event) {
      for (const listener of animationEventListeners) listener(event);
    },
  });

  // Write-if-changed scratch: writeNode assembles a node's style bytes here,
  // then compares against the live node's STYLE range (everything before
  // changedGen). Only on a real difference does it copy the bytes in and stamp
  // changedGen = the current generation. A re-emit of identical style is NOT a
  // change → the intrinsic cache (and future layout/paint caches) hit. The
  // generation is bumped once per mutate() batch (see mutate()).
  const scratch = new Uint8Array(LAYOUT_NODE_SIZE);
  const scratchView = new DataView(scratch.buffer);

  // Node-writing helpers exposed to mutate() callbacks.
  const helpers = {
    // Write a node's bytes into the layout buffer. Tile invalidation is
    // fully derived by the engine (D2/D3, design/layout-engine.md):
    // emit_commands compares each node's box against the previous
    // frame's mirror and its changedGen against the painted watermark,
    // marking old-box ∪ new-box tiles. A byte-identical rewrite stamps
    // nothing and dirties nothing; a moved node repaints both its
    // vacated and occupied areas with no caller bookkeeping.
    // The streaming demos place rects at explicit screen coordinates. Under the
    // style-only struct (Slice 2) that maps to position:absolute with left/top
    // insets and an explicit width/height — i.e. the node's {x,y,width,height}
    // become left/top/width/height of an out-of-flow box laid out against the
    // viewport. Real layout (the WAT pass) then computes the same border box the
    // demos used to write directly. Block-flow trees can instead omit x/y and
    // set children for normal flow.
    writeNode(index, node) {
      if (
        !Number.isSafeInteger(index) || index < 0 || index >= layoutNodeCapacity
      ) {
        throw new RangeError(
          `Node index ${index} exceeds layout capacity ${layoutNodeCapacity}`,
        );
      }
      ensureNodeCapacity(index + 1);
      const base = layoutBufferBase + index * LAYOUT_NODE_SIZE;

      // Assemble the node's style into scratch (zeroed first), exactly as before
      // but into the scratch buffer rather than straight into the live node.
      scratch.fill(0);
      // Preserve the node's child links (childOffset @0x00, childCount @0x04):
      // writeNode does NOT set them — the flush auto-link step does, AFTER this.
      // Copy the live values into scratch so they don't register as a spurious
      // change (and so the write-back below doesn't clobber them). Child links
      // live before FLAGS (0x06), so copy [0, 0x06).
      for (let i = 0; i < LAYOUT_NODE_OFFSET_FLAGS; i++) {
        scratch[i] = engine.bytes[base + i];
      }
      scratchView.setUint16(LAYOUT_NODE_OFFSET_FLAGS, node.flags || 0, true);
      // Absolute placement from x/y (the demo API). left/top = x/y as lengths.
      scratchView.setUint8(LAYOUT_NODE_OFFSET_POSITION, POSITION_ABSOLUTE);
      scratchView.setUint8(LAYOUT_NODE_OFFSET_INSET_LEFT_TAG, SIZE_TAG_LENGTH);
      scratchView.setUint8(LAYOUT_NODE_OFFSET_INSET_TOP_TAG, SIZE_TAG_LENGTH);
      scratchView.setFloat32(LAYOUT_NODE_OFFSET_INSET_LEFT, node.x || 0, true);
      scratchView.setFloat32(LAYOUT_NODE_OFFSET_INSET_TOP, node.y || 0, true);
      // Explicit width/height (lengths). Content-box: matches the old direct
      // border-box derivation (border+padding+content) the demos relied on.
      scratchView.setUint8(LAYOUT_NODE_OFFSET_WIDTH_TAG, SIZE_TAG_LENGTH);
      scratchView.setUint8(LAYOUT_NODE_OFFSET_HEIGHT_TAG, SIZE_TAG_LENGTH);
      scratchView.setFloat32(LAYOUT_NODE_OFFSET_WIDTH, node.width || 0, true);
      scratchView.setFloat32(LAYOUT_NODE_OFFSET_HEIGHT, node.height || 0, true);
      scratchView.setFloat32(
        LAYOUT_NODE_OFFSET_PADDING_TOP,
        node.paddingTop || 0,
        true,
      );
      scratchView.setFloat32(
        LAYOUT_NODE_OFFSET_PADDING_RIGHT,
        node.paddingRight || 0,
        true,
      );
      scratchView.setFloat32(
        LAYOUT_NODE_OFFSET_PADDING_BOTTOM,
        node.paddingBottom || 0,
        true,
      );
      scratchView.setFloat32(
        LAYOUT_NODE_OFFSET_PADDING_LEFT,
        node.paddingLeft || 0,
        true,
      );
      scratchView.setFloat32(
        LAYOUT_NODE_OFFSET_BORDER_TOP,
        node.borderTop || 0,
        true,
      );
      scratchView.setFloat32(
        LAYOUT_NODE_OFFSET_BORDER_RIGHT,
        node.borderRight || 0,
        true,
      );
      scratchView.setFloat32(
        LAYOUT_NODE_OFFSET_BORDER_BOTTOM,
        node.borderBottom || 0,
        true,
      );
      scratchView.setFloat32(
        LAYOUT_NODE_OFFSET_BORDER_LEFT,
        node.borderLeft || 0,
        true,
      );
      scratchView.setFloat32(LAYOUT_NODE_OFFSET_BG_COLOR, node.bgR ?? 0, true);
      scratchView.setFloat32(
        LAYOUT_NODE_OFFSET_BG_COLOR + 4,
        node.bgG ?? 0,
        true,
      );
      scratchView.setFloat32(
        LAYOUT_NODE_OFFSET_BG_COLOR + 8,
        node.bgB ?? 0,
        true,
      );
      scratchView.setFloat32(
        LAYOUT_NODE_OFFSET_BG_COLOR + 12,
        node.bgA ?? 0,
        true,
      );
      // Uniform spec sugar replicated into the per-side/per-corner slots
      // (Slice P2) — this demo-era API has no per-side/per-corner spec form.
      for (let side = 0; side < 4; side++) {
        scratchView.setFloat32(
          LAYOUT_NODE_OFFSET_BORDER_COLOR_TOP + side * 16,
          node.bcR ?? 0,
          true,
        );
        scratchView.setFloat32(
          LAYOUT_NODE_OFFSET_BORDER_COLOR_TOP + side * 16 + 4,
          node.bcG ?? 0,
          true,
        );
        scratchView.setFloat32(
          LAYOUT_NODE_OFFSET_BORDER_COLOR_TOP + side * 16 + 8,
          node.bcB ?? 0,
          true,
        );
        scratchView.setFloat32(
          LAYOUT_NODE_OFFSET_BORDER_COLOR_TOP + side * 16 + 12,
          node.bcA ?? 0,
          true,
        );
      }
      for (let corner = 0; corner < 4; corner++) {
        scratchView.setFloat32(
          LAYOUT_NODE_OFFSET_BORDER_RADIUS_TOP_LEFT + corner * 4,
          node.borderRadius || 0,
          true,
        );
      }
      scratchView.setFloat32(
        LAYOUT_NODE_OFFSET_OPACITY,
        node.opacity ?? 1,
        true,
      );
      scratchView.setInt32(
        LAYOUT_NODE_OFFSET_SCROLL_LEFT,
        Math.round((node.scrollLeft ?? 0) * LAYOUT_UNIT),
        true,
      );
      scratchView.setInt32(
        LAYOUT_NODE_OFFSET_SCROLL_TOP,
        Math.round((node.scrollTop ?? 0) * LAYOUT_UNIT),
        true,
      );
      scratchView.setUint8(
        LAYOUT_NODE_OFFSET_DIRECTION_RTL,
        horizontalOriginAtHigh(node) ? 1 : 0,
      );
      const overflowClipMargin = node.overflowClipMargin ?? {
        visualBox: 'padding-box',
        offset: 0,
      };
      scratchView.setFloat32(
        LAYOUT_NODE_OFFSET_OVERFLOW_CLIP_MARGIN,
        overflowClipMargin.offset,
        true,
      );
      scratchView.setUint8(
        LAYOUT_NODE_OFFSET_OVERFLOW_CLIP_BOX,
        overflowClipMargin.visualBox === 'border-box' ? 1 : overflowClipMargin.visualBox === 'content-box' ? 2 : 0,
      );
      const transformOrigin = node.transformOrigin ?? {
        x: { pixels: 0, percentage: 0.5 },
        y: { pixels: 0, percentage: 0.5 },
      };
      scratchView.setFloat32(
        LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_X,
        transformOrigin.x.pixels ?? 0,
        true,
      );
      scratchView.setFloat32(
        LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_X_PERCENT,
        transformOrigin.x.percentage ?? 0,
        true,
      );
      scratchView.setFloat32(
        LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_Y,
        transformOrigin.y.pixels ?? 0,
        true,
      );
      scratchView.setFloat32(
        LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_Y_PERCENT,
        transformOrigin.y.percentage ?? 0,
        true,
      );

      // Write-if-changed: compare the STYLE range (everything before changedGen)
      // against the live node. Identical → leave the node (and its changedGen)
      // untouched so caches keep hitting. Different → copy the style bytes in and
      // stamp changedGen with the current generation.
      let changed = false;
      for (let i = 0; i < LAYOUT_NODE_OFFSET_CHANGED_GEN; i++) {
        if (engine.bytes[base + i] !== scratch[i]) {
          changed = true;
          break;
        }
      }
      const scrollChanged = engineView.getInt32(base + LAYOUT_NODE_OFFSET_SCROLL_LEFT, true) !==
          scratchView.getInt32(LAYOUT_NODE_OFFSET_SCROLL_LEFT, true) ||
        engineView.getInt32(base + LAYOUT_NODE_OFFSET_SCROLL_TOP, true) !==
          scratchView.getInt32(LAYOUT_NODE_OFFSET_SCROLL_TOP, true);
      const overflowClipChanged = engineView.getFloat32(
            base + LAYOUT_NODE_OFFSET_OVERFLOW_CLIP_MARGIN,
            true,
          ) !==
          scratchView.getFloat32(
            LAYOUT_NODE_OFFSET_OVERFLOW_CLIP_MARGIN,
            true,
          ) ||
        engineView.getUint8(base + LAYOUT_NODE_OFFSET_OVERFLOW_CLIP_BOX) !==
          scratchView.getUint8(LAYOUT_NODE_OFFSET_OVERFLOW_CLIP_BOX);
      const directionChanged = engineView.getUint8(base + LAYOUT_NODE_OFFSET_DIRECTION_RTL) !==
        scratchView.getUint8(LAYOUT_NODE_OFFSET_DIRECTION_RTL);
      const transformOriginChanged = [
        LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_X,
        LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_X_PERCENT,
        LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_Y,
        LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_Y_PERCENT,
      ].some((offset) =>
        engineView.getFloat32(base + offset, true) !==
          scratchView.getFloat32(offset, true)
      );
      if (changed) {
        for (let i = 0; i < LAYOUT_NODE_OFFSET_CHANGED_GEN; i++) {
          engine.bytes[base + i] = scratch[i];
        }
      }
      if (scrollChanged) {
        engineView.setInt32(
          base + LAYOUT_NODE_OFFSET_SCROLL_LEFT,
          scratchView.getInt32(LAYOUT_NODE_OFFSET_SCROLL_LEFT, true),
          true,
        );
        engineView.setInt32(
          base + LAYOUT_NODE_OFFSET_SCROLL_TOP,
          scratchView.getInt32(LAYOUT_NODE_OFFSET_SCROLL_TOP, true),
          true,
        );
      }
      if (overflowClipChanged) {
        engineView.setFloat32(
          base + LAYOUT_NODE_OFFSET_OVERFLOW_CLIP_MARGIN,
          scratchView.getFloat32(LAYOUT_NODE_OFFSET_OVERFLOW_CLIP_MARGIN, true),
          true,
        );
        engineView.setUint8(
          base + LAYOUT_NODE_OFFSET_OVERFLOW_CLIP_BOX,
          scratchView.getUint8(LAYOUT_NODE_OFFSET_OVERFLOW_CLIP_BOX),
        );
      }
      if (directionChanged) {
        engineView.setUint8(
          base + LAYOUT_NODE_OFFSET_DIRECTION_RTL,
          scratchView.getUint8(LAYOUT_NODE_OFFSET_DIRECTION_RTL),
        );
      }
      if (transformOriginChanged) {
        for (
          const offset of [
            LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_X,
            LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_X_PERCENT,
            LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_Y,
            LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_Y_PERCENT,
          ]
        ) {
          engineView.setFloat32(
            base + offset,
            scratchView.getFloat32(offset, true),
            true,
          );
        }
      }
      // Scroll offsets are deliberately EXCLUDED from the generation
      // stamp (D2 piece C): scroll translation is a layout post-pass and
      // the effective offsets are re-clamped every layout() call from
      // requested values, so a scroll-only change must not invalidate the
      // layout cache or the retained command buffer. The engine detects
      // scroll movement from the box drift itself ($deriveTileDirty).
      if (
        changed || overflowClipChanged || directionChanged ||
        transformOriginChanged
      ) {
        engineView.setUint32(
          base + LAYOUT_NODE_OFFSET_CHANGED_GEN,
          engineView.getUint32(HEADER_BASE + HEADER_OFFSET_GENERATION, true),
          true,
        );
      }

      if (index >= nodeCount) nodeCount = index + 1;
    },

    setNodeCount(n) {
      if (!Number.isSafeInteger(n) || n < 0 || n > layoutNodeCapacity) {
        throw new RangeError(
          `Node count ${n} exceeds layout capacity ${layoutNodeCapacity}`,
        );
      }
      ensureNodeCapacity(n);
      nodeCount = n;
    },
  };

  // Pipeline state. The render loop has two phases with different concurrency:
  //
  //   SUBMIT  — emit commands, read+clear the dirty map, encode GPU draws,
  //             submit, start the readback. Touches shared WASM state and the
  //             GPU command stream, so it is SERIALIZED (one at a time).
  //   COLLECT — await the readback's mapAsync (~13ms poll wait in Deno/wgpu)
  //             then copy pixels and deliver the frame. The await must run OFF
  //             the submit path so several readbacks are in flight at once and
  //             resolve together on a poll tick (~2ms amortized vs ~13ms each).
  //
  // Submits run back-to-back without waiting for collects. Pending frames queue
  // in FIFO order; collects await concurrently but the pixel-copy+deliver step
  // is serialized so frames reach listeners in order with a consistent snapshot.
  let submitting = false;
  const pendingFrames = []; // FIFO of { collect, stats } awaiting collection
  let collecting = false;
  // Bound how many frames may be mid-pipeline. MUST be strictly less than the
  // readback ring size: a ring buffer cannot be the target of a new
  // copyTextureToBuffer while a mapAsync on it from the previous cycle is still
  // pending. With maxInFlight == ringSize there is zero slack, so a submit can
  // grab a slot whose prior mapAsync hasn't resolved → the copy/map wedges and
  // the whole pipeline deadlocks (observed: pending=4, collecting stuck true).
  // Keeping one slot free guarantees a fully-cycled buffer is always available.
  const maxInFlight = context.readbackRingSize - 1;

  // Watchdog timeout for a single frame's readback. A healthy mapAsync resolves
  // within ~13ms (the wgpu poll cadence); 1000ms is far beyond any legitimate
  // wait, so it only fires on a genuine wedge, never on normal slowness.
  const COLLECT_TIMEOUT_MS = 1000;
  let collectTimeouts = 0;
  function recordCollectTimeout(frameNumber) {
    collectTimeouts++;
    console.error(
      `[session] readback for frame ${frameNumber} did not resolve within ` +
        `${COLLECT_TIMEOUT_MS}ms — abandoning batch to keep the pipeline alive ` +
        `(total timeouts: ${collectTimeouts}). The GPU readback may be wedged.`,
    );
  }
  // Resolve with the promise's value, or reject if it takes longer than ms.
  function raceTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('collect timeout')), ms);
      promise.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  function scheduleFlush() {
    if (stopped) return; // session shut down; do not restart the pipeline.
    dirty = true;
    if (submitting) return; // a submit is mid-flight; it re-checks dirty.
    if (pendingFrames.length >= maxInFlight) return; // pipeline full; collect drains it.
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (dirty && !submitting && pendingFrames.length < maxInFlight) {
        // Fire-and-forget: surface any submit error rather than letting it
        // become an unhandled rejection (e.g. a copy into a wedged ring slot
        // after a collect watchdog abandoned it).
        flush().catch((err) => console.error(`[session] flush failed: ${err.message}`));
      }
    }, 0);
  }

  async function flush() {
    if (submitting) return;
    submitting = true;
    dirty = false;
    let renderStart;
    try {
      renderStart = performance.now();

      // The layout pass is tree-recursive from node 0. The flat demo API writes
      // node 0 (background) plus independent absolute nodes 1..N-1 with no tree
      // links. Wire them as node 0's children so the pass reaches them — they are
      // absolute (out of flow), so they don't affect node 0's size. Skip if the
      // caller already declared node 0's children (an explicit block-flow tree).
      if (nodeCount > 1) {
        const root = layoutBufferBase;
        if (
          engineView.getUint16(root + LAYOUT_NODE_OFFSET_CHILD_COUNT, true) ===
            0
        ) {
          engineView.setUint32(
            root + LAYOUT_NODE_OFFSET_CHILD_OFFSET,
            layoutBufferBase + LAYOUT_NODE_SIZE,
            true,
          );
          engineView.setUint16(
            root + LAYOUT_NODE_OFFSET_CHILD_COUNT,
            nodeCount - 1,
            true,
          );
        }
      }

      const bytesWritten = engine.exports.emit_commands(nodeCount);
      const cmdView = new DataView(
        engine.memory.buffer,
        COMMAND_BUFFER_BASE,
        bytesWritten,
      );
      const dirtyTiles = firstFrame ? null : readDirtyTiles();

      // SUBMIT phase: draws + readback issued, NOT awaited (deferReadback).
      const pending = await render(context, cmdView, bytesWritten, {
        background,
        dirtyTiles,
        tileSize,
        deferReadback: true,
      });

      engine.exports.clear_tile_dirty_map();
      firstFrame = false;

      pendingFrames.push({
        collect: pending.collect,
        frameNumber: context.frameCount,
        submitMs: Math.round((performance.now() - renderStart) * 100) / 100,
      });
    } finally {
      submitting = false;
    }

    drainCollect();

    // More mutations arrived during submit, or the pipeline has room — keep the
    // submit cadence going independent of collection.
    if (dirty && pendingFrames.length < maxInFlight) scheduleFlush();
  }

  // Drain pending frames. The win is overlapping the poll-bound mapAsync waits:
  // start every queued frame's collect() (each begins its mapAsync) BEFORE
  // awaiting any, so they resolve together on a poll tick. Then await + finish
  // in FIFO order — finish() writes the shared persistent pixel buffer and
  // delivers, so it must run serially and in submission order.
  let collectPromise = null;
  function drainCollect() {
    if (collecting) return collectPromise;
    collectPromise = drainCollectLoop();
    return collectPromise;
  }
  async function drainCollectLoop() {
    if (collecting) return;
    collecting = true;
    try {
      while (pendingFrames.length > 0) {
        // Snapshot the current batch and start all their readback waits at once.
        const batch = pendingFrames.splice(0, pendingFrames.length);
        const started = batch.map((entry) => ({
          entry,
          collectStart: performance.now(),
          promise: entry.collect(), // fires mapAsync; do NOT await yet.
        }));

        for (const { entry, collectStart, promise } of started) {
          // Watchdog: await the readback, but never wait forever. mapAsync is
          // poll-bound (~13ms typical); if one never resolves (driver wedge),
          // awaiting it with no limit would freeze the pipeline permanently
          // (collecting stuck true → slots never freed → renders stop). Race a
          // timeout: on expiry, abandon this batch and break so the loop exits,
          // resets state, and lets the pipeline restart. Abandoning leaves the
          // stuck buffer mapped — its ring slot may error on reuse — but that is
          // a last resort for an already-broken GPU, far better than a freeze.
          let result;
          try {
            result = await raceTimeout(promise, COLLECT_TIMEOUT_MS);
          } catch {
            recordCollectTimeout(entry.frameNumber);
            break; // drop the rest of this batch; finally resets collecting.
          }
          const { finish } = result;
          const collectMs = Math.round((performance.now() - collectStart) * 100) / 100;
          const frame = finish(); // ordered copy + snapshot

          const stats = {
            frameNumber: entry.frameNumber,
            renderMs: entry.submitMs + collectMs,
            submitMs: entry.submitMs,
            collectMs,
            dirtyRects: frame.dirtyRects,
            dirtyTileCount: frame.dirtyRects.length,
            totalTiles: columns * rows,
          };
          for (const listener of frameListeners) {
            listener({
              pixels: frame.pixels,
              width,
              height,
              dirtyRects: frame.dirtyRects,
              stats,
            });
          }

          // A collect freed a ring slot — let a queued mutation submit now.
          if (dirty && !submitting) scheduleFlush();
        }
      }
    } finally {
      collecting = false;
    }
  }

  function readDirtyTiles() {
    const measurement = globalThis[domMeasurementKey];
    const start = measurement ? performance.now() : 0;
    const tiles = new Uint8Array(columns * rows);
    for (let i = 0; i < tiles.length; i++) {
      const byteIdx = i >>> 3;
      const bitIdx = i & 7;
      tiles[i] = (engine.bytes[TILE_DIRTY_MAP_BASE + byteIdx] & (1 << bitIdx)) ? 1 : 0;
    }
    if (measurement) measurement.record({
      category: 'damage', operation: 'dirty-tiles.decode', direction: 'engine-to-host',
      bytes: tiles.length, allocations: 1, allocationBytes: tiles.byteLength,
      milliseconds: performance.now() - start,
    });
    return tiles;
  }

  function scheduleAnimationHandle(handle) {
    return Object.freeze({
      trackIndices: handle.trackIndices,
      cancel() {
        const writeCount = handle.cancel();
        if (writeCount !== 0) scheduleFlush();
        return writeCount;
      },
      pause(time) {
        handle.pause(time);
      },
      resume(time) {
        handle.resume(time);
      },
    });
  }

  return {
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    get frameCount() {
      return context.frameCount;
    },
    get collectTimeouts() {
      return collectTimeouts;
    },

    mutate(fn) {
      // The engine owns the shared generation sequence because animation ticks
      // advance it inside WebAssembly. The guard performs the rare epoch reset
      // before it would publish generation zero.
      engine.exports.advance_generation();
      fn(engineView, helpers);
      scheduleFlush();
    },
    animate(nodeIndex, keyframes, timing) {
      const handle = scheduleAnimationHandle(
        animations.animate(nodeIndex, keyframes, timing),
      );
      scheduleFlush();
      return handle;
    },
    transition(nodeIndex, propertyName, target, timing) {
      const handle = scheduleAnimationHandle(
        animations.transition(nodeIndex, propertyName, target, timing),
      );
      scheduleFlush();
      return handle;
    },
    tick(time) {
      const result = animations.tick(time);
      if (result.writeCount !== 0 || result.transformSampleCount !== 0) {
        scheduleFlush();
      }
      return result;
    },
    onAnimationEvent(callback) {
      animationEventListeners.push(callback);
      return () => {
        const index = animationEventListeners.indexOf(callback);
        if (index >= 0) animationEventListeners.splice(index, 1);
      };
    },

    onFrame(callback) {
      frameListeners.push(callback);
    },

    // Force an immediate render to completion (submit + collect + deliver),
    // bypassing the coalescing timer. Used for priming and scripted/test flows
    // that need the frame in hand right after the call.
    async renderNow() {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      dirty = false;
      await flush(); // submits + kicks drainCollect
      await drainCollect(); // ensure this frame is collected and delivered
    },

    // Stop the session cleanly: cancel the pending flush timer, stop accepting
    // new work, and await any in-flight collect so no GPU readback / timer
    // outlives shutdown (which otherwise leaks async resources — e.g. the
    // mapAsync poll's internal histogram — into whatever runs next).
    async shutdown() {
      stopped = true;
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      dirty = false;
      if (collectPromise) {
        try {
          await collectPromise;
        } catch { /* */ }
      }
    },

    // Direct access for advanced use.
    engine,
    context,
  };
}
