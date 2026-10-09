// External SVGs use the same scene nodes and path-mask clips as inline SVG.
// Paint servers and clip definitions are image-local, collected before <defs>
// is removed from the drawable tree.
const SVG_NS = "http://www.w3.org/2000/svg";
// The element id that a paint or clip-path value names when the whole value
// is one url(#id), with its escapes decoded by the core's CSS tokenizer.
function referencedElementId(core, text) {
  const value = text?.trim();
  if (!value) return undefined;
  const [token] = core.cssURLs(value);
  if (token?.start !== 0 || token.end !== value.length || !token.url.startsWith("#")) {
    return undefined;
  }
  return token.url.slice(1);
}

const drawable = new Set([
  "rect", "circle", "ellipse", "line", "path", "polygon", "polyline",
]);
const nonRendering = new Set(["title", "desc", "metadata"]);
const referenceProperties = ["filter", "mask"];
const geometryAttributes = [
  "x", "y", "width", "height", "rx", "ry",
  "cx", "cy", "r", "x1", "y1", "x2", "y2",
];

function value(element, name) {
  const attribute = element.getAttribute(name);
  if (attribute !== null) return attribute;
  const style = element.getAttribute("style");
  if (!style) return null;
  return style.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "i"))
    ?.[1]?.trim() ?? null;
}

function svgLength(raw, fallback) {
  if (raw === null) return fallback;
  const text = raw.trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:px|%)?$/i.test(text)) {
    throw new Error(`Unsupported SVG length ${raw}`);
  }
  const parsed = Number.parseFloat(text);
  return text.endsWith("%") ? `${parsed}%` : parsed;
}

function svgMatrix(raw, kind = "gradient") {
  let matrix = [1, 0, 0, 1, 0, 0];
  if (!raw) return matrix;
  const transforms = raw.matchAll(/([a-zA-Z]+)\s*\(([^)]*)\)/g);
  let cursor = 0;
  for (const match of transforms) {
    if (!/^[\s,]*$/.test(raw.slice(cursor, match.index))) {
      throw new Error(`Unsupported SVG ${kind} transform ${raw}`);
    }
    cursor = match.index + match[0].length;
    const values = match[2].trim()
      ? match[2].trim().split(/[\s,]+/).map(Number)
      : [];
    if (values.some((number) => !Number.isFinite(number))) {
      throw new Error(`Invalid SVG ${kind} transform ${raw}`);
    }
    let next;
    switch (match[1]) {
      case "matrix":
        if (values.length !== 6) throw new Error(`Invalid SVG ${kind} matrix ${raw}`);
        next = values;
        break;
      case "translate":
        if (values.length < 1 || values.length > 2) {
          throw new Error(`Invalid SVG ${kind} translate ${raw}`);
        }
        next = [1, 0, 0, 1, values[0], values[1] ?? 0];
        break;
      case "scale":
        if (values.length < 1 || values.length > 2) {
          throw new Error(`Invalid SVG ${kind} scale ${raw}`);
        }
        next = [values[0], 0, 0, values[1] ?? values[0], 0, 0];
        break;
      case "rotate": {
        if (values.length !== 1 && values.length !== 3) {
          throw new Error(`Invalid SVG ${kind} rotate ${raw}`);
        }
        const angle = values[0] * Math.PI / 180;
        const cos = Math.cos(angle), sin = Math.sin(angle);
        const x = values[1] ?? 0, y = values[2] ?? 0;
        next = [cos, sin, -sin, cos,
          x - cos * x + sin * y, y - sin * x - cos * y];
        break;
      }
      case "skewX":
      case "skewY":
        if (values.length !== 1) throw new Error(`Invalid SVG ${kind} ${match[1]} ${raw}`);
        next = match[1] === "skewX"
          ? [1, 0, Math.tan(values[0] * Math.PI / 180), 1, 0, 0]
          : [1, Math.tan(values[0] * Math.PI / 180), 0, 1, 0, 0];
        break;
      default:
        throw new Error(`Unsupported SVG ${kind} transform ${match[1]}`);
    }
    const [a, b, c, d, e, f] = matrix;
    const [g, h, i, j, k, l] = next;
    matrix = [
      a * g + c * h, b * g + d * h,
      a * i + c * j, b * i + d * j,
      a * k + c * l + e, b * k + d * l + f,
    ];
  }
  if (!/^[\s,]*$/.test(raw.slice(cursor))) {
    throw new Error(`Unsupported SVG ${kind} transform ${raw}`);
  }
  return matrix;
}

