import { validateOutputRequest } from "./image.js";
import { transformImageForOutput } from "./color-transform.js";
import { packSignal } from "./packing.js";

// Animated WebP encoder — RGBA frames to animated .webp file.
// Uses cwebp (per-frame lossless encoding) and webpmux (assembly).
// Frames are piped as PNG through cwebp — no temp files on disk.
//
// NOT the decoder, despite the name: that is src/webp.js, backed by
// vendor/webp.wasm (plans/PLAN-native-image-support.md Slice N2). The two are
// unrelated code and deliberately stayed apart. Note the asymmetry if you
// touch either — decode is self-contained wasm with no imports, while
// this encoder shells out to the cwebp/webpmux BINARIES being on PATH.

import { encodePNG } from './png.js';

export function createWebPRecorder(options) {
  const { width, height, outputRequest } = options;
  if (outputRequest === undefined) {
    throw new Error(
      "createWebPRecorder requires an explicit outputRequest; requests are never inferred",
    );
  }
  // The cwebp/webpmux encoder accepts only standard-dynamic-range sRGB
  // output; a wider request rejects HERE, before any external process
  // starts (validateOutputRequest owns the format contract).
  const validated = validateOutputRequest(outputRequest);
  if (validated.format !== "webp-animation") {
    throw new Error(
      `createWebPRecorder requires format "webp-animation", got "${validated.format}"`,
    );
  }
  const frameDurationMs = validated.codecOptions.frameDuration ?? 33;
  const lossless = validated.codecOptions.lossless ?? true;
  const frames = [];

  return {
    addFrame(frame) {
      // A working render result transforms through the central path; a
      // plain Uint8Array is an already-encoded byte-domain frame.
      if (frame instanceof Uint8Array) {
        frames.push(new Uint8Array(frame));
        return;
      }
      const { pixels } = transformImageForOutput(frame, validated);
      frames.push(packSignal(pixels));
    },

    async finish() {
      const webpFrames = [];

      for (const pixels of frames) {
        const png = await encodePNG(pixels, width, height);
        const webp = await encodeFrameWithCwebp(png, lossless);
        webpFrames.push(webp);
      }

      return assembleAnimated(webpFrames, frameDurationMs);
    },
  };
}

async function encodeFrameWithCwebp(pngBytes, lossless) {
  const args = lossless
    ? ['-lossless', '-z', '0', '-o', '-', '--', '-']
    : ['-q', '90', '-o', '-', '--', '-'];

  const process = new Deno.Command('cwebp', {
    args,
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();

  const writer = process.stdin.getWriter();
  await writer.write(pngBytes);
  await writer.close();

  const { code, stdout, stderr } = await process.output();
  if (code !== 0) {
    throw new Error(`cwebp failed: ${new TextDecoder().decode(stderr)}`);
  }
  return stdout;
}

async function assembleAnimated(webpFrames, frameDurationMs) {
  // Write frames to temp files (webpmux needs file paths).
  const tempDir = await Deno.makeTempDir();
  const framePaths = [];

  try {
    for (let i = 0; i < webpFrames.length; i++) {
      const path = `${tempDir}/frame${i}.webp`;
      await Deno.writeFile(path, webpFrames[i]);
      framePaths.push(path);
    }

    const args = [];
    for (const path of framePaths) {
      args.push('-frame', path, `+${frameDurationMs}+0+0+0-b`);
    }
    args.push('-loop', '0');

    const outputPath = `${tempDir}/output.webp`;
    args.push('-o', outputPath);

    const process = new Deno.Command('webpmux', {
      args,
      stdout: 'piped',
      stderr: 'piped',
    });

    const { code, stderr } = await process.output();
    if (code !== 0) {
      throw new Error(`webpmux failed: ${new TextDecoder().decode(stderr)}`);
    }

    return await Deno.readFile(outputPath);
  } finally {
    for (const path of framePaths) {
      try { await Deno.remove(path); } catch { /* ignore */ }
    }
    try { await Deno.remove(`${tempDir}/output.webp`); } catch { /* ignore */ }
    try { await Deno.remove(tempDir); } catch { /* ignore */ }
  }
}
