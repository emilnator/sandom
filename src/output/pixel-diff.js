import { quantizeWorkingPixels } from "./color-transform.js";

// Canonical RGBA pixel comparison — the SINGLE source of truth for both the
// browser gallery (examples/layout-gallery.js) and the headless parity test
// (test/layout_pixel_test.js). Both import classifyDiff from here so the test
// can never pass while the gallery shows a difference, or vice versa.
//
// Why classify instead of just count: two correct raster engines never agree
// pixel-for-pixel on EDGES — each anti-aliases its own way, so an edge pixel is
// blended slightly differently (empirically Δ ≤ ~40 per channel). That is NOT a
// bug. A STRUCTURAL difference — wrong fill colour, wrong paint order, a missing
// or misplaced box — flips whole regions to a different colour entirely (large
// Δ). So we bucket each pixel by per-channel delta magnitude:
//   Δ ≤ AA_TOL          → identical (same pixel)
//   AA_TOL < Δ < STRUCT → edge anti-aliasing, expected
//   Δ ≥ STRUCT          → structural, a real difference
// Parity passes iff structuralCount === 0.
//
// This module is pure (no DOM, no Deno APIs): it operates on two RGBA byte
// arrays of equal length. The browser supplies pixels via canvas getImageData;
// the test supplies the very same browser-captured pixels (it asks the page to
// run its rasterizer, so the test uses the real browser raster, not a Deno
// reimplementation). Identical inputs + identical classifier ⇒ identical verdict.

// Thresholds. Tuned from measurement, re-checked 2026-07-06 after two
// Slice P1.5 follow-up fixes to rasterize.js's fragmentMain: (1) tightening
// the fill/border SDF antialiasing band, and (2) adding antialiasing to the
// overflow-clip discard, which was previously a hard binary cutoff with NO
// blending at all (a separate bug from the band-width one — see
// design/layout-debugging.md). Both measured directly against
// Chrome: the `border` scene (straight/inner SDF edge) improved maxDelta
// 56→28; the `overflow-cards` scene (rounded CLIP corner, the case the old
// STRUCT=60 was actually sized for) improved maxDelta 98→14, dropping to 0
// structural pixels with no exemption needed at all. The remaining worst
// case is `transform-cards` (rotated/scaled fill edge, a different code
// path, out of scope here) at maxDelta 104-112 — but those pixels are
// covered by the geometric TRANSFORM_EDGE_AA_TOLERANCE exemption, not by
// STRUCT, so they don't constrain this threshold. With the clip fix in
// place, the honest new ceiling for "expected AA disagreement, no
// geometric exemption" is Δ28 (border); STRUCT=40 sits safely above that
// with margin and well below the wrong-fill floor (Δ100+).
export const AA_TOL = 12;
export const STRUCT = 40;
// A real structural difference (wrong fill / paint order / missing box) is a
// REGION — hundreds to thousands of contiguous pixels (the negative control is
// 40112). A handful of scattered pixels at box CORNERS, where two rasterizers'
// corner-coverage anti-aliasing disagrees by just over STRUCT, is not a bug.
// So the pass verdict tolerates up to STRUCT_FLOOR isolated structural pixels;
// anything above that is a genuine divergence. (Corner AA empirically ≤ ~8 px
// per scene; real bugs are 100×+ that.)
export const STRUCT_FLOOR = 24;

// Image-scene structural floor (Slice P5b): bilinear-resampled photo
// content — fill/contain/cover/scale-down all involve sandom's GPU
// sampler and Chrome's Canvas2D/CSS image scaler each rounding a
// resampled pixel slightly differently, which STRUCT_FLOOR's 24 was
// never sized for (it was measured against SDF corner-AA, a completely
// different mechanism). Measured directly (examples/object-fit-demo.js's
// wide-box photo scene, 620x160, 5 modes): 62 scattered structural px,
// maxΔ 47, ALL four resampled modes (fill/contain/cover/scale-down)
// affected, the ONE mode with zero resampling (object-fit:none, a 1:1
// pixel crop with no scaling) measuring EXACTLY 0 — proof this is a
// resampling artifact, not a real rendering bug (confirmed via the
// project's own load-bearing-proof convention: forcing this floor back
// to STRUCT_FLOOR reproduces the exact 62-pixel failure; raising it
// clears it with real headroom, not a blind bump). A true bug (wrong
// crop, wrong position, wrong color) fails by hundreds to thousands of
// contiguous pixels, same as STRUCT_FLOOR's own reasoning — this floor
// is sized with margin above the measured 62, not tuned to just clear it.
export const IMAGE_STRUCT_FLOOR = 100;

