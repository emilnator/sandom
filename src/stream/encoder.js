// Live H.264 encoder — a persistent ffmpeg subprocess.
//
// Accepts raw RGBA frames via writeFrame(); produces a fragmented MP4 on
// ffmpeg's stdout, which we parse (see mp4box.js) into one initialization
// segment and a stream of media segments suitable for Media Source Extensions.
//
// Encoding runs natively in ffmpeg, not in WASM: real-time H.264 needs speed
// (and ideally hardware acceleration) that a WASM build cannot reach — ffmpeg
// in libx264 ultrafast/zerolatency encodes 720p well under a millisecond per
// frame, with an order of magnitude of headroom over 60fps. This is the same
// reason the file-based video backend shells out to ffmpeg.
//
// Low-latency flags (all measured / sourced, not guessed):
//   -preset ultrafast      minimize CPU per frame
//   -tune zerolatency      disable encoder look-ahead
//   -bf 0                  no B-frames (B-frames add 200-500ms reorder latency)
//   -g 1                   every frame is a keyframe → every fragment is
//                          independently decodable, so a client joining
//                          mid-stream plays from the very next segment
//   -fflags nobuffer       no input buffering
//   -movflags frag_keyframe+empty_moov+default_base_moof
//                          fragmented MP4, playable from byte zero, one
//                          fragment per keyframe (= per frame, given -g 1)
//
// Usage:
//   const enc = createLiveEncoder({ width, height, fps });
//   const init = await enc.init();              // Uint8Array (ftyp+moov), once
//   const off = enc.onSegment(seg => { ... });  // each moof+mdat media segment
//   await enc.writeFrame(rgbaPixels);           // per rendered frame
//   await enc.stop();

import { createMp4Demuxer } from './mp4box.js';
import { quantizeWorkingPixels } from '../output/color-transform.js';
import { validateOutputRequest } from '../output/image.js';

