// Live stream server — WebSocket fragmented-MP4 streaming to browser clients.
//
// One render session and one ffmpeg encoder are shared by all clients. The
// session renders on mutation (coalesced per microtask); each rendered frame
// is fed to the encoder, which produces an init segment once and a media
// segment per frame thereafter. Connected clients receive the init segment on
// connect, then every media segment as it is produced, plus per-frame stats.
//
// Transport is WebSocket (binary frames for video, text frames for stats), the
// right choice for WAN low-latency: a persistent connection with no per-message
// HTTP overhead, segments pushed the instant they exist. Each client has a
// bounded send queue; if a client falls behind (slow link), the OLDEST queued
// segments are dropped — never frames. The encoder always receives every frame,
// so the encoded stream stays continuous; a lagging client skips ahead to live.

import { createSession } from '../session.js';
import { createLiveEncoder } from './encoder.js';
import { drawOverlay } from '../output/overlay.js';
import { LAYOUT_FLAG_HAS_BACKGROUND } from '../wasm/layout.js';

const DEFAULT_MAX_CLIENT_QUEUE_BYTES = 8 * 1024 * 1024; // drop oldest beyond this backlog

// A bounded outbound segment queue for one client. Decoupled from WebSocket
// (takes a send callback and a bufferedAmount probe) so the drop logic is unit-
// testable without timing-dependent socket behavior. When the backlog would
// exceed maxBytes, the OLDEST queued segments are dropped — the client keeps a
// live stream with gaps rather than stalling the encoder or its peers.
export function createSegmentQueue({ send, bufferedAmount, isOpen, maxBytes }) {
  let queueBytes = 0;
  const queue = [];
  let sending = false;
  let dropped = 0;
  let closed = false;
  // The pending backpressure-wait timer, tracked so close() can cancel it (an
  // uncancelled setTimeout is a leaked async resource — and if the socket never
  // drains, the wait loop would otherwise spin forever spawning timers).
  let waitTimer = null;
  let waitResolve = null;

  function backpressureWait() {
    return new Promise((resolve) => {
      waitResolve = resolve;
      waitTimer = setTimeout(() => { waitTimer = null; waitResolve = null; resolve(); }, 4);
    });
  }

  async function pump() {
    if (sending) return;
    sending = true;
    while (queue.length > 0 && isOpen() && !closed) {
      const buf = queue.shift();
      queueBytes -= buf.byteLength;
      try {
        send(buf);
        // Respect socket backpressure: wait until its buffer drains a bit.
        // Bounded by isOpen()/closed so it can't spin forever.
        while (bufferedAmount() > maxBytes && isOpen() && !closed) {
          await backpressureWait();
        }
      } catch {
        break;
      }
    }
    sending = false;
  }

  return {
    get droppedSegments() { return dropped; },
    get queuedBytes() { return queueBytes; },
    enqueue(segment) {
      if (closed) return;
      // Drop oldest queued segments if this client is backed up.
      while (queueBytes + segment.byteLength > maxBytes && queue.length > 0) {
        const old = queue.shift();
        queueBytes -= old.byteLength;
        dropped++;
      }
      queue.push(segment);
      queueBytes += segment.byteLength;
      pump();
    },
    // Stop the queue: drop pending segments and cancel any in-flight
    // backpressure wait so no async resource outlives the client/server.
    close() {
      closed = true;
      queue.length = 0;
      queueBytes = 0;
      if (waitTimer !== null) { clearTimeout(waitTimer); waitTimer = null; }
      if (waitResolve !== null) { const r = waitResolve; waitResolve = null; r(); }
    },
  };
}

// A scene the mutation controls operate on. Node 0 is the background; node 1 is
// a movable rectangle; node 2 is an "added" rectangle (hidden until added).
function initialScene(width, height) {
  return {
    background: { x: 0, y: 0, width, height, bgR: 0.05, bgG: 0.05, bgB: 0.1, bgA: 1 },
    rect: { x: width * 0.1, y: height * 0.4, width: 120, height: 120, bgR: 0.9, bgG: 0.3, bgB: 0.2, bgA: 1 },
    extra: { present: false, x: width * 0.6, y: height * 0.2, width: 100, height: 100, bgR: 0.2, bgG: 0.7, bgB: 0.9, bgA: 1 },
  };
}

