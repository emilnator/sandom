// Sandom owns PPM framing; @sandom/color supplies generic RGB quantization.
import { transformImageForOutput } from "./color-transform.js";
import { packSignal } from "./packing.js";

export function encodePPM(descriptor, request) {
  if (request?.format !== "ppm") {
    throw new Error('encodePPM requires a validated OutputRequest with format "ppm"');
  }
  const { pixels } = transformImageForOutput(descriptor, request);
  const header = new TextEncoder().encode(`P6\n${descriptor.width} ${descriptor.height}\n255\n`);
  const rgb = packSignal(pixels, 8, 3);
  const output = new Uint8Array(header.byteLength + rgb.byteLength);
  output.set(header);
  output.set(rgb, header.byteLength);
  return output;
}
