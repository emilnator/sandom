// Text streaming demo — proves text (HarfBuzz shaping + MSDF atlas) renders
// through the full encode → WebSocket → MSE pipeline.
//
// SEPARATE from server.js on purpose: the rect demo drives the layout-node
// session (WASM emit_commands, rect-only). Text needs hand-written CMD_TEXT
// commands plus an atlas/glyphBuffer passed to render(), which the session
// doesn't expose — so this demo drives render() directly. It reuses the general
// pieces (live encoder, mp4 demux via the encoder, the streaming transport) and
// leaves the working rect demo untouched.
//
// Run: deno run --allow-all src/stream/text-server.js  → http://localhost:9401

import { createRenderContext, render } from '../rasterize.js';
import { readFontMetrics } from '../font-metrics.js';
import { shapeText } from '../shaping.js';
import { getDefaultGlyphResourceManager } from '../glyph-resource-manager.js';
import { createLiveEncoder } from './encoder.js';
import { createSegmentQueue } from './server.js';
import {
  CMD_TEXT, CMD_TEXT_SIZE,
  CMD_TEXT_OFFSET_FLAGS, CMD_TEXT_OFFSET_GCOUNT, CMD_TEXT_OFFSET_GOFF,
  CMD_TEXT_OFFSET_X, CMD_TEXT_OFFSET_Y, CMD_TEXT_OFFSET_FSIZE,
  CMD_TEXT_OFFSET_LH, CMD_TEXT_OFFSET_BL, CMD_TEXT_OFFSET_COLOR,
  CMD_TEXT_OFFSET_UPEM, CMD_TEXT_OFFSET_FONT, CMD_TEXT_OFFSET_WEIGHT, CMD_TEXT_OFFSET_STYLE,
  GLYPH_ENTRY_SIZE, GLYPH_OFFSET_ID, GLYPH_OFFSET_X_OFFSET, GLYPH_OFFSET_X_ADVANCE,
} from '../wasm/layout.js';
import { writeRect as writeSharedRect } from '../wasm/commands.js';

const MAX_CLIENT_QUEUE_BYTES = 8 * 1024 * 1024;

// Thin adapter over the shared writer (src/wasm/commands.js): this file's
// call sites spell the fill color r/g/b/a rather than fr/fg/fb/fa.
function writeRect(view, off, r) {
  return writeSharedRect(view, off, {
    x: r.x, y: r.y, w: r.w, h: r.h,
    fr: r.r, fg: r.g, fb: r.b, fa: r.a,
  });
}

function writeTextCommand(view, off, o) {
  view.setUint8(off, CMD_TEXT);
  view.setUint8(off + CMD_TEXT_OFFSET_FLAGS, 0);
  view.setUint16(off + CMD_TEXT_OFFSET_GCOUNT, o.glyphCount, true);
  view.setUint32(off + CMD_TEXT_OFFSET_GOFF, o.glyphBufferOffset, true);
  view.setFloat32(off + CMD_TEXT_OFFSET_X, o.x, true);
  view.setFloat32(off + CMD_TEXT_OFFSET_Y, o.y, true);
  view.setFloat32(off + CMD_TEXT_OFFSET_FSIZE, o.fontSize, true);
  view.setFloat32(off + CMD_TEXT_OFFSET_LH, o.lineHeight, true);
  view.setFloat32(off + CMD_TEXT_OFFSET_BL, o.baseline, true);
  view.setFloat32(off + CMD_TEXT_OFFSET_COLOR, o.r, true);
  view.setFloat32(off + CMD_TEXT_OFFSET_COLOR + 4, o.g, true);
  view.setFloat32(off + CMD_TEXT_OFFSET_COLOR + 8, o.b, true);
  view.setFloat32(off + CMD_TEXT_OFFSET_COLOR + 12, o.a, true);
  view.setUint16(off + CMD_TEXT_OFFSET_UPEM, o.upem, true);
  view.setUint16(off + CMD_TEXT_OFFSET_FONT, o.fontIndex, true);
  view.setUint8(off + CMD_TEXT_OFFSET_WEIGHT, o.weight);
  view.setUint8(off + CMD_TEXT_OFFSET_STYLE, 0);
  return CMD_TEXT_SIZE;
}

function writeGlyphs(glyphBuf, offset, shapedGlyphs) {
  const view = new DataView(glyphBuf.buffer, glyphBuf.byteOffset, glyphBuf.byteLength);
  let cursorX = 0;
  for (let i = 0; i < shapedGlyphs.length; i++) {
    const g = shapedGlyphs[i];
    const gOff = offset + i * GLYPH_ENTRY_SIZE;
    view.setUint16(gOff + GLYPH_OFFSET_ID, g.g, true);
    view.setFloat32(gOff + GLYPH_OFFSET_X_OFFSET, cursorX + (g.dx || 0), true);
    view.setFloat32(gOff + GLYPH_OFFSET_X_ADVANCE, g.ax, true);
    cursorX += g.ax;
  }
}