export async function createStreamServer(options = {}) {
  const {
    width = 1280,
    height = 720,
    tileSize = 64,
    fps = 30,
    port = 9400,
    hostname = '0.0.0.0',
    // Output pacing. The session can render far faster than any display or
    // codec wants (the readback pipeline produces frames in bursts — several
    // per GPU poll tick — so raw output is high-fps but temporally clumped,
    // which judders). The pacer samples the LATEST rendered frame on an even
    // cadence and feeds only that to the encoder, dropping intermediate frames
    // (live video wants the freshest state, not a buffered backlog). Set
    // paceFps to a display-sane rate; set 0 to disable pacing (pass every
    // rendered frame straight through — useful for throughput benchmarking).
    paceFps = 60,
    // Per-client outbound backlog cap. A client whose socket can't keep up has
    // its OLDEST queued segments dropped past this, isolating it from peers and
    // the encoder. Configurable mainly so tests can force the drop path.
    maxClientQueueBytes = DEFAULT_MAX_CLIENT_QUEUE_BYTES,
  } = options;

  const session = await createSession({ width, height, tileSize, background: { r: 0.05, g: 0.05, b: 0.1, a: 1 } });
  // One explicit output request per stream (wide-color plan, package 6).
  const encoder = createLiveEncoder({ width, height, fps, outputRequest: { format: 'video' } });

  const scene = initialScene(width, height);

  // Re-emit the whole node tree (emit_commands needs the complete
  // scene). Tile invalidation is fully derived by the engine
  // (design/layout-engine.md): a byte-identical rewrite (the static
  // background) dirties nothing, and a moved rect repaints both its
  // last-PAINTED and current positions — the engine's previous-box
  // mirror advances per emit, which is exactly the "dirty only after a
  // render actually happened" rule the old renderedRect bookkeeping
  // hand-maintained against the sliced-fragment bug.
  function applyScene() {
    session.mutate((_memoryBuffer, h) => {
      h.writeNode(0, { flags: LAYOUT_FLAG_HAS_BACKGROUND, ...scene.background });
      h.writeNode(1, { flags: LAYOUT_FLAG_HAS_BACKGROUND, ...scene.rect });
      if (scene.extra.present) {
        h.writeNode(2, { flags: LAYOUT_FLAG_HAS_BACKGROUND, ...scene.extra });
        h.setNodeCount(3);
      } else {
        // Collapse node 2; the engine dirties its vacated area.
        h.writeNode(2, { flags: 0, x: 0, y: 0, width: 0, height: 0 });
        h.setNodeCount(2);
      }
    });
  }

  // Clients: each has its own WebSocket and a bounded outbound segment queue.
  const clients = new Set();

  function broadcastSegment(segment) {
    for (const client of clients) client.enqueueSegment(segment);
  }

  function broadcastStats(stats) {
    const text = JSON.stringify({ type: 'stats', ...stats });
    for (const client of clients) client.sendText(text);
  }

  // Wire the render → encode path through the pacer.
  //
  // onFrame just stashes the freshest rendered frame (cheap, non-blocking). The
  // pacer (below) decides when to actually encode. This decouples bursty,
  // high-fps production from even, display-rate delivery.
  let lastFrameStats = null;
  let latestFrame = null;        // most recent rendered frame not yet encoded
  let lastEncodedFrameNumber = -1;

  // Diagnostic tile overlay, burned into the video stream when on. Global (one
  // encoder feeds all clients), per the plan — any client toggles it for all.
  let overlayEnabled = false;
  const columns = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);

  // The incremental renderer reports dirtyRects as tile-aligned rects (one per
  // dirty tile). Convert them back to the per-tile boolean array drawOverlay
  // wants, so dirty tiles can flash red.
  function dirtyRectsToTileFlags(dirtyRects) {
    const flags = new Uint8Array(columns * rows);
    for (const r of dirtyRects) {
      const col = Math.floor(r.x / tileSize);
      const row = Math.floor(r.y / tileSize);
      if (col >= 0 && col < columns && row >= 0 && row < rows) {
        flags[row * columns + col] = 1;
      }
    }
    return flags;
  }

  session.onFrame((frame) => {
    // Snapshot pixels: persistentPixels is mutated in place by later frames, so
    // the pacer must capture this frame's bytes now, not hold a live reference.
    latestFrame = { pixels: frame.pixels.slice(), stats: frame.stats };
  });

  async function encodeLatest() {
    if (!latestFrame) return;
    if (latestFrame.stats.frameNumber === lastEncodedFrameNumber) return; // nothing new
    const frame = latestFrame;
    lastEncodedFrameNumber = frame.stats.frameNumber;

    // Burn the diagnostic overlay into this frame's pixels if enabled. Safe to
    // mutate: frame.pixels is this frame's own snapshot (sliced in onFrame),
    // not the live accumulator.
    if (overlayEnabled) {
      drawOverlay(frame.pixels, width, height, {
        tileSize,
        dirtyTiles: dirtyRectsToTileFlags(frame.stats.dirtyRects),
      });
    }

    const encodeStart = performance.now();
    try {
      await encoder.writeFrame(frame.pixels);
    } catch {
      return; // encoder stopped
    }
    // Largest per-client dropped-segment count: surfaces if any viewer is
    // lagging and skipping segments.
    let maxDropped = 0;
    for (const c of clients) if (c.droppedSegments > maxDropped) maxDropped = c.droppedSegments;
    lastFrameStats = {
      ...frame.stats,
      encodeMs: Math.round((performance.now() - encodeStart) * 100) / 100,
      paceFps,
      overlay: overlayEnabled,
      droppedSegments: maxDropped,
      width,
      height,
    };
    broadcastStats(lastFrameStats);
  }

  // Pacer: emit the latest frame on an even cadence. paceFps=0 disables pacing
  // (encode every rendered frame as it arrives — burst-prone, for benchmarking).
  let paceTimer = null;
  if (paceFps > 0) {
    paceTimer = setInterval(encodeLatest, Math.max(1, Math.round(1000 / paceFps)));
  } else {
    session.onFrame(() => { encodeLatest(); });
  }

  encoder.onSegment((segment) => broadcastSegment(segment));

  // Prime the encoder so the init segment exists before any client connects.
  // renderNow delivers the frame through onFrame, which stashes latestFrame.
  applyScene();
  await session.renderNow();
  const primeFrame = latestFrame ? latestFrame.pixels : new Uint8Array(width * height * 4);
  const initSegment = await encoder.start(primeFrame);

  // --- A connected client ---
  function makeClient(socket) {
    const q = createSegmentQueue({
      send: (buf) => socket.send(buf),
      bufferedAmount: () => socket.bufferedAmount,
      isOpen: () => socket.readyState === WebSocket.OPEN,
      maxBytes: maxClientQueueBytes,
    });

    return {
      socket,
      get droppedSegments() { return q.droppedSegments; },

      enqueueSegment(segment) { q.enqueue(segment); },

      sendText(text) {
        if (socket.readyState === WebSocket.OPEN) {
          try { socket.send(text); } catch { /* closing */ }
        }
      },

      sendInit() {
        if (socket.readyState === WebSocket.OPEN) {
          // Tell the client the codec, then hand it the init segment.
          socket.send(JSON.stringify({ type: 'init', mimeCodec: encoder.mimeCodec, width, height }));
          socket.send(initSegment);
        }
      },

      // Release the client's outbound queue (cancels any pending backpressure
      // wait), so a disconnect/shutdown leaves no async resource running.
      close() { q.close(); },
    };
  }

  // --- Server-side scripted animation driver ---
  //
  // Motion is declared once in engine-owned keyframes. The timer supplies only
  // explicit sample time; it never computes or writes animated coordinates.
  // The browser-driven random stress control below remains the one deliberate
  // raw-mutation driver.
  let serverAnimationHandle = null;
  let serverAnimationTimer = null;
  const serverAnimationDuration = (Math.PI * 20 / 1.2) * 1000;
  const serverAnimationKeyframes = Array.from({ length: 281 }, (_, index) => {
    const offset = index / 280;
    const phase = Math.PI * 20 * offset;
    return {
      offset,
      transform: {
        kind: 'transform',
        components: [{
          kind: 'translate',
          x: {
            pixels: (Math.sin(phase) * 0.5 + 0.5) * (width - scene.rect.width) - scene.rect.x,
            percentage: 0,
          },
          y: {
            pixels: (Math.cos(phase * 0.7) * 0.5 + 0.5) * (height - scene.rect.height) - scene.rect.y,
            percentage: 0,
          },
        }],
      },
    };
  });
  function stepServerAnimation() {
    if (!serverAnimationHandle) return;
    session.tick(performance.now());
    serverAnimationTimer = setTimeout(stepServerAnimation, 0);
  }

  function handleControl(msg) {
    let parsed;
    try { parsed = JSON.parse(msg); } catch { return; }

    if (parsed.type === 'animate') {
      if (parsed.on && !serverAnimationHandle) {
        serverAnimationHandle = session.animate(1, serverAnimationKeyframes, {
          duration: serverAnimationDuration,
          iterations: Infinity,
          startTime: performance.now(),
          easing: 'linear',
        });
        stepServerAnimation();
      } else if (!parsed.on && serverAnimationHandle) {
        serverAnimationHandle.cancel();
        serverAnimationHandle = null;
        clearTimeout(serverAnimationTimer);
        serverAnimationTimer = null;
      }
      return;
    }

    if (parsed.type === 'overlay') {
      overlayEnabled = !!parsed.on;
      // Re-render so the overlay (or its removal) shows immediately even
      // if no other mutation is happening — the overlay is drawn onto the
      // delivered copy, so an unchanged base frame is enough.
      applyScene();
      return;
    }

    if (parsed.type !== 'mutate') return;

    switch (parsed.action) {
      case 'move': {
        // Move the rect to an absolute position (clamped to canvas).
        scene.rect.x = Math.max(0, Math.min(width - scene.rect.width, parsed.x ?? scene.rect.x));
        scene.rect.y = Math.max(0, Math.min(height - scene.rect.height, parsed.y ?? scene.rect.y));
        break;
      }
      case 'color': {
        scene.rect.bgR = parsed.r ?? Math.random();
        scene.rect.bgG = parsed.g ?? Math.random();
        scene.rect.bgB = parsed.b ?? Math.random();
        break;
      }
      case 'add': {
        scene.extra.present = true;
        break;
      }
      case 'remove': {
        scene.extra.present = false;
        break;
      }
      default:
        return;
    }
    applyScene();
  }

  const handler = async (req) => {
    const url = new URL(req.url);

    if (url.pathname === '/' || url.pathname === '/viewer') {
      const html = await Deno.readTextFile(new URL('./viewer.html', import.meta.url));
      return new Response(html, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          // Never cache the viewer: it's live dev UI, and a stale cached copy
          // running old JS against a new server caused hours of phantom "stalls".
          'cache-control': 'no-store, no-cache, must-revalidate',
        },
      });
    }

    if (url.pathname === '/ws') {
      if (req.headers.get('upgrade') !== 'websocket') {
        return new Response('expected websocket', { status: 426 });
      }
      const { socket, response } = Deno.upgradeWebSocket(req);
      const client = makeClient(socket);

      socket.onopen = () => {
        clients.add(client);
        client.sendInit();
        if (lastFrameStats) client.sendText(JSON.stringify({ type: 'stats', ...lastFrameStats }));
      };
      socket.onmessage = (e) => {
        if (typeof e.data === 'string') handleControl(e.data);
      };
      socket.onclose = () => { client.close(); clients.delete(client); };
      socket.onerror = () => { client.close(); clients.delete(client); };

      return response;
    }

    return new Response('not found', { status: 404 });
  };

  // Await the actual bind before returning, so a caller (or test) that connects
  // immediately can't lose a race against the OS finishing the listen. Deno.serve
  // binds asynchronously; onListen fires once the socket is accepting. We also
  // capture the REAL bound port, so port:0 (ephemeral) works — the caller reads
  // server.port. Using ephemeral ports in tests avoids fixed-port collisions and
  // TIME_WAIT reuse, the other source of flakiness.
  let boundPort = port;
  let server;
  await new Promise((resolve) => {
    server = Deno.serve({ port, hostname, onListen: (addr) => { boundPort = addr.port; resolve(); } }, handler);
  });

  return {
    get port() { return boundPort; },
    width,
    height,
    get clientCount() { return clients.size; },
    session,
    encoder,
    // Drive a mutation programmatically (used by tests / scripted sequences).
    mutateScene(action, params = {}) { handleControl(JSON.stringify({ type: 'mutate', action, ...params })); },
    // Start/stop the server-side scripted animation (used by tests / scripts).
    setServerAnimation(on) { handleControl(JSON.stringify({ type: 'animate', on })); },
    // Toggle the diagnostic tile overlay burned into the stream.
    setOverlay(on) { handleControl(JSON.stringify({ type: 'overlay', on })); },
    get paceFps() { return paceFps; },
    async shutdown() {
      if (serverAnimationHandle) serverAnimationHandle.cancel();
      serverAnimationHandle = null;
      clearTimeout(serverAnimationTimer);
      clearInterval(paceTimer);
      for (const c of clients) { try { c.close(); c.socket.close(); } catch { /* */ } }
      clients.clear();
      // Stop accepting AND await the server fully finishing (server.finished),
      // so no Deno.serve-internal async op outlives shutdown and bleeds into the
      // next test under the leak sanitizer.
      await server.shutdown();
      await server.finished;
      await session.shutdown().catch(() => {});
      await encoder.stop().catch(() => {});
    },
  };
}

// CLI entrypoint: `deno run --allow-all src/stream/server.js`
if (import.meta.main) {
  const server = await createStreamServer({});
  console.log(`Live stream server on http://localhost:${server.port} (${server.width}x${server.height})`);
  console.log('Open the viewer in a browser; Ctrl-C to stop.');
  Deno.addSignalListener('SIGINT', async () => {
    console.log('\nshutting down…');
    await server.shutdown();
    Deno.exit(0);
  });
}