const identity = [1, 0, 0, 1, 0, 0];

function multiply(outer, inner) {
  const [a, b, c, d, e, f] = outer;
  const [g, h, i, j, k, l] = inner;
  return [a * g + c * h, b * g + d * h,
    a * i + c * j, b * i + d * j,
    a * k + c * l + e, b * k + d * l + f];
}

// Bake definition-only transforms into the clip geometry; the referenced
// element's own transform remains on its scene node, shared by ink and clip.
function transformPath(path, matrix, locator) {
  if (matrix.every((number, index) => number === identity[index])) return path;
  const [a, b, c, d, e, f] = matrix;
  const point = (x, y) => [a * x + c * y + e, b * x + d * y + f];
  const tokens = path.match(/[a-zA-Z]|[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi) ?? [];
  if (path.replace(/[a-zA-Z]|[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|[\s,]/gi, "")) {
    throw new Error(`SVG image ${locator}: invalid clip path ${path}`);
  }
  const counts = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  const out = [];
  let command = null, x = 0, y = 0, startX = 0, startY = 0, index = 0;
  while (index < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[index])) {
      command = tokens[index++];
      if (!(command.toUpperCase() in counts)) {
        throw new Error(`SVG image ${locator}: unsupported clip path command ${command}`);
      }
      if (command.toUpperCase() === "Z") {
        out.push("Z");
        x = startX;
        y = startY;
        command = null;
        continue;
      }
    }
    if (!command) throw new Error(`SVG image ${locator}: invalid clip path ${path}`);
    const kind = command.toUpperCase();
    const count = counts[kind];
    const params = tokens.slice(index, index + count).map(Number);
    if (params.length !== count || params.some((n) => !Number.isFinite(n))) {
      throw new Error(`SVG image ${locator}: invalid clip path ${path}`);
    }
    index += count;
    const ox = command === kind ? 0 : x, oy = command === kind ? 0 : y;
    if (kind === "H") {
      x = ox + params[0];
      out.push("L", ...point(x, y));
    } else if (kind === "V") {
      y = oy + params[0];
      out.push("L", ...point(x, y));
    } else if (kind === "A") {
      if (b !== 0 || c !== 0 || a === 0 || d === 0 ||
        (Math.abs(a) !== Math.abs(d) && params[2] % 180 !== 0)) {
        throw new Error(`SVG image ${locator}: unsupported transformed clip arc`);
      }
      x = ox + params[5];
      y = oy + params[6];
      out.push("A", Math.abs(a) * params[0], Math.abs(d) * params[1],
        a * d < 0 ? -params[2] : params[2], params[3],
        a * d < 0 ? 1 - params[4] : params[4], ...point(x, y));
    } else {
      const converted = [];
      for (let k = 0; k < count; k += 2) {
        converted.push(...point(ox + params[k], oy + params[k + 1]));
      }
      x = ox + params.at(-2);
      y = oy + params.at(-1);
      out.push(kind, ...converted);
      if (kind === "M") {
        startX = x;
        startY = y;
        command = command === kind ? "L" : "l";
      }
    }
  }
  return out.join(" ");
}