export async function createTextStreamServer(options = {}) {
  const {
    width = 960,
    height = 320,
    fontSize = 64,
    fps = 30,
    paceFps = 30,
    port = 9401,
    hostname = '0.0.0.0',
    tileSize = 64,
    glyphResourceManager = getDefaultGlyphResourceManager(),
    fontBytes,
  } = options;
  if (!(fontBytes instanceof Uint8Array)) {
    throw new TypeError("createTextStreamServer requires fontBytes");
  }

  const columns = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);

  // Build a per-tile dirty flag array covering one or more pixel rects. Pads by
  // a few px so glyph anti-aliasing/overshoot at the edges is fully covered.
  function tileFlagsForRects(rects) {
    const flags = new Uint8Array(columns * rows);
    for (const r of rects) {
      if (!r) continue;
      const x0 = Math.max(0, Math.floor((r.x - 4) / tileSize));
      const y0 = Math.max(0, Math.floor((r.y - 4) / tileSize));
      const x1 = Math.min(columns - 1, Math.floor((r.x + r.w + 4) / tileSize));
      const y1 = Math.min(rows - 1, Math.floor((r.y + r.h + 4) / tileSize));
      for (let row = y0; row <= y1; row++) for (let col = x0; col <= x1; col++) flags[row * columns + col] = 1;
    }
    return flags;
  }

  const metrics = readFontMetrics(fontBytes);
  const context = await createRenderContext({ width, height });
  const generationBackend = {
    kind: context.kind,
    device: context.device,
  };

  const background = { r: 0.07, g: 0.07, b: 0.12, a: 1 };

  // The Sandom-owned manager shares bounded glyph resources with every renderer.
  let lastAtlasSize = '—';

  // The text line's pixel bbox as last rendered, so a change can dirty the
  // tiles it vacated as well as the tiles it now occupies.
  let prevTextBox = null;
  let firstFrame = true;

  // Render one frame of the given text string, return its RGBA pixels.
  async function renderText(text) {
    const shaped = await shapeText(fontBytes, text, fontSize);
    const glyphLease = await glyphResourceManager.acquire([{
      fontBytes,
      glyphIds: shaped.glyphs.map((glyph) => glyph.g),
      weight: 400,
      opticalSize: fontSize,
      devicePixelSize: fontSize,
    }], { generationBackend });
    const atlas = glyphLease.atlases[0];
    const atlases = new Map([[0, { atlas }]]);
    lastAtlasSize = `${atlas.atlasWidth}x${atlas.atlasHeight}`;

    const fontScale = fontSize / metrics.upem;
    const ascender = metrics.ascender * fontScale;
    const descender = metrics.descender * fontScale;
    const lineHeight = (metrics.ascender - metrics.descender + metrics.lineGap) * fontScale;
    const contentHeight = ascender - descender;
    const baseline = (lineHeight - contentHeight) / 2 + ascender;
    const textY = (height - lineHeight) / 2;
    const textX = 50;

    // Text line width = sum of glyph advances, in pixels.
    let advance = 0;
    for (const g of shaped.glyphs) advance += g.ax;
    const textWidth = advance * fontScale;
    const textBox = { x: textX, y: textY, w: textWidth, h: lineHeight };

    const glyphBuf = new Uint8Array(shaped.glyphs.length * GLYPH_ENTRY_SIZE);
    writeGlyphs(glyphBuf, 0, shaped.glyphs);

    const cmd = new ArrayBuffer(8192);
    const view = new DataView(cmd);
    let off = 0;
    off += writeRect(view, off, { x: 0, y: 0, w: width, h: height, ...background });
    off += writeTextCommand(view, off, {
      glyphCount: shaped.glyphs.length,
      glyphBufferOffset: 0,
      x: textX, y: textY,
      fontSize, lineHeight, baseline,
      r: 0.95, g: 0.95, b: 1.0, a: 1,
      // weight here (×100) MUST match the weight passed to ensureGlyphs (400),
      // because the atlas glyph cache is keyed by weight — a mismatch is a cache
      // miss and every glyph is silently skipped (blank text).
      upem: metrics.upem, fontIndex: 0, weight: 4,
    });

    // First frame: full render (all tiles). After that: only the union of the
    // previous and current text boxes is dirty — old glyphs get cleared to
    // background, new glyphs drawn, the rest of the frame untouched.
    const dirtyTiles = firstFrame ? null : tileFlagsForRects([prevTextBox, textBox]);
    try {
      const frame = await render(context, new DataView(cmd, 0, off), off, {
        background, atlases, glyphBuffer: glyphBuf, dirtyTiles, tileSize,
      });
      firstFrame = false;
      prevTextBox = textBox;
      return { pixels: frame.pixels, dirtyRects: frame.dirtyRects };
    } finally {
      glyphLease.release();
    }
  }

  // One explicit output request per stream (wide-color plan, package 6).
  const encoder = createLiveEncoder({ width, height, fps, outputRequest: { format: 'video' } });
  const clients = new Set();

  function broadcastSegment(seg) { for (const c of clients) c.q.enqueue(seg); }
  function broadcastStats(stats) {
    const text = JSON.stringify({ type: 'stats', ...stats });
    for (const c of clients) if (c.socket.readyState === WebSocket.OPEN) { try { c.socket.send(text); } catch { /* */ } }
  }
  encoder.onSegment((seg) => broadcastSegment(seg));

  // Current text to display, updated by the animation / control messages.
  let currentText = 'sandom streams text';
  let lastEncoded = null;

  async function renderAndEncode() {
    const t0 = performance.now();
    const { pixels, dirtyRects } = await renderText(currentText);
    const renderMs = performance.now() - t0;
    try { await encoder.writeFrame(pixels); } catch { return; }
    broadcastStats({
      text: currentText,
      renderMs: Math.round(renderMs * 100) / 100,
      dirtyTileCount: dirtyRects.length,
      atlasSize: lastAtlasSize,
      glyphs: currentText.length,
      glyphResources: glyphResourceManager.snapshot(),
      width, height,
    });
  }

  // Prime: render the initial text until the encoder has an init segment.
  let initSegment = null;
  {
    let primed = 0;
    const primed0 = await renderText(currentText);
    const primePixels = primed0.pixels;
    while (!encoder.initSegment && primed < 16) {
      await encoder.writeFrame(primePixels);
      primed++;
      await new Promise((r) => setTimeout(r, 4));
    }
    initSegment = encoder.initSegment;
    if (!initSegment) throw new Error('text encoder failed to produce an init segment');
  }

  // Animation: cycle through a few messages + a live clock, re-rendering on the
  // pacer cadence so there's continuous motion to stream.
  const messages = [
    'sandom streams text',
    'MSDF glyphs over WebGPU',
    'shaped with HarfBuzz',
    'encoded by ffmpeg, live',
  ];
  let animating = false;
  let animStartMs = 0;
  let paceTimer = null;

  function tick() {
    if (!animating) { currentText = currentText; }
    else {
      const elapsed = (performance.now() - animStartMs) / 1000;
      const idx = Math.floor(elapsed / 2) % messages.length; // new message every 2s
      const secs = elapsed.toFixed(1);
      currentText = `${messages[idx]}  ·  ${secs}s`;
    }
    renderAndEncode();
  }

  if (paceFps > 0) paceTimer = setInterval(tick, Math.max(1, Math.round(1000 / paceFps)));

  function handleControl(msg) {
    let parsed;
    try { parsed = JSON.parse(msg); } catch { return; }
    if (parsed.type === 'animate') {
      animating = !!parsed.on;
      if (animating) animStartMs = performance.now();
    } else if (parsed.type === 'settext' && typeof parsed.text === 'string') {
      animating = false;
      currentText = parsed.text.slice(0, 80);
    }
  }

  const handler = async (req) => {
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/viewer') {
      const html = await Deno.readTextFile(new URL('./text-viewer.html', import.meta.url));
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, no-cache, must-revalidate' },
      });
    }
    if (url.pathname === '/ws') {
      if (req.headers.get('upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      const { socket, response } = Deno.upgradeWebSocket(req);
      const client = {
        socket,
        q: createSegmentQueue({
          send: (b) => socket.send(b),
          bufferedAmount: () => socket.bufferedAmount,
          isOpen: () => socket.readyState === WebSocket.OPEN,
          maxBytes: MAX_CLIENT_QUEUE_BYTES,
        }),
      };
      socket.onopen = () => {
        clients.add(client);
        socket.send(JSON.stringify({ type: 'init', mimeCodec: encoder.mimeCodec, width, height }));
        socket.send(initSegment);
      };
      socket.onmessage = (e) => { if (typeof e.data === 'string') handleControl(e.data); };
      socket.onclose = () => { try { client.q.close(); } catch { /* */ } clients.delete(client); };
      socket.onerror = () => { try { client.q.close(); } catch { /* */ } clients.delete(client); };
      return response;
    }
    return new Response('not found', { status: 404 });
  };

  // Await the bind (no connect-before-listening race) and capture the real port
  // (port:0 → ephemeral). Same robustness as createStreamServer.
  let boundPort = port;
  let server;
  await new Promise((resolve) => {
    server = Deno.serve({ port, hostname, onListen: (addr) => { boundPort = addr.port; resolve(); } }, handler);
  });

  return {
    get port() { return boundPort; },
    width, height,
    get clientCount() { return clients.size; },
    encoder,
    setAnimating(on) { handleControl(JSON.stringify({ type: 'animate', on })); },
    setText(text) { handleControl(JSON.stringify({ type: 'settext', text })); },
    async shutdown() {
      if (paceTimer !== null) clearInterval(paceTimer);
      for (const c of clients) { try { c.q.close(); c.socket.close(); } catch { /* */ } }
      clients.clear();
      await server.shutdown();
      await server.finished;
      await encoder.stop().catch(() => {});
    },
  };
}

if (import.meta.main) {
  const server = await createTextStreamServer({});
  server.setAnimating(true);
  console.log(`Text stream server on http://localhost:${server.port} (${server.width}x${server.height})`);
  console.log('Open the viewer; Ctrl-C to stop.');
  Deno.addSignalListener('SIGINT', async () => { await server.shutdown(); Deno.exit(0); });
}