// Max per-channel (RGB) difference at pixel offset o between two RGBA buffers.
function channelDelta(a, b, o) {
  return Math.max(
    Math.abs(a[o] - b[o]),
    Math.abs(a[o + 1] - b[o + 1]),
    Math.abs(a[o + 2] - b[o + 2]),
  );
}

// Compare two equal-length RGBA buffers. Returns counts + a visual diff image
// (gray = identical, blue = edge-AA, magenta = structural). `aa`/`struct` let a
// caller override thresholds but default to the shared constants so both sides
// match by default.
export function classifyDiff(
  rawSandom,
  chrome,
  width,
  height,
  { aa = AA_TOL, struct = STRUCT, structFloor = STRUCT_FLOOR } = {},
) {
  // The sandom side may be a float32 working-encoding readback; comparing
  // against an eight-bit oracle is a byte-domain operation, so quantize
  // at this sink, explicitly.
  const sandom = quantizeWorkingPixels(rawSandom);
  if (sandom.length !== chrome.length) {
    throw new Error(
      `pixel buffers differ in length: ${sandom.length} vs ${chrome.length}`,
    );
  }
  const total = width * height;
  const diffImage = new Uint8Array(sandom.length);
  let identical = 0, edgeAA = 0, structural = 0, maxDelta = 0;

  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const d = channelDelta(sandom, chrome, o);
    if (d > maxDelta) maxDelta = d;
    if (d <= aa) {
      const g = Math.round(
        (sandom[o] * 0.299 + sandom[o + 1] * 0.587 + sandom[o + 2] * 0.114) *
            0.35 + 40,
      );
      diffImage[o] = g;
      diffImage[o + 1] = g;
      diffImage[o + 2] = g;
      diffImage[o + 3] = 255;
      identical++;
    } else if (d < struct) {
      diffImage[o] = 40;
      diffImage[o + 1] = 90;
      diffImage[o + 2] = 200;
      diffImage[o + 3] = 255;
      edgeAA++;
    } else {
      diffImage[o] = 255;
      diffImage[o + 1] = 0;
      diffImage[o + 2] = 255;
      diffImage[o + 3] = 255;
      structural++;
    }
  }

  return {
    width,
    height,
    total,
    identical,
    edgeAA,
    structural,
    maxDelta,
    diffImage,
    ok: structural <= structFloor,
  };
}

// One-line verdict — same wording the gallery badge uses.
export function diffSummary(r) {
  if (!r.ok) {
    return `${r.structural} STRUCTURAL px (maxΔ ${r.maxDelta}), ${r.edgeAA} edge-AA`;
  }
  const corners = r.structural > 0 ? `, ${r.structural} corner-AA` : "";
  return `PASS — no structural diff (${r.edgeAA} edge-AA px${corners}, maxΔ ${r.maxDelta})`;
}

