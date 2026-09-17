const NUMBER = String.raw`(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)`;
const SIGNED_NUMBER = String.raw`[+-]?${NUMBER}`;
const LENGTH_PATTERN = new RegExp(`^(${NUMBER})px$`);
const PERCENT_PATTERN = new RegExp(`^(${NUMBER})%$`);
const FRACTION_PATTERN = new RegExp(`^(${NUMBER})fr$`);
const CALC_LENGTH_PERCENTAGE_PATTERN = new RegExp(
  `^calc\\(\\s*(${SIGNED_NUMBER})px\\s*([+-])\\s*(${NUMBER})%\\s*\\)$`,
);
// CSS permits the unitless zero as a length.
const ZERO_PATTERN = new RegExp(`^(${NUMBER})$`);

function parseBreadth(source, role) {
  if (typeof source === "number" && Number.isFinite(source) && source >= 0) {
    return { type: "length", value: source, percentage: 0 };
  }
  if (typeof source !== "string") {
    throw new Error(`invalid Grid track breadth: ${source}`);
  }
  const value = source.trim();
  if (value === "auto" || value === "min-content" || value === "max-content") {
    return { type: value, value: 0, percentage: 0 };
  }
  const zero = value.match(ZERO_PATTERN);
  if (zero && Number(zero[1]) === 0) {
    return { type: "length", value: 0, percentage: 0 };
  }
  let match = value.match(LENGTH_PATTERN);
  if (match) {
    return { type: "length", value: Number(match[1]), percentage: 0 };
  }
  match = value.match(PERCENT_PATTERN);
  if (match) {
    return {
      type: "percent",
      value: Number(match[1]) / 100,
      percentage: 0,
    };
  }
  match = value.match(CALC_LENGTH_PERCENTAGE_PATTERN);
  if (match) {
    const pixels = Number(match[1]);
    const percentage = Number(match[3]) / 100 * (match[2] === "-" ? -1 : 1);
    if (!Number.isFinite(pixels) || !Number.isFinite(percentage)) {
      throw new Error(`invalid Grid track breadth: ${source}`);
    }
    return {
      type: "length-percentage",
      value: pixels,
      percentage,
    };
  }
  match = value.match(FRACTION_PATTERN);
  if (match) {
    if (role === "minimum") {
      throw new Error(`fractional Grid minimum is invalid: ${source}`);
    }
    const factor = Number(match[1]);
    if (factor <= 0) {
      throw new Error(`fractional Grid factor must be positive: ${source}`);
    }
    return { type: "fraction", value: factor, percentage: 0 };
  }
  throw new Error(`unsupported Grid track breadth: ${source}`);
}

function functionArguments(source, name) {
  const prefix = `${name}(`;
  if (!source.startsWith(prefix) || !source.endsWith(")")) return null;
  let depth = 0;
  for (let index = prefix.length - 1; index < source.length; index++) {
    if (source[index] === "(") depth++;
    if (source[index] === ")") {
      depth--;
      if (depth === 0 && index !== source.length - 1) return null;
      if (depth < 0) return null;
    }
  }
  return depth === 0 ? source.slice(prefix.length, -1) : null;
}

function splitTopLevelComma(source, description) {
  let parentheses = 0;
  let brackets = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === "(") parentheses++;
    if (character === ")") parentheses--;
    if (character === "[") brackets++;
    if (character === "]") brackets--;
    if (parentheses < 0 || brackets < 0) {
      throw new Error(`unbalanced ${description}: ${source}`);
    }
    if (character === "," && parentheses === 0 && brackets === 0) {
      if (source.slice(index + 1).includes(",")) {
        const remaining = source.slice(index + 1);
        let remainingParentheses = 0;
        let remainingBrackets = 0;
        for (const remainingCharacter of remaining) {
          if (remainingCharacter === "(") remainingParentheses++;
          if (remainingCharacter === ")") remainingParentheses--;
          if (remainingCharacter === "[") remainingBrackets++;
          if (remainingCharacter === "]") remainingBrackets--;
          if (
            remainingCharacter === "," && remainingParentheses === 0 &&
            remainingBrackets === 0
          ) {
            throw new Error(`${description} requires exactly two arguments: ${source}`);
          }
        }
      }
      return [source.slice(0, index).trim(), source.slice(index + 1).trim()];
    }
  }
  throw new Error(`${description} requires exactly two arguments: ${source}`);
}

