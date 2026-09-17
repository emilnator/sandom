// Diagnostic overlay — draws tile grid and dirty rects on top of rendered pixels.
// Mutates the pixel buffer in place.

export function drawOverlay(pixels, width, height, options) {
  const { tileSize = 64, dirtyTiles = null, gridColor = null, dirtyColor = null, cleanColor = null } = options;

  const gc = gridColor || { r: 100, g: 100, b: 100, a: 80 };
  const dc = dirtyColor || { r: 255, g: 60, b: 60, a: 120 };
  const cc = cleanColor || { r: 60, g: 200, b: 60, a: 40 };

  const columns = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);

  // Draw dirty/clean tile tints.
  if (dirtyTiles) {
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < columns; col++) {
        const tileIdx = row * columns + col;
        const isDirty = dirtyTiles[tileIdx];
        const color = isDirty ? dc : cc;

        const x0 = col * tileSize;
        const y0 = row * tileSize;
        const x1 = Math.min(x0 + tileSize, width);
        const y1 = Math.min(y0 + tileSize, height);

        tintRegion(pixels, width, x0, y0, x1, y1, color);
      }
    }
  }

  // Draw grid lines.
  for (let col = 1; col < columns; col++) {
    const x = col * tileSize;
    if (x < width) drawVerticalLine(pixels, width, height, x, gc);
  }
  for (let row = 1; row < rows; row++) {
    const y = row * tileSize;
    if (y < height) drawHorizontalLine(pixels, width, height, y, gc);
  }

  // Draw dirty tile outlines (thicker, on top of grid).
  if (dirtyTiles) {
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < columns; col++) {
        const tileIdx = row * columns + col;
        if (!dirtyTiles[tileIdx]) continue;

        const x0 = col * tileSize;
        const y0 = row * tileSize;
        const x1 = Math.min(x0 + tileSize - 1, width - 1);
        const y1 = Math.min(y0 + tileSize - 1, height - 1);

        drawRectOutline(pixels, width, height, x0, y0, x1, y1, dc);
      }
    }
  }
}

function blendPixel(pixels, width, x, y, color) {
  // The overlay draws on whichever buffer the stream holds: byte frames
  // use the 0..255 scale, float32 working frames the 0..1 scale.
  const scale = pixels instanceof Float32Array ? 1 / 255 : 1;
  const top = pixels instanceof Float32Array ? 1 : 255;
  const i = (y * width + x) * 4;
  const srcA = color.a / 255;
  const dstA = 1 - srcA;
  const quantize = (value) =>
    pixels instanceof Float32Array ? value : Math.round(value);
  pixels[i] = Math.min(top, quantize(pixels[i] * dstA + color.r * scale * srcA));
  pixels[i + 1] = Math.min(top, quantize(pixels[i + 1] * dstA + color.g * scale * srcA));
  pixels[i + 2] = Math.min(top, quantize(pixels[i + 2] * dstA + color.b * scale * srcA));
  pixels[i + 3] = Math.min(top, quantize(pixels[i + 3] + color.a * scale * (1 - pixels[i + 3] / top)));
}

function tintRegion(pixels, width, x0, y0, x1, y1, color) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      blendPixel(pixels, width, x, y, color);
    }
  }
}

function drawVerticalLine(pixels, width, height, x, color) {
  for (let y = 0; y < height; y++) blendPixel(pixels, width, x, y, color);
}

function drawHorizontalLine(pixels, width, height, y, color) {
  for (let x = 0; x < width; x++) blendPixel(pixels, width, x, y, color);
}

function drawRectOutline(pixels, width, height, x0, y0, x1, y1, color) {
  for (let x = x0; x <= x1; x++) {
    blendPixel(pixels, width, x, y0, color);
    blendPixel(pixels, width, x, y1, color);
  }
  for (let y = y0 + 1; y < y1; y++) {
    blendPixel(pixels, width, x0, y, color);
    blendPixel(pixels, width, x1, y, color);
  }
}