// =========================================================================
// Geometric arc-crossing check (Slice P1.5)
// =========================================================================
//
// classifyDiff is color-delta only, and that gives it a proven blind spot:
// a wrong CONTOUR whose two sides happen to be similar colors classifies as
// "edge AA" no matter how the thresholds are tuned. Proven directly: with
// the deviceScale-2 borderRadius scaling bug re-introduced (a visibly SQUARE
// corner on a card specified round), classifyDiff still reported 0
// structural pixels — the square corner's fringe pixel vs Chrome's white
// differed by Δ35, comfortably sub-STRUCT. See
// design/layout-debugging.md.
//
// This check is shape-aware instead: for each EXPECTED rounded-corner arc
// (center, radius, angular quadrant — computed by the caller from the scene
// spec + engine boxes), cast radial rays outward through the contour and
// find where the actual color transition sits in each raster, by
// linear-interpolating the crossing of the inside→outside color midpoint
// between sub-pixel bilinear samples. Chrome is the ground truth: a ray
// only counts when Chrome shows a clean, well-placed edge along it (this
// naturally skips corners that are occluded or blend into same-colored
// background in BOTH images — no scene-specific knowledge needed). The
// verdict compares CROSSING DISTANCES, not colors, so a square corner where
// a round one belongs diverges by ~0.41r at the 45° ray regardless of how
// gentle the color difference is.
//
// Angle convention: screen coordinates, y down — angle 0 points +x, π/2
// points +y (downward). A top-left corner's outward quadrant is [π, 1.5π].

// Sub-pixel step along each ray. 0.25px keeps the interpolated crossing
// well under the tolerance's resolution while staying cheap.
const ARC_STEP = 0.25;
// A ray is only measurable when Chrome's inside/outside reference colors
// differ by at least this much on some channel — below it there is no edge
// to locate on the ground-truth side (occlusion or same-color background).
const ARC_EDGE_CONTRAST_MIN = 32;
// Chrome's own crossing must sit within this distance of the expected
// radius for the ray to count — a ground-truth edge far from the model arc
// means something OTHER than this corner's contour crossed the ray (an
// overlapping box, a neighboring edge), so comparing against it would
// measure the wrong feature. Sandom's crossing is NOT gated this way — a
// wrong sandom contour is exactly what must be measured, not skipped.
const ARC_CHROME_VALIDITY = 2.5;

// Bilinear RGB sample at a floating-point pixel position.
function sampleRGB(px, width, height, x, y) {
  const fx = Math.min(Math.max(x - 0.5, 0), width - 1.001);
  const fy = Math.min(Math.max(y - 0.5, 0), height - 1.001);
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const o00 = (y0 * width + x0) * 4, o10 = o00 + 4;
  const o01 = ((y0 + 1) * width + x0) * 4, o11 = o01 + 4;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const top = px[o00 + c] * (1 - tx) + px[o10 + c] * tx;
    const bot = px[o01 + c] * (1 - tx) + px[o11 + c] * tx;
    out[c] = top * (1 - ty) + bot * ty;
  }
  return out;
}