export function parseGridTrack(track) {
  if (typeof track === "number") {
    const breadth = parseBreadth(track, "minimum");
    return { minimum: breadth, maximum: breadth };
  }
  if (typeof track !== "string") {
    throw new Error(`unsupported Grid track: ${track}`);
  }
  const source = track.trim();
  if (source === "auto" || source === "min-content" || source === "max-content") {
    const breadth = parseBreadth(source, "minimum");
    return { minimum: breadth, maximum: breadth };
  }
  if (FRACTION_PATTERN.test(source)) {
    return {
      minimum: { type: "auto", value: 0, percentage: 0 },
      maximum: parseBreadth(source, "maximum"),
    };
  }
  const fitContent = functionArguments(source, "fit-content");
  if (fitContent !== null) {
    const limit = parseBreadth(fitContent.trim(), "maximum");
    if (
      limit.type !== "length" && limit.type !== "percent" &&
      limit.type !== "length-percentage"
    ) {
      throw new Error(`fit-content() requires a length or percentage: ${track}`);
    }
    return {
      minimum: { type: "auto", value: 0, percentage: 0 },
      maximum: {
        type: limit.type === "percent"
          ? "fit-content-percent"
          : limit.type === "length-percentage"
          ? "fit-content-length-percentage"
          : "fit-content",
        value: limit.value,
        percentage: limit.percentage,
      },
    };
  }
  const minmaxArguments = functionArguments(source, "minmax");
  if (minmaxArguments !== null) {
    const [minimumSource, maximumSource] = splitTopLevelComma(
      minmaxArguments,
      "minmax()",
    );
    const minimum = parseBreadth(minimumSource, "minimum");
    const maximum = parseBreadth(maximumSource, "maximum");
    return { minimum, maximum };
  }
  const breadth = parseBreadth(source, "minimum");
  return { minimum: breadth, maximum: breadth };
}

export function splitGridList(source) {
  const tokens = [];
  let start = -1;
  let parentheses = 0;
  let brackets = 0;
  for (let index = 0; index <= source.length; index++) {
    const character = source[index] ?? " ";
    if (character === "(") parentheses++;
    if (character === ")") parentheses--;
    if (character === "[") brackets++;
    if (character === "]") brackets--;
    if (parentheses < 0 || brackets < 0) {
      throw new Error(`unbalanced Grid track list: ${source}`);
    }
    if (/\s/.test(character) && parentheses === 0 && brackets === 0) {
      if (start >= 0) tokens.push(source.slice(start, index));
      start = -1;
    } else if (start < 0) {
      start = index;
    }
  }
  if (parentheses !== 0 || brackets !== 0) {
    throw new Error(`unbalanced Grid track list: ${source}`);
  }
  return tokens;
}

function addLineNames(lineNames, token, line) {
  for (const name of token.slice(1, -1).trim().split(/\s+/)) {
    if (!name) continue;
    const occurrences = lineNames.get(name) ?? [];
    occurrences.push(line);
    lineNames.set(name, occurrences);
  }
}

function transformTrackToken(track, transformBreadth) {
  if (typeof track === "number") return transformBreadth(track);
  if (typeof track !== "string") {
    throw new Error(`unsupported Grid track: ${track}`);
  }
  const source = track.trim();
  if (source.startsWith("[") && source.endsWith("]")) return source;
  if (
    source === "auto" || source === "min-content" ||
    source === "max-content" || FRACTION_PATTERN.test(source)
  ) return source;
  const minmaxArguments = functionArguments(source, "minmax");
  if (minmaxArguments !== null) {
    const [minimum, maximum] = splitTopLevelComma(
      minmaxArguments,
      "minmax()",
    );
    return `minmax(${transformTrackToken(minimum, transformBreadth)}, ${
      transformTrackToken(maximum, transformBreadth)
    })`;
  }
  const fitContent = functionArguments(source, "fit-content");
  if (fitContent !== null) {
    return `fit-content(${transformTrackToken(fitContent, transformBreadth)})`;
  }
  const repeatArguments = functionArguments(source, "repeat");
  if (repeatArguments !== null) {
    const [count, patternSource] = splitTopLevelComma(
      repeatArguments,
      "repeat()",
    );
    if (
      !/^[1-9]\d*$/.test(count) && count !== "auto-fill" &&
      count !== "auto-fit"
    ) {
      throw new Error(`unsupported Grid repeat count: ${count}`);
    }
    const pattern = splitGridList(patternSource);
    if (pattern.length === 0) {
      throw new Error("Grid repeat pattern must contain a track");
    }
    return `repeat(${count}, ${
      pattern.map((entry) => transformTrackToken(entry, transformBreadth))
        .join(" ")
    })`;
  }
  return transformBreadth(source);
}

