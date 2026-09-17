// Sandom owns BMP framing; @sandom/color supplies generic RGB quantization.
import { transformImageForOutput } from "./color-transform.js";
import { packSignal } from "./packing.js";

export function encodeBMP(descriptor, request) {
  if (request?.format !== "bmp") {
    throw new Error('encodeBMP requires a validated OutputRequest with format "bmp"');
  }
  const { pixels } = transformImageForOutput(descriptor, request);
  const { width, height } = descriptor;
  const rgb = packSignal(pixels, 8, 3);
  const stride = (width * 3 + 3) & ~3;
  const size = 54 + stride * height;
  const output = new Uint8Array(size);
  const view = new DataView(output.buffer);
  view.setUint16(0, 0x4d42, true);
  view.setUint32(2, size, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setUint32(18, width, true);
  view.setUint32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, stride * height, true);
  view.setUint32(38, 2835, true);
  view.setUint32(42, 2835, true);
  for (let y = 0; y < height; y++) {
    const source = (height - 1 - y) * width * 3;
    const destination = 54 + y * stride;
    for (let x = 0; x < width; x++) {
      const from = source + x * 3;
      const to = destination + x * 3;
      output[to] = rgb[from + 2];
      output[to + 1] = rgb[from + 1];
      output[to + 2] = rgb[from];
    }
  }
  return output;
}