// First sustained crossing of the 0.5 midpoint in a projected-sample array,
// as a fractional index (linear interpolation between the straddling pair),
// or null if the projection never crosses. "Sustained" = the next ~1px of
// samples stay past the midpoint, so a single noisy AA pixel can't fake a
// crossing. Index 0 means "already outside at scan start" (a contour that
// recedes even deeper than the scan window — clamped, still a divergence).
function firstMidpointCrossing(proj) {
  if (proj[0] >= 0.5) return 0;
  const sustain = Math.round(1 / ARC_STEP);
  for (let i = 1; i < proj.length; i++) {
    if (proj[i] < 0.5) continue;
    let ok = true;
    for (let j = i + 1; j < Math.min(i + sustain, proj.length); j++) {
      if (proj[j] < 0.5) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    return i - 1 + (0.5 - proj[i - 1]) / (proj[i] - proj[i - 1]);
  }
  return null;
}

// Compare the two rasters' actual contour positions along every expected
// arc. `arcs`: [{cx, cy, r, a0, a1, label}] in the rasters' own pixel space.
// Returns { measured, skipped, maxDivergence, worst } — maxDivergence is in
// pixels, the largest |sandomCrossing - chromeCrossing| over all measured
// rays. A sandom contour that never crosses inside the scan window reports
// the window edge (a LOWER BOUND on its divergence), so a missing contour
// still fails loudly rather than skipping.
export function compareArcCrossings(rawSandom, chrome, width, height, arcs) {
  const sandom = quantizeWorkingPixels(rawSandom);
  let measured = 0, skipped = 0, maxDivergence = 0, worst = null;
  for (const arc of arcs) {
    const { cx, cy, r, a0, a1 } = arc;
    // Scan window: 4px inside the expected arc out to 1.5r+3 beyond it —
    // far enough to catch a fully SQUARE corner (its 45° contour sits at
    // r*sqrt(2) ≈ 1.41r) without scanning the whole scene.
    const tStart = Math.max(0.5, r - 4);
    const tEnd = r * 1.5 + 3;
    const steps = Math.floor((tEnd - tStart) / ARC_STEP) + 1;
    const angleStep = Math.PI / 36; // 5°
    for (let a = a0; a <= a1 + 1e-9; a += angleStep) {
      const dx = Math.cos(a), dy = Math.sin(a);
      // Sample both rasters along the ray. Rays that leave the canvas are
      // truncated at the boundary (sampleRGB clamps; measuring a clamped
      // duplicate row would fake a flat edge, so stop instead).
      const chromeSamples = [], sandomSamples = [];
      for (let i = 0; i < steps; i++) {
        const t = tStart + i * ARC_STEP;
        const x = cx + dx * t, y = cy + dy * t;
        if (x < 0.5 || y < 0.5 || x > width - 0.5 || y > height - 0.5) break;
        chromeSamples.push(sampleRGB(chrome, width, height, x, y));
        sandomSamples.push(sampleRGB(sandom, width, height, x, y));
      }
      if (chromeSamples.length < steps * 0.6) {
        skipped++;
        continue;
      }
      // Ground-truth reference colors, from CHROME only: just inside and
      // just outside the expected contour, offset past the ~1px AA band.
      const avgWindow = (lo, hi) => {
        const out = [0, 0, 0];
        let n = 0;
        for (let i = 0; i < chromeSamples.length; i++) {
          const t = tStart + i * ARC_STEP;
          if (t < lo || t > hi) continue;
          for (let c = 0; c < 3; c++) out[c] += chromeSamples[i][c];
          n++;
        }
        return n === 0 ? null : out.map((v) => v / n);
      };
      const inside = avgWindow(r - 3.5, r - 1.5);
      const outside = avgWindow(r + 1.5, r + 3.5);
      if (!inside || !outside) {
        skipped++;
        continue;
      }
      const contrast = Math.max(
        Math.abs(inside[0] - outside[0]),
        Math.abs(inside[1] - outside[1]),
        Math.abs(inside[2] - outside[2]),
      );
      if (contrast < ARC_EDGE_CONTRAST_MIN) {
        skipped++;
        continue;
      }
      const axis = [
        outside[0] - inside[0],
        outside[1] - inside[1],
        outside[2] - inside[2],
      ];
      const den = axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2];
      const project = (s) =>
        ((s[0] - inside[0]) * axis[0] + (s[1] - inside[1]) * axis[1] +
          (s[2] - inside[2]) * axis[2]) / den;
      const chromeCrossIdx = firstMidpointCrossing(chromeSamples.map(project));
      if (chromeCrossIdx === null) {
        skipped++;
        continue;
      }
      const chromeT = tStart + chromeCrossIdx * ARC_STEP;
      if (Math.abs(chromeT - r) > ARC_CHROME_VALIDITY) {
        skipped++;
        continue;
      }
      const sandomCrossIdx = firstMidpointCrossing(sandomSamples.map(project));
      const sandomT = sandomCrossIdx === null
        ? tStart + (sandomSamples.length - 1) * ARC_STEP
        : tStart + sandomCrossIdx * ARC_STEP;
      const divergence = Math.abs(sandomT - chromeT);
      measured++;
      if (divergence > maxDivergence) {
        maxDivergence = divergence;
        worst = {
          label: arc.label,
          angleDeg: Math.round((a * 180) / Math.PI),
          chromeT: Math.round(chromeT * 100) / 100,
          sandomT: Math.round(sandomT * 100) / 100,
        };
      }
    }
  }
  return { measured, skipped, maxDivergence, worst };
}

