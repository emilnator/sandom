// The .wgsl files are the source of truth; src/shaders/sources.js is the
// committed embedding of them that JavaScript can actually import
// (tools/build-shaders.js, `deno task shaders`). Raw text imports cannot be
// used here: they are a flagged Deno-only feature, so a browser and every
// unflagged CLI subprocess would fail to load this module outright.
import { SHADER_SOURCES } from "./sources.js";

// `clip` and `gradient` are fragments spliced into the others rather than
// shaders in their own right, so they are named directly and kept out of
// the composable set.
const clip = SHADER_SOURCES.clip;
const gradient = SHADER_SOURCES.gradient;
const sources = Object.freeze(
  Object.fromEntries(
    Object.entries(SHADER_SOURCES).filter(
      ([name]) => name !== "clip" && name !== "gradient",
    ),
  ),
);

const fragmentMarker = "// @fragment CLIP_EVAL_WGSL";
const markerOffset = clip.indexOf(fragmentMarker);
if (markerOffset < 0) {
  throw new Error(`clip.wgsl is missing ${fragmentMarker}`);
}
const clipStruct = clip.slice("// @fragment CLIP_STRUCT_WGSL\n".length, markerOffset);
const clipEval = clip.slice(markerOffset + fragmentMarker.length + 1);

function replace(source, name, value) {
  return source.replaceAll(`\${${name}}`, String(value));
}

export function composeShader(name, constants = {}) {
  const source = sources[name];
  if (source === undefined) {
    throw new RangeError(`unknown shader ${JSON.stringify(name)}`);
  }
  let result = replace(source, "CLIP_STRUCT_WGSL", clipStruct);
  result = replace(result, "CLIP_EVAL_WGSL", clipEval);
  result = replace(result, "GRADIENT_COLOR_WGSL", gradient);
  for (const [constantName, value] of Object.entries(constants)) {
    result = replace(result, constantName, value);
  }
  const unresolved = result.match(/\$\{[^}]+\}/);
  if (unresolved) {
    throw new Error(`shader ${name} has unresolved placeholder ${unresolved[0]}`);
  }
  return result;
}

export const shaderNames = Object.freeze(Object.keys(sources));