function clipGeometry(element, locator, units) {
  const numeric = (name, fallback = 0) => {
    const length = svgLength(element.getAttribute(name), fallback);
    if (typeof length === "string") {
      if (units === "objectBoundingBox") return Number.parseFloat(length) / 100;
      throw new Error(`SVG image ${locator}: unsupported percentage clip geometry ${name}`);
    }
    return length;
  };
  switch (element.localName) {
    case "path":
      return element.getAttribute("d") ?? "";
    case "rect": {
      if (element.hasAttribute("rx") || element.hasAttribute("ry")) {
        throw new Error(`SVG image ${locator}: unsupported rounded clip rect`);
      }
      const x = numeric("x"), y = numeric("y");
      const w = numeric("width"), h = numeric("height");
      return `M${x} ${y}h${w}v${h}h${-w}Z`;
    }
    case "circle":
    case "ellipse": {
      const cx = numeric("cx"), cy = numeric("cy");
      const rx = numeric(element.localName === "circle" ? "r" : "rx");
      const ry = element.localName === "circle" ? rx : numeric("ry");
      return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`;
    }
    case "polygon":
    case "polyline": {
      const raw = element.getAttribute("points") ?? "";
      const points = raw.trim().split(/[\s,]+/).map(Number);
      if (points.length < 4 || points.length % 2 || points.some((n) => !Number.isFinite(n))) {
        throw new Error(`SVG image ${locator}: invalid clip points ${raw}`);
      }
      let d = `M${points[0]} ${points[1]}`;
      for (let i = 2; i < points.length; i += 2) d += `L${points[i]} ${points[i + 1]}`;
      return d + "Z";
    }
    default:
      throw new Error(`SVG image ${locator}: unsupported clip child ${element.localName}`);
  }
}

function clipDefinition(element, locator) {
  if (element.hasAttribute("href") || element.hasAttribute("xlink:href")) {
    throw new Error(`SVG image ${locator}: unsupported clipPath href`);
  }
  const units = element.getAttribute("clipPathUnits") ?? "userSpaceOnUse";
  if (units !== "userSpaceOnUse" && units !== "objectBoundingBox") {
    throw new Error(`SVG image ${locator}: unsupported clipPathUnits ${units}`);
  }
  const paths = [];
  let fillRule = null;
  function collect(node, matrix, inheritedRule) {
    const transformed = multiply(matrix, svgMatrix(node.getAttribute("transform"), "clip"));
    const groupRule = value(node, "clip-rule") ?? inheritedRule;
    for (const child of node.children) {
      if (child.namespaceURI !== SVG_NS) {
        throw new Error(`SVG image ${locator}: unsupported clip child ${child.localName}`);
      }
      if (child.localName === "g") {
        collect(child, transformed, groupRule);
        continue;
      }
      const rule = value(child, "clip-rule") ?? groupRule;
      if (rule !== "nonzero" && rule !== "evenodd") {
        throw new Error(`SVG image ${locator}: unsupported clip-rule ${rule}`);
      }
      if (fillRule !== null && fillRule !== rule) {
        throw new Error(`SVG image ${locator}: mixed clip-rule in clipPath`);
      }
      fillRule = rule;
      paths.push(transformPath(clipGeometry(child, locator, units),
        multiply(transformed, svgMatrix(child.getAttribute("transform"), "clip")), locator));
    }
  }
  collect(element, identity, "nonzero");
  if (paths.length > 1) {
    throw new Error(`SVG image ${locator}: unsupported multi-shape clipPath`);
  }
  return { units, d: paths.join(" "), fillRule: fillRule ?? "nonzero" };
}

export function gradientFor(element, core) {
  const units = element.getAttribute("gradientUnits") ?? "objectBoundingBox";
  if (units !== "objectBoundingBox" && units !== "userSpaceOnUse") {
    throw new Error(`Unsupported SVG gradient units ${units}`);
  }
  const stops = [];
  for (const stop of element.children) {
    if (stop.localName !== "stop") {
      throw new Error(`Unsupported SVG gradient child ${stop.localName}`);
    }
    const rawOffset = value(stop, "offset") ?? "0";
    const parsed = Number.parseFloat(rawOffset);
    if (!Number.isFinite(parsed)) throw new Error(`Invalid SVG stop offset ${rawOffset}`);
    const position = Math.min(1, Math.max(
      stops.at(-1)?.position ?? 0,
      rawOffset.trim().endsWith("%") ? parsed / 100 : parsed,
    ));
    const color = core.parseColor(value(stop, "stop-color") ?? "black");
    if (!color || color === "currentColor") {
      throw new Error(`Unsupported SVG stop color ${value(stop, "stop-color")}`);
    }
    const opacity = Number(value(stop, "stop-opacity") ?? 1);
    if (!Number.isFinite(opacity)) throw new Error("Invalid SVG stop opacity");
    stops.push({ position, color: { ...color, a: color.a * opacity } });
  }
  if (stops.length === 0) throw new Error("SVG gradient has no color stops");
  if (stops.length === 1) stops.push({ ...stops[0], position: 1 });
  const matrix = svgMatrix(element.getAttribute("gradientTransform"));
  if (element.localName === "linearGradient") {
    return {
      kind: "linear",
      units,
      matrix,
      coordinates: [
        svgLength(element.getAttribute("x1"), 0),
        svgLength(element.getAttribute("y1"), 0),
        svgLength(element.getAttribute("x2"), "100%"),
        svgLength(element.getAttribute("y2"), 0),
      ],
      stops,
    };
  }
  if (element.localName === "radialGradient") {
    const cx = svgLength(element.getAttribute("cx"), "50%");
    const cy = svgLength(element.getAttribute("cy"), "50%");
    const fx = svgLength(element.getAttribute("fx"), cx);
    const fy = svgLength(element.getAttribute("fy"), cy);
    if (fx !== cx || fy !== cy) {
      throw new Error("SVG focal radial gradients are not supported");
    }
    return {
      kind: "radial",
      units,
      matrix,
      coordinates: [cx, cy, svgLength(element.getAttribute("r"), "50%")],
      stops,
    };
  }
  throw new Error(`Unsupported SVG paint server ${element.localName}`);
}

export function shapeBounds(element, node) {
  const number = (name, fallback = 0) => {
    const raw = element.getAttribute(name);
    const length = svgLength(raw, fallback);
    if (typeof length !== "number") {
      throw new Error(`Percentage SVG geometry needs a resolved viewport: ${name}=${raw}`);
    }
    return length;
  };
  switch (element.localName) {
    case "rect": {
      const x = number("x"), y = number("y");
      return { xMin: x, yMin: y, xMax: x + number("width"), yMax: y + number("height") };
    }
    case "circle": {
      const cx = number("cx"), cy = number("cy"), r = number("r");
      return { xMin: cx - r, yMin: cy - r, xMax: cx + r, yMax: cy + r };
    }
    case "ellipse": {
      const cx = number("cx"), cy = number("cy");
      const rx = number("rx"), ry = number("ry");
      return { xMin: cx - rx, yMin: cy - ry, xMax: cx + rx, yMax: cy + ry };
    }
    case "line": {
      const x1 = number("x1"), y1 = number("y1"), x2 = number("x2"), y2 = number("y2");
      return { xMin: Math.min(x1, x2), yMin: Math.min(y1, y2), xMax: Math.max(x1, x2), yMax: Math.max(y1, y2) };
    }
    default:
      if (!node.d) throw new Error(`SVG ${element.localName} has no path geometry`);
      return null;
  }
}

export function resolvedGradient(spec, bounds) {
  const { xMin, yMin, xMax, yMax } = bounds;
  const width = xMax - xMin, height = yMax - yMin;
  if (!(width > 0 && height > 0)) {
    throw new Error("SVG gradient shape requires a positive bounding box");
  }
  const [a, b, c, d, e, f] = spec.matrix;
  const determinant = a * d - b * c;
  if (Math.abs(determinant) < 1e-12) {
    throw new Error("SVG gradient has a singular transform");
  }
  const unitBox = spec.units === "objectBoundingBox";
  const coordinate = (v) => {
    if (typeof v !== "string") return v;
    if (!unitBox) {
      throw new Error("Percentage userSpaceOnUse gradients need a viewport");
    }
    return Number.parseFloat(v) / 100;
  };
  if (spec.kind === "linear") {
    const [x1, y1, x2, y2] = spec.coordinates.map(coordinate);
    const vx = x2 - x1, vy = y2 - y1;
    const squared = vx * vx + vy * vy;
    if (squared <= 0) {
      const color = spec.stops.at(-1).color;
      return {
        kind: "linear",
        angle: 90,
        stops: [{ position: 0, color }, { position: 1, color }],
      };
    }
    // The SVG parameter is dot(M^-1*p - p0, p1-p0)/|p1-p0|².
    // CSS's existing gradient shader samples dot(p-center, direction)/L.
    // Transform the *stop coordinates* between these two affine parameters;
    // preserve userSpaceOnUse offsets and gradientTransform translations.
    const nx = (d * vx - b * vy) / (determinant * squared * (unitBox ? width : 1));
    const ny = (-c * vx + a * vy) / (determinant * squared * (unitBox ? height : 1));
    const norm = Math.hypot(nx, ny);
    const ux = nx / norm, uy = ny / norm;
    const px = a * x1 + c * y1 + e, py = b * x1 + d * y1 + f;
    const startX = unitBox ? px * width : px - xMin;
    const startY = unitBox ? py * height : py - yMin;
    const length = Math.abs(width * ux) + Math.abs(height * uy);
    const offset = ((width / 2 - startX) * ux +
      (height / 2 - startY) * uy);
    return {
      kind: "linear",
      angle: Math.atan2(ux, -uy) * 180 / Math.PI,
      stops: spec.stops.map((stop) => ({
        ...stop,
        position: 0.5 + (stop.position / norm - offset) / length,
      })),
    };
  }
  const [cx, cy, radius] = spec.coordinates.map(coordinate);
  if (Math.abs(b) > 1e-9 || Math.abs(c) > 1e-9) {
    throw new Error("Rotated SVG radial gradient is not supported");
  }
  const px = a * cx + e, py = d * cy + f;
  const rx = Math.abs(a * radius * (unitBox ? width : 1));
  const ry = Math.abs(d * radius * (unitBox ? height : 1));
  return {
    kind: "radial",
    shape: rx === ry ? "circle" : "ellipse",
    center: [
      unitBox ? px * width : px - xMin,
      unitBox ? py * height : py - yMin,
    ],
    size: [rx, ry],
    stops: spec.stops,
  };
}

async function pathBoundsFor(pathDef, fillRule, runtime, cache, locator, timings) {
  const key = `${fillRule}\0${pathDef}`;
  let bounds = cache.get(key);
  if (bounds) return bounds;
  const startedAt = timings ? performance.now() : 0;
  bounds = await runtime.sharedSvgPathAtlas.measurePathBounds(pathDef, fillRule);
  if (timings) {
    timings.pathPreparationMilliseconds += performance.now() - startedAt;
  }
  cache.set(key, bounds);
  return bounds;
}

async function clipTargetBounds(element, serialized, runtime, cache, locator, timings) {
  if (element.localName === "g") {
    let bounds = null;
    for (const child of element.children) {
      const childBounds = await clipTargetBounds(
        child, serialized, runtime, cache, locator, timings,
      );
      if (!childBounds) continue;
      const [a, b, c, d, e, f] = svgMatrix(child.getAttribute("transform"), "clip target");
      if (b !== 0 || c !== 0) {
        throw new Error(`SVG image ${locator}: unsupported rotated objectBoundingBox clip target`);
      }
      const x1 = a * childBounds.xMin + e, x2 = a * childBounds.xMax + e;
      const y1 = d * childBounds.yMin + f, y2 = d * childBounds.yMax + f;
      const part = {
        xMin: Math.min(x1, x2), xMax: Math.max(x1, x2),
        yMin: Math.min(y1, y2), yMax: Math.max(y1, y2),
      };
      bounds = bounds === null ? part : {
        xMin: Math.min(bounds.xMin, part.xMin),
        yMin: Math.min(bounds.yMin, part.yMin),
        xMax: Math.max(bounds.xMax, part.xMax),
        yMax: Math.max(bounds.yMax, part.yMax),
      };
    }
    return bounds;
  }
  const index = serialized.indexOf.get(element);
  if (index == null || !drawable.has(element.localName)) {
    throw new Error(`SVG image ${locator}: unsupported objectBoundingBox clip target ${element.localName}`);
  }
  const node = serialized.nodes[index];
  return shapeBounds(element, node) ?? await pathBoundsFor(
    node.d, node._coreSvgRequest?.fillRule ?? "nonzero",
    runtime, cache, locator, timings);
}

function authoredClipTarget(node, element, core, locator) {
  if (element.localName !== "g" && !drawable.has(element.localName)) {
    throw new Error(`SVG image ${locator}: unsupported clipped ${element.localName}`);
  }
  const authored = { ...node, _coreBox: undefined, _corePublication: undefined,
    _coreSvgRequest: undefined };
  if (!element.hasAttribute("transform") && value(element, "transform")) {
    throw new Error(`SVG image ${locator}: unsupported CSS transform on clipped ${element.localName}`);
  }
  for (const property of ["filter", "mask"]) {
    if (value(element, property) && value(element, property) !== "none") {
      throw new Error(`SVG image ${locator}: unsupported ${property} on clipped ${element.localName}`);
    }
  }
  const transform = element.getAttribute("transform");
  if (transform) {
    const [a, b, c, d, x, y] = svgMatrix(transform, "target");
    if (a !== 1 || b !== 0 || c !== 0 || d !== 1) {
      throw new Error(`SVG image ${locator}: unsupported clipped target transform ${transform}`);
    }
    authored.transform = { translate: { x, y } };
  }
  const opacity = value(element, "opacity");
  if (opacity !== null) authored.opacity = Number(opacity);
  if (element.localName === "g") return authored;

  for (const attribute of geometryAttributes) {
    const raw = element.getAttribute(attribute);
    if (raw !== null) authored[attribute] = svgLength(raw, 0);
  }
  if (element.localName === "polygon" || element.localName === "polyline") {
    authored.display = "svg-path";
  }
  authoredPaint(authored, element, core, locator);
  return authored;
}

// The fill and stroke of a drawable element as authored scene fields, as SVG
// inherits them. A fill or stroke that names a gradient (servers.fill,
// servers.stroke) becomes svgFillGradient or svgStrokeGradient, resolved
// against the element's geometry bounds, with its paint opacity folded into
// the stops. A gradient an earlier pass already resolved stays.
function authoredPaint(authored, element, core, locator, servers = null, bounds = null) {
  function inherited(name, fallback) {
    for (let current = element; current?.getAttribute; current = current.parentNode) {
      const authored = value(current, name);
      if (authored !== null) return authored;
    }
    return fallback;
  }
  function color(name, fallback) {
    const raw = inherited(name, fallback);
    if (raw === "none") return "none";
    if (raw.includes("url(")) {
      throw new Error(`SVG image ${locator}: unsupported ${name} ${raw}`);
    }
    const parsed = core.parseColor(raw);
    if (!parsed || parsed === "currentColor") {
      throw new Error(`SVG image ${locator}: unsupported ${name} ${raw}`);
    }
    return parsed;
  }
  function opacity(name) {
    const parsed = Number(inherited(name, "1"));
    if (!Number.isFinite(parsed)) {
      throw new Error(`SVG image ${locator}: invalid ${name} on ${element.localName}`);
    }
    return parsed;
  }
  function gradient(server, alpha) {
    const resolved = resolvedGradient(server, bounds);
    return {
      ...resolved,
      stops: resolved.stops.map((stop) => ({
        ...stop,
        color: { ...stop.color, a: stop.color.a * alpha },
      })),
    };
  }
  if (servers?.fill) {
    authored.svgFillGradient = gradient(servers.fill, opacity("fill-opacity"));
    authored.fill = { r: 1, g: 1, b: 1, a: 1 };
  } else if (!authored.svgFillGradient) {
    authored.fill = color("fill", "black");
    authored.fillOpacity = opacity("fill-opacity");
  }
  if (servers?.stroke) {
    authored.svgStrokeGradient = gradient(servers.stroke, opacity("stroke-opacity"));
    authored.stroke = undefined;
  } else if (!authored.svgStrokeGradient) {
    authored.stroke = color("stroke", "none");
    authored.strokeOpacity = opacity("stroke-opacity");
  }
  authored.strokeWidth = svgLength(inherited("stroke-width", "1"), 1);
  if (typeof authored.strokeWidth !== "number") {
    throw new Error(`SVG image ${locator}: unsupported percentage stroke-width on ${element.localName}`);
  }
  const dash = inherited("stroke-dasharray", "none");
  if (dash !== "none") {
    authored.strokeDasharray = dash.split(/[\s,]+/).map((part) => svgLength(part, 0));
    if (authored.strokeDasharray.some((length) => typeof length !== "number")) {
      throw new Error(`SVG image ${locator}: unsupported percentage stroke-dasharray on ${element.localName}`);
    }
  }
  const dashOffset = inherited("stroke-dashoffset", "0");
  authored.strokeDashoffset = svgLength(dashOffset, 0);
  if (typeof authored.strokeDashoffset !== "number") {
    throw new Error(`SVG image ${locator}: unsupported percentage stroke-dashoffset on ${element.localName}`);
  }
  const miterLimit = Number(inherited("stroke-miterlimit", "4"));
  if (!(miterLimit >= 1)) {
    throw new Error(`SVG image ${locator}: invalid stroke-miterlimit on ${element.localName}`);
  }
  authored.strokeMiterlimit = miterLimit;
  for (const [attribute, field] of [
    ["fill-rule", "fillRule"], ["stroke-linecap", "strokeLinecap"],
    ["stroke-linejoin", "strokeLinejoin"],
  ]) {
    const raw = inherited(attribute, null);
    if (raw !== null) authored[field] = raw;
  }
}

export function prepareSvgImageDefinitions(root, core, locator, timings = null) {
  const gradients = new Map();
  const clips = new Map();
  const remove = [];
  function collect(element) {
    if (element.localName === "clipPath" && element.namespaceURI === SVG_NS) {
      const id = element.getAttribute("id");
      if (id && !gradients.has(id) && !clips.has(id)) clips.set(id, element);
      remove.push(element);
      return;
    }
    if (element.localName === "defs" && element.namespaceURI === SVG_NS) {
      function definitions(node) {
        for (const child of node.children) {
          const id = child.getAttribute("id");
          if (id && !gradients.has(id) && !clips.has(id)) {
            if (child.localName === "linearGradient" ||
              child.localName === "radialGradient") {
              gradients.set(id, gradientFor(child, core));
            } else if (child.localName === "clipPath") {
              clips.set(id, child);
            }
          }
          if (child.localName !== "clipPath") definitions(child);
        }
      }
      definitions(element);
      remove.push(element);
      return;
    }
    if (nonRendering.has(element.localName) && element.namespaceURI === SVG_NS) {
      remove.push(element);
      return;
    }
    for (const child of element.children) collect(child);
  }
  collect(root);
  for (const element of remove) element.parentNode.removeChild(element);

  const painted = new Map();
  const clipped = new Map();
  const resolvedClips = new Map();
  function paintServer(id) {
    const gradient = gradients.get(id);
    if (!gradient) {
      throw new Error(`SVG image ${locator}: unresolved paint server #${id}`);
    }
    return gradient;
  }
  function visit(element, inheritedFill = null, inheritedStroke = null) {
    const fill = value(element, "fill") ?? inheritedFill;
    const reference = referencedElementId(core, fill);
    if (fill?.includes("url(") && !reference) {
      throw new Error(`SVG image ${locator}: unsupported paint ${fill}`);
    }
    const stroke = value(element, "stroke") ?? inheritedStroke;
    const strokeReference = referencedElementId(core, stroke);
    if (stroke?.includes("url(") && !strokeReference) {
      throw new Error(`SVG image ${locator}: unsupported paint ${stroke}`);
    }
    for (const name of referenceProperties) {
      const property = value(element, name);
      if (property?.includes("url(")) {
        throw new Error(`SVG image ${locator}: unsupported ${name} ${property}`);
      }
    }
    const clip = value(element, "clip-path");
    if (clip && clip !== "none") {
      const id = referencedElementId(core, clip);
      if (!id) throw new Error(`SVG image ${locator}: unsupported clip-path ${clip}`);
      const definition = clips.get(id);
      if (!definition) {
        throw new Error(`SVG image ${locator}: unresolved clip-path #${id}`);
      }
      let resolved = resolvedClips.get(id);
      if (!resolved) {
        resolved = clipDefinition(definition, locator);
        resolvedClips.set(id, resolved);
      }
      clipped.set(element, resolved);
    }
    if ((reference || strokeReference) && drawable.has(element.localName)) {
      painted.set(element, {
        fill: reference ? paintServer(reference) : null,
        stroke: strokeReference ? paintServer(strokeReference) : null,
      });
    }
    for (const child of element.children) visit(child, fill, stroke);
  }
  visit(root);
  const pathBounds = new Map();
  return async (serialized, runtime) => {
    if (painted.size === 0 && clipped.size === 0) return serialized;
    const nodes = serialized.nodes.slice();
    for (const [element, servers] of painted) {
      const index = serialized.indexOf.get(element);
      if (index === undefined || index === null) {
        throw new Error(`SVG image ${locator}: unpaintable ${element.localName}`);
      }
      const node = nodes[index];
      let bounds = shapeBounds(element, node);
      if (bounds === null) {
        bounds = await pathBoundsFor(node.d,
          node._coreSvgRequest?.fillRule ?? "nonzero",
          runtime, pathBounds, locator, timings);
      }
      // A zero-area fill has no gradient pixels. Keep its native row so
      // any independent stroke retains its own paint and geometry. A
      // gradient stroke has no box to resolve against there.
      if (!(bounds.xMax > bounds.xMin && bounds.yMax > bounds.yMin)) {
        if (servers.stroke) {
          throw new Error(`SVG image ${locator}: unsupported gradient stroke on a ${element.localName} without area`);
        }
        continue;
      }
      // Native SVG rows own paths and geometry, but authored scene nodes own
      // the gradient extension. Keep the same tree position and path data.
      const authored = { ...node, _coreBox: undefined, _corePublication: undefined,
        _coreSvgRequest: undefined };
      for (const attribute of geometryAttributes) {
        const raw = element.getAttribute(attribute);
        if (raw !== null) authored[attribute] = svgLength(raw, 0);
      }
      if (element.localName === "polygon" || element.localName === "polyline") {
        authored.display = "svg-path";
      }
      const opacity = value(element, "opacity");
      if (opacity !== null) authored.opacity = Number(opacity);
      authoredPaint(authored, element, core, locator, servers, bounds);
      nodes[index] = authored;
    }
    for (const [element, clip] of clipped) {
      const index = serialized.indexOf.get(element);
      if (index == null) {
        throw new Error(`SVG image ${locator}: unpaintable clipped ${element.localName}`);
      }
      let matrix = identity;
      if (clip.units === "objectBoundingBox") {
        const bounds = await clipTargetBounds(
          element, serialized, runtime, pathBounds, locator, timings,
        );
        if (!bounds || !(bounds.xMax > bounds.xMin && bounds.yMax > bounds.yMin)) {
          throw new Error(`SVG image ${locator}: objectBoundingBox clip requires positive target bounds`);
        }
        matrix = [bounds.xMax - bounds.xMin, 0, 0, bounds.yMax - bounds.yMin,
          bounds.xMin, bounds.yMin];
      }
      const d = transformPath(clip.d, matrix, locator);
      if (!d.trim()) {
        throw new Error(`SVG image ${locator}: empty clip-path definition`);
      }
      nodes[index] = {
        ...authoredClipTarget(nodes[index], element, core, locator),
        clipPath: { kind: "path", d, fillRule: clip.fillRule },
      };
    }
    return { ...serialized, nodes };
  };
}