// =========================================================================
// Text ink-geometry check
// =========================================================================
//
// classifyDiff's per-pixel color-delta classification is unusable for text:
// sandom's MSDF glyph rasterizer and Chrome's glyph rasterizer legitimately
// disagree on every glyph EDGE pixel, and at text sizes thin strokes are all
// edge — a bit-exact layout still shows ~1500 "structural" pixels. What CAN
// be judged at the pixel level is ink GEOMETRY: threshold both rasters into
// ink masks (background = the raster's mode color; these scenes are
// flat-background by construction) and measure:
//   straySandom/strayChrome — ink pixels with NO counterpart ink within 1px
//     (a missing/extra/misplaced glyph, a wrong line Y, a wrong alignment
//     >= 2px turns into hundreds of these);
//   iou — mask overlap (intersection over union), which a 1px systematic
//     shift halves on 2px-thick strokes;
//   sInk/cInk — total ink per side (wrong weight/size shows here).
//
// Pure: takes two already-rasterized equal-length RGBA buffers, same as
// classifyDiff/compareArcCrossings — no knowledge of how either side got
// its pixels.
export function textInkDiff(rawSandom, chrome, width, height) {
  const sandom = quantizeWorkingPixels(rawSandom);
  const w = width, h = height;
  // BACKGROUNDS, plural: a scene can have several large flat regions (dark
  // page + white cards). With a single mode color, text sitting ON the
  // non-mode background is indistinguishable from that background's own
  // ink-vs-mode difference — the mask went BLIND to light text on the dark
  // panel of a card scene and a misplaced-label paint bug sailed through
  // with stray=0. Take every color covering >= 10% of the raster (up to 4)
  // as background; ink = differs from ALL of them. The area floor keeps a
  // glyph's own solid core color (a few thousand px at most) from being
  // mistaken for a background.
  // A background color must be (a) large — ≥10% of the raster — AND
  // (b) CONTIGUOUS: its largest 4-connected component must hold at least
  // half of its pixels. The area floor alone is not enough: a scene
  // dominated by large solid text (four lines of 28px glyphs, or one
  // 48px headline on a small canvas) puts the glyph CORE color above 10%
  // — scattered across dozens of glyphs — and the old check adopted it
  // as "background", silently deleting every glyph core from BOTH ink
  // masks. The comparison then measured only the AA fringes, where the
  // two rasterizers legitimately differ per-pixel: a byte-identical
  // sandom render scored iou 0.46 in a 300×80 scene and 0.91 in a
  // 336×77 scene purely because the core coverage crossed 10% (found
  // 2026-07-16 chasing the type-specimen sheet's large-text rows). A
  // real background — the page, a card's interior — is one big region;
  // text cores never are.
  const backgroundColors = (px) => {
    const counts = new Map();
    for (let i = 0; i < px.length; i += 4) {
      const k = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const floor = (px.length / 4) * 0.10;
    const largestComponent = (colorKey) => {
      const match = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) {
        const o = i * 4;
        if (((px[o] << 16) | (px[o + 1] << 8) | px[o + 2]) === colorKey) {
          match[i] = 1;
        }
      }
      const seen = new Uint8Array(w * h);
      const stack = [];
      let best = 0;
      for (let start = 0; start < w * h; start++) {
        if (!match[start] || seen[start]) continue;
        let size = 0;
        stack.push(start);
        seen[start] = 1;
        while (stack.length) {
          const i = stack.pop();
          size++;
          const x = i % w, y = (i / w) | 0;
          if (x > 0 && match[i - 1] && !seen[i - 1]) {
            seen[i - 1] = 1;
            stack.push(i - 1);
          }
          if (x < w - 1 && match[i + 1] && !seen[i + 1]) {
            seen[i + 1] = 1;
            stack.push(i + 1);
          }
          if (y > 0 && match[i - w] && !seen[i - w]) {
            seen[i - w] = 1;
            stack.push(i - w);
          }
          if (y < h - 1 && match[i + w] && !seen[i + w]) {
            seen[i + w] = 1;
            stack.push(i + w);
          }
        }
        if (size > best) best = size;
      }
      return best;
    };
    return [...counts.entries()]
      .filter(([, n]) => n >= floor)
      .filter(([k, n]) => largestComponent(k) >= n / 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k]) => [(k >> 16) & 255, (k >> 8) & 255, k & 255]);
  };
  const bgs = backgroundColors(chrome);
  const mask = (px, tol) => {
    const m = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      let ink = 1;
      for (const bg of bgs) {
        const d = Math.max(
          Math.abs(px[o] - bg[0]),
          Math.abs(px[o + 1] - bg[1]),
          Math.abs(px[o + 2] - bg[2]),
        );
        if (d <= tol) {
          ink = 0;
          break;
        }
      }
      m[i] = ink;
    }
    return m;
  };
  const dilate = (m) => {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = 0;
        for (let dy = -1; dy <= 1 && !v; dy++) {
          for (let dx = -1; dx <= 1 && !v; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < w && ny < h && m[ny * w + nx]) {
              v = 1;
            }
          }
        }
        out[y * w + x] = v;
      }
    }
    return out;
  };
  // Two mask strengths. SOLID (tol 60): definite ink, used for the STRAY
  // check's subject side. FAINT (tol 25): any visible ink, used for the
  // stray counterpart AND for the overlap/ratio metrics. The two
  // rasterizers' stroke-intensity curves differ (MSDF concentrates coverage
  // where Chrome spreads it) — at 12px a stroke sits just above the solid
  // threshold on one side and just below on the other, so SOLID-mask
  // overlap measures subpixel phase, not geometry (a perfectly aligned
  // sidebar scene scored iou 0.36 solid but its strays were 3). Faint
  // masks register both sides' thin strokes; a truly misplaced glyph sits
  // over bare background with no faint counterpart at all, so both strays
  // and overlap still collapse on real displacement (the misplaced-labels
  // bug measured 541 strays).
  const ms = mask(sandom, 60), mc = mask(chrome, 60);
  const msF = mask(sandom, 25), mcF = mask(chrome, 25);
  const dcFaint = dilate(mcF), dsFaint = dilate(msF);
  let sInk = 0,
    cInk = 0,
    inter = 0,
    union = 0,
    straySandom = 0,
    strayChrome = 0;
  for (let i = 0; i < w * h; i++) {
    if (msF[i]) sInk++;
    if (mcF[i]) cInk++;
    if (msF[i] && mcF[i]) inter++;
    if (msF[i] || mcF[i]) union++;
    if (ms[i] && !dcFaint[i]) straySandom++;
    if (mc[i] && !dsFaint[i]) strayChrome++;
  }
  return {
    sInk,
    cInk,
    iou: inter / Math.max(union, 1),
    straySandom,
    strayChrome,
  };
}