export function transformGridTrackList(template, transformBreadth) {
  if (Array.isArray(template)) {
    return template.map((track) => transformTrackToken(track, transformBreadth));
  }
  const source = String(template ?? "").trim();
  if (source === "none") return "none";
  const tracks = splitGridList(source);
  if (tracks.length === 0) throw new Error("Grid track list cannot be empty");
  return tracks.map((track) => transformTrackToken(track, transformBreadth))
    .join(" ");
}

export function transformGridAutoTrack(track, transformBreadth) {
  const transformed = transformTrackToken(track, transformBreadth);
  parseGridTrack(transformed);
  return transformed;
}

export function parseGridTrackList(template) {
  const sourceTracks = Array.isArray(template)
    ? template
    : String(template ?? "").trim() === "none"
    ? []
    : splitGridList(template ?? "");
  const tracks = [];
  const lineNames = new Map();
  let automaticRepeat = null;
  const append = (track) => {
    if (typeof track === "string" && track.startsWith("[") && track.endsWith("]")) {
      addLineNames(lineNames, track, tracks.length + 1);
      return;
    }
    const repeatArguments = typeof track === "string"
      ? functionArguments(track, "repeat")
      : null;
    if (repeatArguments === null) {
      parseGridTrack(track);
      tracks.push(track);
      return;
    }
    const [count, patternSource] = splitTopLevelComma(
      repeatArguments,
      "repeat()",
    );
    const pattern = splitGridList(patternSource);
    if (/^[1-9]\d*$/.test(count)) {
      for (let repetition = 0; repetition < Number(count); repetition++) {
        for (const entry of pattern) append(entry);
      }
      return;
    }
    if (count !== "auto-fill" && count !== "auto-fit") {
      throw new Error(`unsupported Grid repeat count: ${count}`);
    }
    if (automaticRepeat) {
      throw new Error("only one automatic Grid repeat is allowed per track list");
    }
    const markerIndex = tracks.length;
    tracks.push({ automaticRepeat: count, patternLength: 0 });
    const patternStart = tracks.length;
    for (const entry of pattern) append(entry);
    const patternLength = tracks.length - patternStart;
    if (patternLength === 0) {
      throw new Error("automatic Grid repeat pattern must contain a track");
    }
    tracks[markerIndex].patternLength = patternLength;
    automaticRepeat = { kind: count, markerIndex, patternLength };
  };
  for (const track of sourceTracks) append(track);
  return { tracks, lineNames, automaticRepeat };
}

export function parseGridTemplateAreas(rows) {
  if (rows === undefined) return { columnCount: 0, rowCount: 0, areas: new Map() };
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('gridTemplateAreas must be a non-empty array of strings');
  const matrix = rows.map((row) => {
    if (typeof row !== 'string') throw new Error('gridTemplateAreas rows must be strings');
    return row.trim().split(/\s+/);
  });
  const columnCount = matrix[0].length;
  if (columnCount === 0 || matrix.some((row) => row.length !== columnCount)) {
    throw new Error('gridTemplateAreas rows must have equal non-zero column counts');
  }
  const areas = new Map();
  for (let row = 0; row < matrix.length; row++) {
    for (let column = 0; column < columnCount; column++) {
      const name = matrix[row][column];
      if (name === '.') continue;
      const area = areas.get(name) ?? { rowStart: row + 1, rowEnd: row + 2, columnStart: column + 1, columnEnd: column + 2 };
      area.rowStart = Math.min(area.rowStart, row + 1);
      area.rowEnd = Math.max(area.rowEnd, row + 2);
      area.columnStart = Math.min(area.columnStart, column + 1);
      area.columnEnd = Math.max(area.columnEnd, column + 2);
      areas.set(name, area);
    }
  }
  for (const [name, area] of areas) {
    for (let row = area.rowStart - 1; row < area.rowEnd - 1; row++) {
      for (let column = area.columnStart - 1; column < area.columnEnd - 1; column++) {
        if (matrix[row][column] !== name) throw new Error(`grid template area "${name}" is not rectangular`);
      }
    }
  }
  return { columnCount, rowCount: matrix.length, areas };
}

