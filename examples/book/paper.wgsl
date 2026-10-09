// Paper stocks: plain WGSL, prepended to the book's shader sources.
//
// A stock is a colour, a grain height, a roughness range and a sheen. The
// surface is a height field in millimetres of paper; `paperSlope` returns its
// gradient averaged over the pixel's footprint, so fine grain shades the
// surface at every distance instead of vanishing or flickering.

const PAPER_PI = 3.14159265;

fn hash(point: vec2f) -> f32 {
  let p = fract(point * vec2f(0.1031, 0.1030));
  let q = p + dot(p, p.yx + 33.33);
  return fract((q.x + q.y) * q.x);
}

fn valueNoise(point: vec2f) -> f32 {
  let cell = floor(point);
  let fraction = fract(point);
  let blend = fraction * fraction * (3.0 - 2.0 * fraction);
  return mix(
    mix(hash(cell), hash(cell + vec2f(1, 0)), blend.x),
    mix(hash(cell + vec2f(0, 1)), hash(cell + vec2f(1, 1)), blend.x),
    blend.y,
  );
}

fn fbm(start: vec2f, octaves: i32) -> f32 {
  var point = start;
  var sum = 0.0;
  var amplitude = 0.5;
  var norm = 0.0;
  for (var octave = 0; octave < octaves; octave++) {
    sum += amplitude * valueNoise(point);
    norm += amplitude;
    point = point * 2.03 + vec2f(17.1, 9.7);
    amplitude *= 0.5;
  }
  return sum / norm;
}

const STOCK_SMOOTH = 0;
const STOCK_COTTON = 1;
const STOCK_LINEN = 2;
const STOCK_LAID = 3;

struct Stock {
  color: vec3f,        // sRGB
  // Peak-to-peak height of the grain field, in mm. The noise is coarser than
  // real fibres, so this amplitude stands in for their combined slope rather
  // than a measured caliper variation.
  grainHeight: f32,
  roughness: vec2f,
  sheen: f32,
}

fn stock(index: i32) -> Stock {
  switch index {
    case 0: { return Stock(vec3f(0.965, 0.957, 0.937), 0.10, vec2f(0.78, 0.9), 0.15); }
    case 2: { return Stock(vec3f(0.957, 0.945, 0.910), 0.25, vec2f(0.8, 0.95), 0.35); }
    case 3: { return Stock(vec3f(0.961, 0.941, 0.886), 0.25, vec2f(0.8, 0.95), 0.3); }
    default: { return Stock(vec3f(0.953, 0.937, 0.894), 0.30, vec2f(0.82, 0.97), 0.6); }
  }
}

// Paper surface in [0, 1] at a sheet position in millimetres.
fn paperHeight(point: vec2f, index: i32) -> f32 {
  switch index {
    case 0: {
      return 0.6 * fbm(point * 7.0, 4) + 0.4 * fbm(point * 1.5, 3);
    }
    case 2: {
      let wobble = 0.25 * fbm(point * 2.0, 2);
      let warp = 0.5 + 0.5 * sin(2.0 * PAPER_PI * (point.x * 3.6 + wobble));
      let weft = 0.5 + 0.5 * sin(2.0 * PAPER_PI * (point.y * 3.6 - wobble));
      return 0.35 * warp + 0.35 * weft + 0.3 * fbm(point * 6.0, 3);
    }
    case 3: {
      let laidLine = 0.5 + 0.5 * sin(2.0 * PAPER_PI * point.y * 1.15);
      let chainOffset = fract(point.x / 24.0) * 24.0 - 12.0;
      let chainLine = exp(-(chainOffset * chainOffset) / 0.08);
      return 0.45 * laidLine + 0.35 * chainLine + 0.2 * fbm(point * 5.0, 3);
    }
    default: {
      // Cotton: cloudy formation plus stretched noise that reads as fibres.
      let fibers = fbm(vec2f(point.x * 9.0 + point.y * 3.0, point.y * 1.2 - point.x * 0.4), 3);
      return 0.45 * fbm(point * 3.2, 5) + 0.35 * fbm(point * 0.9, 3) + 0.2 * fibers;
    }
  }
}

// Gradient of the grain in mm per mm, scaled by the stock's grain height and
// `scale` (plates that fill or smooth the grain pass less than 1). The
// difference is taken across at least the pixel's footprint, which averages
// grain finer than a pixel instead of aliasing it.
fn paperSlope(point: vec2f, index: i32, footprint: f32, scale: f32) -> vec2f {
  let step = max(0.03, footprint);
  let height = paperHeight(point, index);
  return vec2f(
    paperHeight(point + vec2f(step, 0), index) - height,
    paperHeight(point + vec2f(0, step), index) - height,
  ) * stock(index).grainHeight * scale / step;
}

// Large-scale formation: the cloudiness seen by transmitted light.
fn formation(point: vec2f) -> f32 {
  return fbm(point * 0.28 + vec2f(3.1, 7.7), 4);
}