// The SHARED pass verdict for a textInkDiff result — one set of thresholds
// for the headless test AND the gallery badge, so they can't drift.
//
// What this layer guards: text-LAYOUT failures visible at the pixel level —
// a missing/extra/misplaced glyph or line (strays: solid ink with no faint
// counterpart within 1px; the misplaced-labels bug measured 541), a
// catastrophic misalignment (iou floor — nominal scenes measure 0.5-0.9
// depending on text polarity/size; a wholesale shift collapses toward 0),
// and a grossly wrong weight/size (ink ratio). What it deliberately does
// NOT guard: sub-pixel geometry (the LU-level line oracles hold that at
// bit-exactness) and the rasterizers' stroke-intensity difference (MSDF
// concentrates coverage where Chrome spreads it — a few threshold-straddling
// pixels per scene are rendering, not layout; measured up to ~9 stray px on
// small dark-on-white text).
export function textInkPass(ink) {
  const ratio = ink.sInk / Math.max(ink.cInk, 1);
  return (ink.straySandom + ink.strayChrome) <= 24 &&
    ink.iou >= 0.55 &&
    ratio >= 0.7 && ratio <= 1.4;
}

function localInkGeometry(rawPixels, width, height, region) {
  // Float32 working readback quantizes at this byte-domain extractor;
  // byte inputs (decoded PNG oracles) pass through untouched.
  const pixels = quantizeWorkingPixels(rawPixels);
  const left = Math.max(
    0,
    Math.floor(region.x + (region.paddingLeft ?? 0)),
  );
  const top = Math.max(
    0,
    Math.floor(region.y + (region.paddingTop ?? 0)),
  );
  const right = Math.min(
    width,
    Math.ceil(region.x + region.w - (region.paddingRight ?? 0)),
  );
  const bottom = Math.min(
    height,
    Math.ceil(region.y + region.h - (region.paddingBottom ?? 0)),
  );
  const colorCounts = new Map();
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const offset = (y * width + x) * 4;
      const color = (pixels[offset] << 16) |
        (pixels[offset + 1] << 8) | pixels[offset + 2];
      colorCounts.set(color, (colorCounts.get(color) ?? 0) + 1);
    }
  }
  const background = [...colorCounts].sort((
    firstEntry,
    secondEntry,
  ) => secondEntry[1] - firstEntry[1])[0]?.[0];
  if (background === undefined) {
    throw new Error("text element has an empty content region");
  }
  const backgroundRed = (background >> 16) & 255;
  const backgroundGreen = (background >> 8) & 255;
  const backgroundBlue = background & 255;
  let minimumX = Infinity;
  let minimumY = Infinity;
  let maximumX = -Infinity;
  let maximumY = -Infinity;
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const offset = (y * width + x) * 4;
      const difference = Math.max(
        Math.abs(pixels[offset] - backgroundRed),
        Math.abs(pixels[offset + 1] - backgroundGreen),
        Math.abs(pixels[offset + 2] - backgroundBlue),
      );
      if (difference <= 25) continue;
      const localX = x - region.x;
      const localY = y - region.y;
      minimumX = Math.min(minimumX, localX);
      minimumY = Math.min(minimumY, localY);
      maximumX = Math.max(maximumX, localX);
      maximumY = Math.max(maximumY, localY);
      count++;
      sumX += localX;
      sumY += localY;
    }
  }
  if (count === 0) {
    throw new Error("text element content region contains no visible ink");
  }
  return {
    bounds: {
      left: minimumX,
      top: minimumY,
      right: maximumX,
      bottom: maximumY,
    },
    centroid: { x: sumX / count, y: sumY / count },
    count,
  };
}