export function createLiveEncoder(options) {
  const { width, height, fps = 30, outputRequest } = options;
  if (outputRequest === undefined) {
    throw new Error(
      'createLiveEncoder requires an explicit outputRequest; one request per stream, never inferred',
    );
  }
  // The live path is a real-time eight-bit H.264 stream: BT.709 standard
  // dynamic range only (validateOutputRequest owns the format contract;
  // hevc/ten-bit belongs to the file recorder, not the zero-latency path).
  const validated = validateOutputRequest(outputRequest);
  if (validated.format !== 'video') {
    throw new Error(`createLiveEncoder requires format "video", got "${validated.format}"`);
  }
  if (validated.dynamicRange !== 'standard' || validated.bitDepth !== 8) {
    throw new Error(
      'createLiveEncoder streams eight-bit standard dynamic range; use createRecorder for high-dynamic-range files',
    );
  }

  // Frames arrive when mutations happen, NOT on a fixed clock — this is a
  // variable-frame-rate live stream. If we declared a fixed input rate (-r N),
  // ffmpeg would stamp every frame N apart in media time regardless of when it
  // actually arrived, so media time would drift away from wall-clock (e.g. 60
  // real frames/sec stamped at 30fps → media runs 2x fast, the player races
  // ahead, drains its buffer, and stutters). Instead, stamp each frame with its
  // real arrival time (-use_wallclock_as_timestamps) and pass those timestamps
  // straight through (-vsync passthrough), so one second of wall-clock input is
  // one second of media. `fps` is kept only as a nominal hint for the muxer.
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-fflags', 'nobuffer+genpts',
    '-use_wallclock_as_timestamps', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`,
    '-i', 'pipe:0',
    '-vsync', 'passthrough',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-bf', '0', '-g', '1', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-colorspace', 'bt709', '-color_range', 'tv',
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  ];

  const process = new Deno.Command('ffmpeg', {
    args,
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();

  const stdinWriter = process.stdin.getWriter();

  let running = true;
  let frameCount = 0;
  let segmentCount = 0;
  let bytesOut = 0;

  let initSegment = null;
  let resolveInit;
  const initPromise = new Promise((resolve) => { resolveInit = resolve; });

  const segmentListeners = new Set();

  const demux = createMp4Demuxer({
    onInit: (init) => {
      initSegment = init;
      resolveInit(init);
    },
    onSegment: (segment) => {
      segmentCount++;
      for (const listener of segmentListeners) listener(segment, segmentCount);
    },
  });

  // Parse ffmpeg stdout into init + media segments.
  const readLoop = (async () => {
    const reader = process.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesOut += value.length;
        demux.push(value);
      }
    } catch (err) {
      if (running) throw err;
      // Reader cancelled during stop() — expected.
    }
  })();

  // Drain stderr so ffmpeg never blocks on a full error pipe; keep it for
  // diagnostics if ffmpeg exits non-zero.
  const stderrChunks = [];
  const errLoop = (async () => {
    const reader = process.stderr.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stderrChunks.push(value);
    }
  })();

  function decodeStderr() {
    let total = 0;
    for (const c of stderrChunks) total += c.length;
    const buf = new Uint8Array(total);
    let o = 0;
    for (const c of stderrChunks) { buf.set(c, o); o += c.length; }
    return new TextDecoder().decode(buf);
  }

  return {
    get running() { return running; },
    get frameCount() { return frameCount; },
    get segmentCount() { return segmentCount; },
    get bytesOut() { return bytesOut; },
    get contentType() { return 'video/mp4'; },
    // MSE codec string for libx264 ultrafast yuv420p output. avc1.42E01F =
    // Baseline profile, level 3.1 — the broadly-compatible default.
    get mimeCodec() { return 'video/mp4; codecs="avc1.42E01F"'; },
    get initSegment() { return initSegment; },

    // Resolves with the init segment (ftyp+moov) once ffmpeg has emitted it.
    // Always await this before streaming media segments to a client.
    init() { return initPromise; },

    // Drive the encoder until the init segment exists, then resolve with it.
    //
    // ffmpeg does not emit ftyp+moov until it commits its first fragment, which
    // takes a few frames of input — so init is simply not available after one
    // frame. The init segment describes only geometry/codec/timescale, not
    // pixels, so priming frames are throwaway: a server primes once at startup
    // (e.g. with the initial scene) so the init segment is cached and ready for
    // every client that later connects, including during idle periods when no
    // mutation is producing frames.
    //
    // primeFrame: a Uint8Array RGBA frame to feed repeatedly until init lands.
    // Bounded so a misconfigured ffmpeg can't hang the caller forever.
    async start(primeFrame, { maxPrimeFrames = 16 } = {}) {
      let primed = 0;
      while (!initSegment && primed < maxPrimeFrames) {
        await this.writeFrame(primeFrame);
        primed++;
        // Yield so the stdout read loop can parse what ffmpeg has flushed.
        await new Promise((r) => setTimeout(r, 4));
      }
      if (!initSegment) {
        await this.stop().catch(() => {});
        throw new Error(`encoder failed to produce an init segment after ${maxPrimeFrames} priming frames`);
      }
      return initSegment;
    },

    onSegment(listener) {
      segmentListeners.add(listener);
      return () => segmentListeners.delete(listener);
    },

    // Write one raw RGBA frame. Awaits the pipe write, which applies natural
    // backpressure if ffmpeg is momentarily behind. Float32 working frames
    // quantize at this byte-domain boundary (rawvideo rgba is 8-bit).
    async writeFrame(pixels) {
      if (!running) throw new Error('encoder stopped');
      await stdinWriter.write(quantizeWorkingPixels(pixels));
      frameCount++;
    },

    async stop() {
      if (!running) return { frameCount, segmentCount, bytesOut };
      running = false;
      try { await stdinWriter.close(); } catch { /* already closed */ }
      await readLoop;
      await errLoop;
      const { code } = await process.status;
      if (code !== 0) {
        throw new Error(`ffmpeg exited with code ${code}: ${decodeStderr()}`);
      }
      return { frameCount, segmentCount, bytesOut };
    },
  };
}
