/**
 * WebP decoder — bytes to RGBA8 pixels.
 *
 * Same shape and same reasoning as src/jpeg.js: WebP is a real codec (VP8
 * for lossy, an entirely separate VP8L for lossless), so it is vendored
 * rather than hand-written — vendor/webp.wasm, built from
 * vendor/webp-wasm-rs/ (image-webp behind a thin shim, see its build.sh).
 *
 * Returns the same { width, height, pixels } shape decodePNG and
 * decodeJPEG do, so the image pipeline branches on format exactly once
 * (decodeImage in src/jpeg.js) and nowhere downstream.
 *
 * NOT related to src/output/webp.js, which is an animation ENCODER. They
 * share a name and nothing else; the plan (plans/PLAN-native-image-support.md
 * N2) calls out keeping them apart explicitly.
 */

import { srgbRgba8ImageDescriptor } from './image-data.js';
import { readBinaryFile } from './host.js';

// The module imports NOTHING (verified: WebAssembly.Module.imports() is
// empty) even though it is a std build, so instantiation takes no imports
// and there is no __wasm_call_ctors to run — same as vendor/jpeg.wasm.
export function createWebPDecoder({ webpBytes, getWebPBytes = null } = {}) {
let webpInstance = null;

async function ensureWebp() {
  if (webpInstance) return webpInstance;

  const wasmBytes = getWebPBytes
    ? await getWebPBytes()
    : webpBytes ??
      await readBinaryFile(new URL('../vendor/webp.wasm', import.meta.url));

  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  webpInstance = instance;
  return instance;
}

// Mirrors the shim's return codes (vendor/webp-wasm-rs/src/lib.rs). -4 is
// the one that is not a failure of the file: an animated WebP is a valid
// image this slice deliberately does not handle, so its message says so
// and names the frame count rather than reading as corruption.
const DECODE_ERRORS = {
  '-1': 'internal error: decode() called before alloc()',
  '-2': 'not a decodable WebP (truncated, corrupt, or an unsupported variant)',
  '-3': 'internal error: decoder returned a buffer that is neither width*height*3 nor *4',
};

/**
 * Decodes a still WebP — lossy (VP8) or lossless (VP8L), with or without
 * alpha — to RGBA8.
 *
 * Throws on an animated WebP naming its frame count. That is the ground
 * rule from plans/PLAN-native-image-support.md: rendering frame 1 of an
 * animation as though it were a still is the half-support the plan
 * forbids, and animation belongs to Slice N4.
 */
async function decodeWebP(bytes) {
  const wasm = await ensureWebp();
  const { alloc, decode, width, height, pixels, frames, release, memory } = wasm.exports;

  const inputPtr = alloc(bytes.length);
  new Uint8Array(memory.buffer, inputPtr, bytes.length).set(bytes);

  const status = decode();
  if (status !== 0) {
    const frameCount = status === -4 ? frames() : 0;
    release();
    if (status === -4) {
      throw new Error(`decodeWebP: animated WebP (${frameCount} frames) is not supported — animation is Slice N4 of plans/PLAN-native-image-support.md, and decoding frame 1 as a still would be silently wrong`);
    }
    throw new Error(`decodeWebP failed (${status}): ${DECODE_ERRORS[String(status)] ?? 'unknown decoder status'}`);
  }

  const w = width();
  const h = height();
  // Copied out, not viewed in place: the returned pixels outlive release()
  // below, and any later decode's alloc can grow (and therefore detach)
  // this memory's backing buffer.
  const out = new Uint8Array(new Uint8Array(memory.buffer, pixels(), w * h * 4));
  release();

  // No ICC/EXIF pass here, unlike decodeJPEG. WebP CAN carry both in
  // optional chunks, and this decoder ignores them — see the slice notes
  // in plans/PLAN-native-image-support.md rather than assuming it is handled.
  return srgbRgba8ImageDescriptor(w, h, out);
}

  return Object.freeze({
    decodeWebP,
    instanceIdentity() {
      return webpInstance;
    },
  });
}

const defaultWebPDecoder = createWebPDecoder();

export const decodeWebP = (...arguments_) =>
  defaultWebPDecoder.decodeWebP(...arguments_);