export function textElementInkDiff(
  rawSandomPixels,
  chromePixels,
  width,
  height,
  elements,
) {
  const sandomPixels = quantizeWorkingPixels(rawSandomPixels);
  return elements.map(({ label, sandom, chrome }) => {
    const measure = (pixels, region, side) => {
      try {
        return localInkGeometry(pixels, width, height, region);
      } catch (error) {
        throw new Error(
          `${label} (${side}, region ${JSON.stringify(region)}): ${error.message}`,
        );
      }
    };
    const sandomInk = measure(sandomPixels, sandom, "sandom");
    const chromeInk = measure(chromePixels, chrome, "chrome");
    return {
      label,
      sandom: sandomInk,
      chrome: chromeInk,
      centroidDifference: {
        x: sandomInk.centroid.x - chromeInk.centroid.x,
        y: sandomInk.centroid.y - chromeInk.centroid.y,
      },
      boundsDifference: {
        left: sandomInk.bounds.left - chromeInk.bounds.left,
        top: sandomInk.bounds.top - chromeInk.bounds.top,
        right: sandomInk.bounds.right - chromeInk.bounds.right,
        bottom: sandomInk.bounds.bottom - chromeInk.bounds.bottom,
      },
      inkRatio: sandomInk.count / chromeInk.count,
    };
  });
}

export function textElementInkPass(comparison) {
  return Math.abs(comparison.boundsDifference.left) <= 1.1 &&
    Math.abs(comparison.boundsDifference.top) <= 1.1 &&
    Math.abs(comparison.boundsDifference.right) <= 1.1 &&
    Math.abs(comparison.boundsDifference.bottom) <= 1.1 &&
    comparison.inkRatio >= 0.65 && comparison.inkRatio <= 1.5;
}