function resolveNamedGridLine(value, lineNames, otherValue, isStart) {
  if (typeof value !== 'string' || value === 'auto' || /^span [1-9]\d*$/.test(value)) return value;
  const span = /^span\s+([A-Za-z_][\w-]*)$/.exec(value);
  if (span) {
    const occurrences = lineNames.get(span[1]) ?? [];
    if (!Number.isInteger(otherValue)) throw new Error(`named Grid span "${value}" requires a definite opposite line`);
    const candidates = isStart
      ? occurrences.filter((line) => line < otherValue).reverse()
      : occurrences.filter((line) => line > otherValue);
    if (candidates.length === 0) throw new Error(`named Grid span "${value}" has no matching line`);
    return candidates[0];
  }
  const match = /^([A-Za-z_][\w-]*)(?:\s+([1-9]\d*))?$/.exec(value);
  if (!match) throw new Error(`unsupported named Grid line: ${value}`);
  const occurrences = lineNames.get(match[1]) ?? [];
  const occurrence = Number(match[2] ?? 1);
  if (occurrence > occurrences.length) throw new Error(`unknown Grid line occurrence: ${value}`);
  return occurrences[occurrence - 1];
}

// A DOM-backed container (a node with a core box) places its items through
// the DOM core's engine record; only scene-spec containers resolve here.
export function resolveGridPlacementNodes(nodes) {
  if (!nodes.some((node) => node.display === 'grid' && node._coreBox === undefined)) return nodes;
  const resolved = nodes.map((node) => ({ ...node }));
  for (const container of resolved) {
    if (container.display !== 'grid' || container._coreBox !== undefined) continue;
    const columns = parseGridTrackList(container.gridTemplateColumns);
    const rows = parseGridTrackList(container.gridTemplateRows);
    const areas = parseGridTemplateAreas(container.gridTemplateAreas);
    for (const [name, area] of areas.areas) {
      for (const [map, startName, endName, start, end] of [
        [columns.lineNames, `${name}-start`, `${name}-end`, area.columnStart, area.columnEnd],
        [rows.lineNames, `${name}-start`, `${name}-end`, area.rowStart, area.rowEnd],
      ]) {
        map.set(startName, [...(map.get(startName) ?? []), start]);
        map.set(endName, [...(map.get(endName) ?? []), end]);
      }
    }
    if (areas.columnCount > 0 && columns.tracks.length === 0) {
      container.gridTemplateColumns = Array(areas.columnCount).fill('auto');
    }
    if (areas.rowCount > 0 && rows.tracks.length === 0) {
      container.gridTemplateRows = Array(areas.rowCount).fill('auto');
    }
    for (const childIndex of container.children ?? []) {
      const child = resolved[childIndex];
      const area = typeof child.gridArea === 'string' ? areas.areas.get(child.gridArea) : null;
      if (child.gridArea !== undefined && !area) throw new Error(`unknown Grid template area: ${child.gridArea}`);
      if (area) {
        child.gridColumnStart ??= area.columnStart;
        child.gridColumnEnd ??= area.columnEnd;
        child.gridRowStart ??= area.rowStart;
        child.gridRowEnd ??= area.rowEnd;
      }
      const originalColumnStart = child.gridColumnStart;
      const originalColumnEnd = child.gridColumnEnd;
      const originalRowStart = child.gridRowStart;
      const originalRowEnd = child.gridRowEnd;
      child.gridColumnStart = resolveNamedGridLine(originalColumnStart, columns.lineNames, originalColumnEnd, true);
      child.gridColumnEnd = resolveNamedGridLine(originalColumnEnd, columns.lineNames, child.gridColumnStart, false);
      child.gridRowStart = resolveNamedGridLine(originalRowStart, rows.lineNames, originalRowEnd, true);
      child.gridRowEnd = resolveNamedGridLine(originalRowEnd, rows.lineNames, child.gridRowStart, false);
    }
  }
  return resolved;
}

export function scaleGridTrack(track, scale) {
  if (scale === 1) return track;
  // A bare number is a pixel breadth (the scene shorthand); scale it as a
  // number so the string track grammar never sees a unitless nonzero value.
  if (typeof track === "number") {
    if (!Number.isFinite(track) || track < 0) {
      throw new Error(`unsupported Grid track: ${track}`);
    }
    return track * scale;
  }
  return transformGridTrackList(track, (breadth) => {
    const parsed = parseBreadth(breadth, "maximum");
    if (parsed.type === "length") return `${parsed.value * scale}px`;
    if (parsed.type === "length-percentage") {
      const percentageSign = parsed.percentage < 0 ? "-" : "+";
      return `calc(${parsed.value * scale}px ${percentageSign} ${
        Math.abs(parsed.percentage * 100)
      }%)`;
    }
    return String(breadth);
  });
}

export function gridTrackCss(track) {
  if (typeof track === 'number') return `${track}px`;
  if (typeof track === 'string') return track;
  throw new Error(`unsupported Grid track: ${track}`);
}
