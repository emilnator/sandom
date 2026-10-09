// A Tier A shape's outline as an equivalent `d` string, or null for a
// shape with no outline (a zero width, height or radius). Tier A shapes
// (rect/circle/ellipse/line) are lowered straight to engine.wat geometry —
// a filled rounded box, plus a border-ring trick for the stroke — and that
// ring has one solid colour and no notion of arc length. A Tier A shape
// whose stroke dashes or names a gradient is re-expressed as this path and
// drawn by the Tier B pipeline (SvgPathAtlas), where SkDashPath runs over
// the real outline and the stroke outline is a command a gradient paints:
// the scene renderer lowers authored nodes (tierAAsPath), the DOM
// serializer lowers a native row whose stroke names a paint server.
//
// Contour start point and direction MATTER here and are not free
// choices: a dash pattern is laid out from the contour's start along
// its own direction, so a path that traces the same outline from a
// different corner (or counter-clockwise) renders visibly different
// dashes. Each shape below starts where SVG's own implicit equivalent
// path starts and runs clockwise: rect at (x+rx, y), circle/ellipse at
// the 3-o'clock point (cx+r, cy).
export function svgShapeToPathDef(node) {
  if (node.display === "svg-line") {
    return `M ${node.x1 ?? 0} ${node.y1 ?? 0} L ${node.x2 ?? 0} ${
      node.y2 ?? 0
    }`;
  }
  if (node.display === "svg-circle") {
    const cx = node.cx ?? 0, cy = node.cy ?? 0, r = node.r ?? 0;
    if (!(r > 0)) return null;
    // Two half-arcs: a single 360° arc is degenerate in SVG's arc syntax
    // (identical start and end point = "skip this segment" per spec).
    return `M ${cx + r} ${cy} A ${r} ${r} 0 0 1 ${
      cx - r
    } ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy} Z`;
  }
  if (node.display === "svg-ellipse") {
    const cx = node.cx ?? 0,
      cy = node.cy ?? 0,
      rx = node.rx ?? 0,
      ry = node.ry ?? 0;
    if (!(rx > 0) || !(ry > 0)) return null;
    return `M ${cx + rx} ${cy} A ${rx} ${ry} 0 0 1 ${
      cx - rx
    } ${cy} A ${rx} ${ry} 0 0 1 ${cx + rx} ${cy} Z`;
  }
  if (node.display === "svg-rect") {
    const x = node.x ?? 0,
      y = node.y ?? 0,
      w = node.width ?? 0,
      h = node.height ?? 0;
    if (!(w > 0) || !(h > 0)) return null;
    // SVG's own rx/ry auto-defaulting: either one alone supplies the
    // other, and both clamp to half the corresponding side.
    let rx = node.rx ?? node.ry ?? 0, ry = node.ry ?? node.rx ?? 0;
    rx = Math.min(rx, w / 2);
    ry = Math.min(ry, h / 2);
    if (!(rx > 0) || !(ry > 0)) {
      return `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${
        y + h
      } Z`;
    }
    return `M ${x + rx} ${y} L ${x + w - rx} ${y} A ${rx} ${ry} 0 0 1 ${
      x + w
    } ${y + ry}` +
      ` L ${x + w} ${y + h - ry} A ${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}` +
      ` L ${x + rx} ${y + h} A ${rx} ${ry} 0 0 1 ${x} ${y + h - ry}` +
      ` L ${x} ${y + ry} A ${rx} ${ry} 0 0 1 ${x + rx} ${y} Z`;
  }
  return null;
}
