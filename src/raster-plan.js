import {
  clipUniformFloats as packClipUniformFloats,
  MAX_SHADER_CLIP_ENTRIES,
} from "./gpu-composition-clip.js";
import {
  CMD_BOX_SHADOW,
  CMD_DAMAGE,
  CMD_IMAGE,
  CMD_IMAGE_FLAG_PIXELATED,
  CMD_PUSH_BLEND_LAYER,
  CMD_PUSH_OPACITY,
  CMD_RECT,
  CMD_SET_NODE,
  CMD_SET_SCROLL,
  CMD_SVG_PATH,
  CMD_TEXT,
  COLOR_GLYPH_CACHE_PAGE_INDEX_BASE,
  RASTER_PLAN_ABI_VERSION,
  RASTER_PLAN_BOX_SHADOW_INSTANCE_FLOATS,
  RASTER_PLAN_CLIP_ENTRY_SIZE,
  RASTER_PLAN_CLIP_FLOATS,
  RASTER_PLAN_CLIP_PATH_MASK_FLOATS,
  RASTER_PLAN_FILTER_DESCRIPTOR_BYTES,
  RASTER_PLAN_FILTER_LIST_OFFSET,
  RASTER_PLAN_FILTER_UNIFORM_SLOT_BYTES,
  RASTER_PLAN_GRADIENT_RECORD_BYTES,
  RASTER_PLAN_GRADIENT_STOP_BYTES,
  RASTER_PLAN_GROUP_POP_FLOATS,
  RASTER_PLAN_HEADER_SIZE,
  RASTER_PLAN_MAGIC,
  RASTER_PLAN_NO_CLIP,
  RASTER_PLAN_PASS_BOX_BLUR_H,
  RASTER_PLAN_PASS_BOX_BLUR_V,
  RASTER_PLAN_PASS_DROP_SHADOW,
  RASTER_PLAN_RECORD_FLAG_NEEDS_BACKDROP_COPY,
  RASTER_PLAN_RECORD_OFFSET_BOUNDS,
  RASTER_PLAN_RECORD_OFFSET_CLIP,
  RASTER_PLAN_RECORD_OFFSET_FLAGS,
  RASTER_PLAN_RECORD_OFFSET_GRADIENT,
  RASTER_PLAN_RECORD_OFFSET_GRADIENT_BYTES,
  RASTER_PLAN_RECORD_OFFSET_INSTANCE_COUNT,
  RASTER_PLAN_RECORD_OFFSET_KIND,
  RASTER_PLAN_RECORD_OFFSET_PAYLOAD,
  RASTER_PLAN_RECORD_OFFSET_PAYLOAD_BYTES,
  RASTER_PLAN_RECORD_OFFSET_SOURCE,
  RASTER_PLAN_RECORD_OFFSET_SOURCE_BYTES,
  RASTER_PLAN_RECORD_OFFSET_RESOURCE,
  RASTER_PLAN_RECORD_SIZE,
} from "./wasm/layout.js";

export const EMPTY_CLIP_STATE = Object.freeze({
  entries: Object.freeze([]),
  bounds: null,
  clipIndex: RASTER_PLAN_NO_CLIP,
  entryCount: 0,
  packedFloats: new Float32Array(RASTER_PLAN_CLIP_FLOATS),
  pathMaskFloats: null,
});
export const RECT_INSTANCE_FLOATS = 44;
export const BOX_SHADOW_INSTANCE_FLOATS =
  RASTER_PLAN_BOX_SHADOW_INSTANCE_FLOATS;
export const GRADIENT_RECORD_STRIDE = RASTER_PLAN_GRADIENT_RECORD_BYTES;
export const GRADIENT_STOP_STRIDE = RASTER_PLAN_GRADIENT_STOP_BYTES;
export function clipUniformFloats(clipState) {
  return clipState.packedFloats ?? packClipUniformFloats(clipState);
}
export { MAX_SHADER_CLIP_ENTRIES };

// The instanced kinds: one pipeline, one bind group, N instances. An image
// and an SVG path each bind their own resource per draw, so a record of
// those kinds is always its own draw.
const RECORD_WORDS = RASTER_PLAN_RECORD_SIZE / 4;
const RECORD_WORD_CLIP = RASTER_PLAN_RECORD_OFFSET_CLIP / 4;
const RECORD_WORD_PAYLOAD = RASTER_PLAN_RECORD_OFFSET_PAYLOAD / 4;
const RECORD_WORD_PAYLOAD_BYTES = RASTER_PLAN_RECORD_OFFSET_PAYLOAD_BYTES / 4;
const RECORD_WORD_INSTANCE_COUNT = RASTER_PLAN_RECORD_OFFSET_INSTANCE_COUNT /
  4;
const RECORD_WORD_RESOURCE = RASTER_PLAN_RECORD_OFFSET_RESOURCE / 4;
const RECORD_WORD_GRADIENT_BYTES = RASTER_PLAN_RECORD_OFFSET_GRADIENT_BYTES /
  4;
const RECORD_WORD_BOUNDS = RASTER_PLAN_RECORD_OFFSET_BOUNDS / 4;
const RECORD_HALF_KIND = RASTER_PLAN_RECORD_OFFSET_KIND / 2;
const RECORD_HALF_FLAGS = RASTER_PLAN_RECORD_OFFSET_FLAGS / 2;

function spannableKind(kind) {
  return kind === CMD_RECT || kind === CMD_BOX_SHADOW || kind === CMD_TEXT;
}

// A cached color glyph (CMD_IMAGE from an atlas page of the color glyph
// cache, plans/PLAN-color-glyphs.md slice 3) is one instance of its page's
// image draw, so consecutive glyphs of one page merge like text runs.
function spannableRecord(kind, resource) {
  return spannableKind(kind) ||
    (kind === CMD_IMAGE && resource >= COLOR_GLYPH_CACHE_PAGE_INDEX_BASE);
}

// The kinds whose payload is instance data a backend draws from.
function instancedKind(kind) {
  return spannableKind(kind) || kind === CMD_IMAGE || kind === CMD_SVG_PATH;
}

export function openRasterPlan(memory, plan) {
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new TypeError("openRasterPlan: memory must be WebAssembly.Memory");
  }
  if (!Number.isInteger(plan) || plan <= 0) {
    throw new RangeError(`openRasterPlan: plan handle ${plan} is not a positive integer`);
  }

  let view;
  let bytes;
  let recordCount;
  let recordTableOffset;
  let clipTableOffset;
  const clipStates = new Map();
  let clipCount;
  let payloadRegionOffset;
  let payloadRegionBytes;
  // drawSequence's result, reused by every call on this reader.
  const sequence = {
    count: 0,
    first: new Uint32Array(0),
    last: new Uint32Array(0),
    instanceCount: new Uint32Array(0),
    payloadStart: new Uint32Array(0),
    payloadEnd: new Uint32Array(0),
    bounds: new Float32Array(0),
    uploadBytes: 0,
    pathMaskInUse: false,
  };
  let clipsInUse = new Uint8Array(0);

  function refresh() {
    if (plan + RASTER_PLAN_HEADER_SIZE > memory.buffer.byteLength) {
      throw new RangeError(
        `openRasterPlan: ${RASTER_PLAN_HEADER_SIZE}-byte header at ${plan} exceeds ${memory.buffer.byteLength}-byte memory`,
      );
    }
    clipStates.clear();
    view = new DataView(memory.buffer, plan);
    const magic = view.getUint32(0, true);
    const abiVersion = view.getUint32(4, true);
    if (magic !== RASTER_PLAN_MAGIC) {
      throw new Error(
        `openRasterPlan: magic 0x${magic.toString(16)} does not equal SRPL 0x${RASTER_PLAN_MAGIC.toString(16)}`,
      );
    }
    if (abiVersion !== RASTER_PLAN_ABI_VERSION) {
      throw new Error(
        `openRasterPlan: ABI version ${abiVersion} is unsupported; expected ${RASTER_PLAN_ABI_VERSION}`,
      );
    }

    const totalBytes = view.getUint32(8, true);
    recordCount = view.getUint32(12, true);
    recordTableOffset = view.getUint32(20, true);
    const recordStride = view.getUint32(24, true);
    clipTableOffset = view.getUint32(52, true);
    clipCount = view.getUint32(56, true);
    payloadRegionOffset = view.getUint32(60, true);
    payloadRegionBytes = view.getUint32(64, true);
    if (recordTableOffset !== RASTER_PLAN_HEADER_SIZE || recordStride !== RASTER_PLAN_RECORD_SIZE) {
      throw new Error(
        `openRasterPlan: record table offset/stride ${recordTableOffset}/${recordStride} does not equal ${RASTER_PLAN_HEADER_SIZE}/${RASTER_PLAN_RECORD_SIZE}`,
      );
    }
    if (totalBytes < RASTER_PLAN_HEADER_SIZE || plan + totalBytes > memory.buffer.byteLength) {
      throw new RangeError(
        `openRasterPlan: ${totalBytes}-byte plan at ${plan} exceeds ${memory.buffer.byteLength}-byte memory`,
      );
    }
    const recordsEnd = recordTableOffset + recordCount * recordStride;
    const clipsEnd = clipTableOffset + clipCount * RASTER_PLAN_CLIP_ENTRY_SIZE;
    const payloadEnd = payloadRegionOffset + payloadRegionBytes;
    if (
      clipTableOffset < recordsEnd || payloadRegionOffset < clipsEnd ||
      payloadEnd > totalBytes || (payloadRegionOffset & 15) !== 0
    ) {
      throw new Error(
        `openRasterPlan: invalid regions recordsEnd=${recordsEnd}, clipTable=${clipTableOffset}..${clipsEnd}, payload=${payloadRegionOffset}..${payloadEnd}, total=${totalBytes}`,
      );
    }
    bytes = new Uint8Array(memory.buffer, plan, totalBytes);
    return reader;
  }

  function ensureCurrentMemory() {
    if (view.buffer !== memory.buffer) refresh();
  }

  function recordOffset(index) {
    ensureCurrentMemory();
    if (!Number.isInteger(index) || index < 0 || index >= recordCount) {
      throw new RangeError(`raster plan record index ${index} is outside 0..${recordCount - 1}`);
    }
    return recordTableOffset + index * RASTER_PLAN_RECORD_SIZE;
  }

  const reader = {
    get count() {
      ensureCurrentMemory();
      return recordCount;
    },
    kind(index) {
      const offset = recordOffset(index);
      return view.getUint16(offset + RASTER_PLAN_RECORD_OFFSET_KIND, true);
    },
    flags(index) {
      const offset = recordOffset(index);
      return view.getUint16(offset + RASTER_PLAN_RECORD_OFFSET_FLAGS, true);
    },
    sourceOffset(index) {
      const offset = recordOffset(index);
      return view.getUint32(offset + RASTER_PLAN_RECORD_OFFSET_SOURCE, true);
    },
    sourceBytes(index) {
      const offset = recordOffset(index);
      return view.getUint32(offset + RASTER_PLAN_RECORD_OFFSET_SOURCE_BYTES, true);
    },
    clipIndex(index) {
      const offset = recordOffset(index);
      return view.getUint32(offset + RASTER_PLAN_RECORD_OFFSET_CLIP, true);
    },
    clip(index) {
      const offset = recordOffset(index);
      const clipIndex = view.getUint32(offset + RASTER_PLAN_RECORD_OFFSET_CLIP, true);
      if (clipIndex === RASTER_PLAN_NO_CLIP) return null;
      if (clipIndex >= clipCount) {
        throw new RangeError(`raster plan clip index ${clipIndex} exceeds count ${clipCount}`);
      }
      const clipOffset = clipTableOffset + clipIndex * RASTER_PLAN_CLIP_ENTRY_SIZE;
      return new Float32Array(
        memory.buffer,
        plan + clipOffset + 4,
        RASTER_PLAN_CLIP_FLOATS,
      );
    },
    clipEntryCount(index) {
      const clipIndex = reader.clipIndex(index);
      if (clipIndex === RASTER_PLAN_NO_CLIP) return 0;
      if (clipIndex >= clipCount) {
        throw new RangeError(`raster plan clip index ${clipIndex} exceeds count ${clipCount}`);
      }
      return view.getUint32(
        clipTableOffset + clipIndex * RASTER_PLAN_CLIP_ENTRY_SIZE,
        true,
      );
    },
    clipBounds(index) {
      const clipIndex = reader.clipIndex(index);
      if (clipIndex === RASTER_PLAN_NO_CLIP) return null;
      if (clipIndex >= clipCount) {
        throw new RangeError(`raster plan clip index ${clipIndex} exceeds count ${clipCount}`);
      }
      const offset = clipTableOffset + clipIndex * RASTER_PLAN_CLIP_ENTRY_SIZE +
        4 + (RASTER_PLAN_CLIP_FLOATS + RASTER_PLAN_CLIP_PATH_MASK_FLOATS) * 4;
      const minX = view.getFloat32(offset, true);
      return Number.isNaN(minX)
        ? null
        : {
          minX,
          minY: view.getFloat32(offset + 4, true),
          maxX: view.getFloat32(offset + 8, true),
          maxY: view.getFloat32(offset + 12, true),
        };
    },
    pathMask(index) {
      const clipIndex = reader.clipIndex(index);
      if (clipIndex === RASTER_PLAN_NO_CLIP) return null;
      if (clipIndex >= clipCount) {
        throw new RangeError(`raster plan clip index ${clipIndex} exceeds count ${clipCount}`);
      }
      return new Float32Array(
        memory.buffer,
        plan + clipTableOffset + clipIndex * RASTER_PLAN_CLIP_ENTRY_SIZE +
          4 + RASTER_PLAN_CLIP_FLOATS * 4,
        RASTER_PLAN_CLIP_PATH_MASK_FLOATS,
      );
    },
    clipState(index) {
      const clipIndex = reader.clipIndex(index);
      if (clipIndex === RASTER_PLAN_NO_CLIP) return EMPTY_CLIP_STATE;
      let state = clipStates.get(clipIndex);
      if (state === undefined) {
        const entryCount = reader.clipEntryCount(index);
        state = Object.freeze({
          entries: Object.freeze(Array.from({ length: entryCount }, () => null)),
          packedFloats: reader.clip(index),
          pathMaskFloats: reader.pathMask(index),
          entryCount,
          bounds: reader.clipBounds(index),
          clipIndex,
        });
        clipStates.set(clipIndex, state);
      }
      return state;
    },
    payload(index) {
      const offset = recordOffset(index);
      const payloadOffset = view.getUint32(offset + RASTER_PLAN_RECORD_OFFSET_PAYLOAD, true);
      const payloadBytes = view.getUint32(offset + RASTER_PLAN_RECORD_OFFSET_PAYLOAD_BYTES, true);
      if ((payloadOffset & 3) !== 0 || (payloadBytes & 3) !== 0 || payloadOffset + payloadBytes > payloadRegionBytes) {
        throw new RangeError(
          `raster plan payload ${payloadOffset}..${payloadOffset + payloadBytes} exceeds ${payloadRegionBytes}-byte region`,
        );
      }
      return new Float32Array(
        memory.buffer,
        plan + payloadRegionOffset + payloadOffset,
        payloadBytes >>> 2,
      );
    },
    // The records a backend visits, in plan order, from one pass over the
    // record table. A draw may cover several consecutive records.
    // `raster_plan_prepare` writes one record per source command -- the
    // record directory doubles as the source-coverage map that
    // `raster_plan_validate` checks -- so records are never merged in WAT.
    // The JavaScript materializer that preceded it batched consecutive
    // rects, shadows and text runs under one clip and atlas into a single
    // instanced draw, and that is restored here in the reader instead,
    // where it costs no plan structure.
    //
    // Mergeable means: identical kind, clip, resource and flags, no
    // gradient on either side, and payloads that abut in plan order. Only
    // the instanced kinds qualify; images and SVG paths carry one logical
    // draw per record. Records that paint nothing are left out and do not
    // end a span: SET_NODE and SET_SCROLL, which both backends handle by
    // doing nothing (the command stream names the owning node before each
    // run, so an inline paragraph arrives as text, set-node, text, ...),
    // and instanced records with no payload, which is every record the
    // raster culled against its target. DAMAGE and the group and clip
    // records stay: damage changes the scissor, and a group boundary
    // redirects the target. A culled document is mostly empty records (the
    // Wikipedia scroll: 6,597 records, 231 draws), so the pass reads the
    // record table as words rather than one accessor call per field.
    //
    // Returns views valid until the next call on this reader: `count`
    // entries of `first` and `last` record, `instanceCount` over the
    // entry, `payloadStart`..`payloadEnd`, the entry's bytes in the
    // payload region, and four `bounds` floats, the union of the extents
    // its drawing records can write (RASTER_PLAN_RECORD_OFFSET_BOUNDS);
    // `uploadBytes`, the end of the last instanced payload (the prefix of
    // the payload region every draw reads from); and `pathMaskInUse`,
    // whether any record's clip carries an SVG path mask.
    drawSequence() {
      ensureCurrentMemory();
      if (((plan + recordTableOffset) & 3) !== 0) {
        throw new RangeError(
          `raster plan record table at ${plan + recordTableOffset} is not word aligned`,
        );
      }
      const words = new Uint32Array(
        memory.buffer,
        plan + recordTableOffset,
        recordCount * RECORD_WORDS,
      );
      const halves = new Uint16Array(
        memory.buffer,
        plan + recordTableOffset,
        recordCount * RECORD_WORDS * 2,
      );
      const floats = new Float32Array(
        memory.buffer,
        plan + recordTableOffset,
        recordCount * RECORD_WORDS,
      );
      if (sequence.first.length < recordCount) {
        const capacity = Math.max(recordCount, sequence.first.length * 2);
        sequence.first = new Uint32Array(capacity);
        sequence.last = new Uint32Array(capacity);
        sequence.instanceCount = new Uint32Array(capacity);
        sequence.payloadStart = new Uint32Array(capacity);
        sequence.payloadEnd = new Uint32Array(capacity);
        sequence.bounds = new Float32Array(capacity * 4);
      }
      if (clipsInUse.length < clipCount) {
        clipsInUse = new Uint8Array(Math.max(clipCount, clipsInUse.length * 2));
      } else {
        clipsInUse.fill(0, 0, clipCount);
      }
      const { first, last, instanceCount, payloadStart, payloadEnd, bounds } =
        sequence;
      let count = 0;
      let uploadBytes = 0;
      let index = 0;
      while (index < recordCount) {
        const word = index * RECORD_WORDS;
        const kind = halves[index * RECORD_WORDS * 2 + RECORD_HALF_KIND];
        const clip = words[word + RECORD_WORD_CLIP];
        if (clip !== RASTER_PLAN_NO_CLIP) {
          if (clip >= clipCount) {
            throw new RangeError(
              `raster plan clip index ${clip} exceeds count ${clipCount}`,
            );
          }
          clipsInUse[clip] = 1;
        }
        if (kind === CMD_SET_NODE || kind === CMD_SET_SCROLL) {
          index++;
          continue;
        }
        const start = words[word + RECORD_WORD_PAYLOAD];
        let end = start + words[word + RECORD_WORD_PAYLOAD_BYTES];
        let instances = words[word + RECORD_WORD_INSTANCE_COUNT];
        let spanLast = index;
        let minimumX = floats[word + RECORD_WORD_BOUNDS];
        let minimumY = floats[word + RECORD_WORD_BOUNDS + 1];
        let maximumX = floats[word + RECORD_WORD_BOUNDS + 2];
        let maximumY = floats[word + RECORD_WORD_BOUNDS + 3];
        if (spannableRecord(kind, words[word + RECORD_WORD_RESOURCE])) {
          if (instances === 0 && end === start) {
            index++;
            continue;
          }
          if (words[word + RECORD_WORD_GRADIENT_BYTES] === 0) {
            const resource = words[word + RECORD_WORD_RESOURCE];
            const flags = halves[index * RECORD_WORDS * 2 + RECORD_HALF_FLAGS];
            for (let next = index + 1; next < recordCount; next++) {
              const nextWord = next * RECORD_WORDS;
              const nextKind = halves[next * RECORD_WORDS * 2 + RECORD_HALF_KIND];
              const nextBytes = words[nextWord + RECORD_WORD_PAYLOAD_BYTES];
              const nextInstances = words[nextWord + RECORD_WORD_INSTANCE_COUNT];
              if (
                nextKind === CMD_SET_NODE || nextKind === CMD_SET_SCROLL ||
                (nextInstances === 0 && nextBytes === 0)
              ) {
                continue;
              }
              if (
                nextKind !== kind ||
                words[nextWord + RECORD_WORD_CLIP] !== clip ||
                words[nextWord + RECORD_WORD_RESOURCE] !== resource ||
                halves[next * RECORD_WORDS * 2 + RECORD_HALF_FLAGS] !== flags ||
                words[nextWord + RECORD_WORD_GRADIENT_BYTES] !== 0 ||
                words[nextWord + RECORD_WORD_PAYLOAD] !== end
              ) {
                break;
              }
              end += nextBytes;
              instances += nextInstances;
              spanLast = next;
              const nextBounds = nextWord + RECORD_WORD_BOUNDS;
              minimumX = Math.min(minimumX, floats[nextBounds]);
              minimumY = Math.min(minimumY, floats[nextBounds + 1]);
              maximumX = Math.max(maximumX, floats[nextBounds + 2]);
              maximumY = Math.max(maximumY, floats[nextBounds + 3]);
            }
          }
        } else if (kind === CMD_IMAGE || kind === CMD_SVG_PATH) {
          instances = 1;
        }
        if (instancedKind(kind)) {
          if (end === start) {
            index = spanLast + 1;
            continue;
          }
          if (end > payloadRegionBytes || (start & 3) !== 0 || (end & 3) !== 0) {
            throw new RangeError(
              `raster plan payload ${start}..${end} of record ${index} exceeds ${payloadRegionBytes}-byte region`,
            );
          }
          if (end > uploadBytes) uploadBytes = end;
        }
        first[count] = index;
        last[count] = spanLast;
        instanceCount[count] = instances;
        payloadStart[count] = start;
        payloadEnd[count] = end;
        bounds[count * 4] = minimumX;
        bounds[count * 4 + 1] = minimumY;
        bounds[count * 4 + 2] = maximumX;
        bounds[count * 4 + 3] = maximumY;
        count++;
        index = spanLast + 1;
      }
      let pathMaskInUse = false;
      for (let clip = 0; clip < clipCount && !pathMaskInUse; clip++) {
        if (clipsInUse[clip] === 0) continue;
        const mask = new Float32Array(
          memory.buffer,
          plan + clipTableOffset + clip * RASTER_PLAN_CLIP_ENTRY_SIZE + 4 +
            RASTER_PLAN_CLIP_FLOATS * 4,
          RASTER_PLAN_CLIP_PATH_MASK_FLOATS,
        );
        pathMaskInUse = mask.some((value) => value !== 0);
      }
      sequence.count = count;
      sequence.uploadBytes = uploadBytes;
      sequence.pathMaskInUse = pathMaskInUse;
      return sequence;
    },
    // Totals every backend-independent consumer reads from the record
    // table: the instances the records draw (a DAMAGE record's count is
    // its rectangles, which scissor and draw nothing), and whether any
    // record draws an image whose resource `imageKind` reports as live.
    recordTotals(imageKind) {
      ensureCurrentMemory();
      const words = new Uint32Array(
        memory.buffer,
        plan + recordTableOffset,
        recordCount * RECORD_WORDS,
      );
      const halves = new Uint16Array(
        memory.buffer,
        plan + recordTableOffset,
        recordCount * RECORD_WORDS * 2,
      );
      let instances = 0;
      let liveImage = false;
      for (let index = 0; index < recordCount; index++) {
        const word = index * RECORD_WORDS;
        const kind = halves[index * RECORD_WORDS * 2 + RECORD_HALF_KIND];
        if (kind !== CMD_DAMAGE) {
          instances += words[word + RECORD_WORD_INSTANCE_COUNT];
        }
        if (!liveImage && kind === CMD_IMAGE) {
          liveImage = imageKind(words[word + RECORD_WORD_RESOURCE]);
        }
      }
      return { instances, liveImage };
    },
    // The first `byteLength` bytes of the payload region.
    payloadRegion(byteLength) {
      ensureCurrentMemory();
      if (byteLength > payloadRegionBytes) {
        throw new RangeError(
          `raster plan payload prefix of ${byteLength} bytes exceeds the ${payloadRegionBytes}-byte region`,
        );
      }
      return new Uint8Array(
        memory.buffer,
        plan + payloadRegionOffset,
        byteLength,
      );
    },
    payloadOffset(index) {
      const offset = recordOffset(index);
      return view.getUint32(offset + RASTER_PLAN_RECORD_OFFSET_PAYLOAD, true);
    },
    payloadBytes(index) {
      const offset = recordOffset(index);
      return view.getUint32(offset + RASTER_PLAN_RECORD_OFFSET_PAYLOAD_BYTES, true);
    },
    gradientBytes(index) {
      const offset = recordOffset(index);
      return view.getUint32(offset + RASTER_PLAN_RECORD_OFFSET_GRADIENT_BYTES, true);
    },
    // The payload bytes `start..end` as one view; `drawSequence` names the
    // spans whose bytes are contiguous.
    payloadBytesView(start, end) {
      ensureCurrentMemory();
      if (
        (start & 3) !== 0 || (end & 3) !== 0 || start > end ||
        end > payloadRegionBytes
      ) {
        throw new RangeError(
          `raster plan payload span ${start}..${end} exceeds ${payloadRegionBytes}-byte region`,
        );
      }
      return new Float32Array(
        memory.buffer,
        plan + payloadRegionOffset + start,
        (end - start) >>> 2,
      );
    },
    instanceCount(index) {
      const offset = recordOffset(index);
      return view.getUint32(offset + RASTER_PLAN_RECORD_OFFSET_INSTANCE_COUNT, true);
    },
    resource(index) {
      const offset = recordOffset(index);
      return view.getUint32(offset + RASTER_PLAN_RECORD_OFFSET_RESOURCE, true);
    },
    gradient(index) {
      const offset = recordOffset(index);
      const gradientOffset = view.getUint32(
        offset + RASTER_PLAN_RECORD_OFFSET_GRADIENT,
        true,
      );
      const gradientBytes = view.getUint32(
        offset + RASTER_PLAN_RECORD_OFFSET_GRADIENT_BYTES,
        true,
      );
      if (
        (gradientOffset & 3) !== 0 || (gradientBytes & 3) !== 0 ||
        gradientOffset + gradientBytes > payloadRegionBytes
      ) {
        throw new RangeError(
          `raster plan gradient ${gradientOffset}..${gradientOffset + gradientBytes} exceeds ${payloadRegionBytes}-byte region`,
        );
      }
      return new Uint8Array(
        memory.buffer,
        plan + payloadRegionOffset + gradientOffset,
        gradientBytes,
      );
    },
    gradientParts(index) {
      const gradient = reader.gradient(index);
      if (gradient.byteLength === 0) return null;
      if (gradient.byteLength < GRADIENT_RECORD_STRIDE) {
        throw new Error(
          `raster plan gradient at record ${index} has ${gradient.byteLength} bytes; expected at least ${GRADIENT_RECORD_STRIDE}`,
        );
      }
      const gradientView = new DataView(
        gradient.buffer,
        gradient.byteOffset,
        gradient.byteLength,
      );
      const stopCount = gradientView.getUint32(12, true);
      const expectedBytes = GRADIENT_RECORD_STRIDE +
        stopCount * GRADIENT_STOP_STRIDE;
      if (gradient.byteLength !== expectedBytes) {
        throw new Error(
          `raster plan gradient at record ${index} has ${gradient.byteLength} bytes; expected ${expectedBytes}`,
        );
      }
      return {
        record: gradient.subarray(0, GRADIENT_RECORD_STRIDE),
        stops: gradient.subarray(GRADIENT_RECORD_STRIDE),
        stopCount,
      };
    },
    filterPasses(index, listOffset = 0) {
      const payload = reader.payload(index);
      if (payload.byteLength < listOffset + 4) {
        throw new Error(
          `native filter pass list at ${listOffset} exceeds ${payload.byteLength}-byte payload`,
        );
      }
      const passView = new DataView(
        payload.buffer,
        payload.byteOffset + listOffset,
        payload.byteLength - listOffset,
      );
      const count = passView.getUint32(0, true);
      const uniformBase = 4 + count * RASTER_PLAN_FILTER_DESCRIPTOR_BYTES;
      const requiredBytes = uniformBase +
        count * RASTER_PLAN_FILTER_UNIFORM_SLOT_BYTES;
      if (requiredBytes > passView.byteLength) {
        throw new Error(
          `native filter pass list requires ${requiredBytes} bytes; payload has ${passView.byteLength}`,
        );
      }
      const passes = [];
      for (let passIndex = 0; passIndex < count; passIndex++) {
        const descriptor = 4 +
          passIndex * RASTER_PLAN_FILTER_DESCRIPTOR_BYTES;
        const kind = passView.getUint32(descriptor, true);
        const uniformOffset = passView.getUint32(descriptor + 4, true);
        const uniformBytes = passView.getUint32(descriptor + 8, true);
        if (
          uniformOffset < uniformBase ||
          uniformOffset + uniformBytes > passView.byteLength ||
          (uniformOffset & 3) !== 0 || (uniformBytes & 3) !== 0
        ) {
          throw new Error(
            `native filter pass ${passIndex} uniform ${uniformOffset}..${uniformOffset + uniformBytes} exceeds ${passView.byteLength}-byte list`,
          );
        }
        passes.push({

          kind,
          uniform: new Float32Array(
            payload.buffer,
            payload.byteOffset + listOffset + uniformOffset,
            uniformBytes >>> 2,
          ),
        });
      }
      return passes;
    },
    refresh,
    get bytes() {
      ensureCurrentMemory();
      return bytes;
    },
  };

  return refresh();
}

// How far each filter pass list reads beyond the pixel it writes, in
// device pixels per axis: a box pass reads floor(width / 2) texels either
// side along its direction, a drop shadow reads its offset away, a matrix
// pass reads only its own pixel. reaches[2k], reaches[2k + 1] is the x and
// y reach of passes k..end, so reaches[0..1] is the outset the whole list
// needs around the frame for every frame pixel to see the content it reads
// (BUG-css-filter-blur-renormalises-at-the-frame-edge, resolved; see
// design/paint-coverage.md, "Filter passes"), and
// reaches[2k + 2..3] is the outset over which pass k's output is still read.
export function filterPassReaches(passes) {
  const reaches = new Int32Array(2 * passes.length + 2);
  for (let index = passes.length - 1; index >= 0; index--) {
    const { kind, uniform } = passes[index];
    let x = 0;
    let y = 0;
    if (
      kind === RASTER_PLAN_PASS_BOX_BLUR_H ||
      kind === RASTER_PLAN_PASS_BOX_BLUR_V
    ) {
      const radius = Math.floor(uniform[0] / 2);
      x = Math.ceil(radius * Math.abs(uniform[1]));
      y = Math.ceil(radius * Math.abs(uniform[2]));
    } else if (kind === RASTER_PLAN_PASS_DROP_SHADOW) {
      x = Math.ceil(Math.abs(uniform[0]));
      y = Math.ceil(Math.abs(uniform[1]));
    }
    reaches[2 * index] = reaches[2 * index + 2] + x;
    reaches[2 * index + 1] = reaches[2 * index + 3] + y;
  }
  return reaches;
}

// The padding, per side of one axis, of the texture a filter pass list
// runs on: the list's reach rounded up to FILTER_REGION_PADDING_QUANTUM, so
// a changing blur radius takes the same scratch textures frame after
// frame, and bounded by the largest texture the device can create
// (`maxExtent`). A list bounded there sees the box passes' own edge rule
// at the padded edge instead of the content it would read beyond it.
const FILTER_REGION_PADDING_QUANTUM = 64;
export function filterRegionPadding(reach, extent, maxExtent) {
  const padding = Math.ceil(reach / FILTER_REGION_PADDING_QUANTUM) *
    FILTER_REGION_PADDING_QUANTUM;
  return Math.min(padding, Math.floor((maxExtent - extent) / 2));
}

// One mutable cursor serves the complete frame. It walks the reader's draw
// sequence: selecting an entry changes only numeric indices, and payloads
// remain zero-copy views into the native plan. An entry may cover a SPAN of
// consecutive mergeable records, in which case `instances`, `count` and
// `gradients` describe the whole span and the backend issues one instanced
// draw for it.
export function createRasterPlanCursor(reader, resources = {}) {
  const sequence = reader.drawSequence();
  let entry = 0;
  let recordIndex = 0;
  let selectionGradients = null;
  let resolvedImages = resources.images ?? null;
  const cursor = {
    // The entries the backend visits, then the payload prefix every draw
    // reads from and whether any clip carries a path mask.
    get entryCount() {
      return sequence.count;
    },
    get uploadBytes() {
      return sequence.uploadBytes;
    },
    get pathMaskInUse() {
      return sequence.pathMaskInUse;
    },
    // Selects entry `index` and returns its first record.
    selectEntry(index) {
      entry = index;
      recordIndex = sequence.first[index];
      selectionGradients = null;
      return recordIndex;
    },
    setImages(images) {
      resolvedImages = images;
    },
    get clipState() {
      return reader.clipState(recordIndex);
    },
    get instances() {
      return reader.payloadBytesView(
        sequence.payloadStart[entry],
        sequence.payloadEnd[entry],
      );
    },
    // The selection's instance bytes within the payload region.
    get payloadByteOffset() {
      return sequence.payloadStart[entry];
    },
    get payloadByteLength() {
      return sequence.payloadEnd[entry] - sequence.payloadStart[entry];
    },
    // Whether the selection's draw can write a pixel of the device-pixel
    // rectangle `x, y, width, height`: its bounds, which hold every pixel
    // centre its quads cover, overlap the rectangle's interior.
    reaches(x, y, width, height) {
      const bounds = sequence.bounds;
      const at = entry * 4;
      return bounds[at] < x + width && bounds[at + 2] > x &&
        bounds[at + 1] < y + height && bounds[at + 3] > y;
    },
    get count() {
      return sequence.instanceCount[entry];
    },
    get resourceIndex() {
      return reader.resource(recordIndex);
    },
    get resourceGeneration() {
      return cursor.atlas?.revision ?? 0;
    },
    get atlas() {
      if (reader.kind(recordIndex) === CMD_TEXT) {
        const fontIndex = reader.resource(recordIndex);
        const atlas = resources.atlases?.get(fontIndex)?.atlas;
        if (!atlas) {
          throw new Error(
            `native CMD_TEXT resource ${fontIndex} is absent from the host atlas map`,
          );
        }
        return atlas;
      }
      const pathIndex = reader.resource(recordIndex);
      if (!resources.svgPathAtlas?.getPathByIndex(pathIndex)) {
        throw new Error(
          `native CMD_SVG_PATH resource ${pathIndex} is absent from the host path atlas`,
        );
      }
      return resources.svgPathAtlas;
    },
    get image() {
      const imageIndex = reader.resource(recordIndex);
      const image = resolvedImages?.get(imageIndex);
      if (image === undefined) {
        throw new Error(
          `native CMD_IMAGE resource ${imageIndex} is absent from the host image map`,
        );
      }
      return image;
    },
    get pixelated() {
      return (reader.flags(recordIndex) & CMD_IMAGE_FLAG_PIXELATED) !== 0;
    },
    get gradients() {
      if (selectionGradients !== null) return selectionGradients;
      // A span is gradient-free by construction (`drawSequence` refuses to
      // extend across a record that carries gradient bytes), so only the
      // selected record can contribute one.
      const gradient = reader.gradientParts(recordIndex);
      selectionGradients = Object.freeze(Array.from(
        { length: cursor.count },
        (_, index) => index === 0 ? gradient : null,
      ));
      return selectionGradients;
    },
    get gradient() {
      return reader.gradientParts(recordIndex);
    },
    get opacity() {
      return reader.payload(recordIndex)[0];
    },
    get blendMode() {
      return reader.kind(recordIndex) === CMD_PUSH_BLEND_LAYER
        ? reader.resource(recordIndex)
        : reader.payload(recordIndex)[1];
    },
    get filterPasses() {
      return reader.filterPasses(
        recordIndex,
        reader.kind(recordIndex) === CMD_PUSH_OPACITY
          ? RASTER_PLAN_FILTER_LIST_OFFSET
          : 0,
      );
    },
    get hasMask() {
      return (reader.payload(recordIndex)[2] & 1) !== 0;
    },
    get nativeComposite() {
      const payload = reader.payload(recordIndex);
      return payload.length === RASTER_PLAN_GROUP_POP_FLOATS ? payload : null;
    },
    get needsBackdropCopy() {
      return (reader.flags(recordIndex) &
        RASTER_PLAN_RECORD_FLAG_NEEDS_BACKDROP_COPY) !== 0;
    },
    get mode() {
      return new Uint32Array(
        reader.payload(recordIndex).buffer,
        reader.payload(recordIndex).byteOffset,
        2,
      )[0];
    },
    get composite() {
      return new Uint32Array(
        reader.payload(recordIndex).buffer,
        reader.payload(recordIndex).byteOffset,
        2,
      )[1];
    },
    get ownClipState() {
      return reader.clipState(recordIndex);
    },
    get rects() {
      const payload = reader.payload(recordIndex);
      const rects = [];
      for (let offset = 0; offset < payload.length; offset += 4) {
        rects.push({
          x: payload[offset],
          y: payload[offset + 1],
          w: payload[offset + 2],
          h: payload[offset + 3],
        });
      }
      return rects;
    },
  };
  return cursor;
}

// The device-pixel rectangles {x, y, w, h} that cover exactly the dirty
// tiles of a `width` × `height` target: each row's runs of adjacent dirty
// tiles, a run extending the rectangle that ends on the row above with the
// same columns. The rectangles are disjoint, the rule raster_plan_select
// writes its DAMAGE rectangles by (raster-plan.watpart).
export function dirtyTileRectangles(dirtyTiles, width, height, tileSize) {
  const columns = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);
  const rectangles = [];
  // Per column, the rectangle whose run starts there and ends on the
  // previous row.
  let previous = new Array(columns).fill(null);
  let current = new Array(columns).fill(null);
  for (let row = 0; row < rows; row++) {
    const y = row * tileSize;
    const h = Math.min(tileSize, height - y);
    current.fill(null);
    for (let column = 0; column < columns; column++) {
      if (!dirtyTiles[row * columns + column]) continue;
      let end = column + 1;
      while (end < columns && dirtyTiles[row * columns + end]) end++;
      const x = column * tileSize;
      const w = Math.min(end * tileSize, width) - x;
      let rectangle = previous[column];
      if (rectangle !== null && rectangle.w === w) {
        rectangle.h += h;
      } else {
        rectangle = { x, y, w, h };
        rectangles.push(rectangle);
      }
      current[column] = rectangle;
      column = end - 1;
    }
    [previous, current] = [current, previous];
  }
  return rectangles;
}

export function prepareRetainedRasterPlan(
  previous,
  options,
  width,
  height,
) {
  const publication = options.commandRetention;
  const rectangle = options.visibleRectangle;
  const background = options.background;
  const thickening = options.textThickening;
  const descriptor = options.rasterPlanDescriptor;
  const rasterPlan = options.rasterPlan;
  const key = [
    options.deviceScale ?? 1,
    options.renderMode ?? "standard",
    rectangle?.x,
    rectangle?.y,
    rectangle?.width,
    rectangle?.height,
    background?.r ?? 0,
    background?.g ?? 0,
    background?.b ?? 0,
    background?.a ?? 0,
    thickening?.lightInk ?? 0,
    thickening?.darkInk ?? 0,
    width,
    height,
    options.tileSize ?? 64,
  ];
  const reusable = publication?.owner != null &&
    publication.resourceRevision !== undefined &&
    previous?.publication?.owner === publication.owner &&
    previous.publication.resourceRevision === publication.resourceRevision &&
    previous.commandBytes === rasterPlan.bytes.byteLength &&
    previous.key.length === key.length &&
    previous.key.every((value, index) => value === key[index]) &&
    previous.plan === descriptor.plan &&
    !previous.liveCanvas;
  const rebuilt = !reusable;
  const changed = reusable &&
    previous.publication.revision !== publication.revision;
  const planReader = rebuilt || changed
    ? rasterPlan
    : previous.planReader.refresh();
  const tileSize = options.tileSize ?? 64;
  const needsIndex = publication?.owner != null || options.dirtyTiles != null;
  const indexed = needsIndex &&
    descriptor.exports.raster_plan_index(descriptor.plan, tileSize) === 1;
  const totals = planReader.recordTotals((imageIndex) =>
    options.images?.get(imageIndex)?.kind === "canvas"
  );
  const liveCanvas = totals.liveImage;
  const sameTarget = previous && previous.key.length === key.length &&
    previous.key.every((value, index) => value === key[index]);
  const samePublisher = publication?.owner != null
    ? previous?.publication?.owner === publication.owner
    : !previous?.publication;
  const validTarget = sameTarget && samePublisher &&
    !previous.liveCanvas && !liveCanvas && previous.indexed && indexed;
  let dirtyTiles = validTarget || (reusable && indexed)
    ? options.dirtyTiles
    : null;
  const requiresFullReplay =
    descriptor.exports.raster_plan_requires_full_replay(descriptor.plan) === 1;
  if (
    dirtyTiles != null && dirtyTiles.length > 0 &&
    dirtyTiles.every((value) => value !== 0)
  ) {
    dirtyTiles = null;
  }
  // A backend that scissors every draw to the dirty tiles itself (WebGPU,
  // rasterize.js renderFrame) replays the plan as it is; one that starts
  // unscissored (WebGL 2) replays the damage selection, whose DAMAGE record
  // scissors the draws after it. raster_plan_select copies the whole plan
  // to prefix that record.
  let selected = planReader;
  let replayPlan = 0;
  if (
    options.damageSelection === true &&
    !requiresFullReplay &&
    dirtyTiles != null &&
    dirtyTiles.some((value) => value !== 0)
  ) {
    const dirtyPointer = descriptor.exports.abi_malloc(dirtyTiles.byteLength);
    if (dirtyPointer === 0) {
      throw new Error(
        `raster_plan_select could not allocate ${dirtyTiles.byteLength} dirty-tile bytes`,
      );
    }
    try {
      new Uint8Array(
        descriptor.memory.buffer,
        dirtyPointer,
        dirtyTiles.byteLength,
      ).set(dirtyTiles);
      replayPlan = descriptor.exports.raster_plan_select(
        descriptor.plan,
        dirtyPointer,
        dirtyTiles.length,
      );
    } finally {
      descriptor.exports.abi_free(dirtyPointer);
    }
    if (replayPlan !== 0) {
      selected = openRasterPlan(descriptor.memory, replayPlan);
    }
  }
  const replayedInstances = selected === planReader
    ? totals.instances
    : selected.recordTotals(() => false).instances;
  return {
    state: {
      publication: publication ? { ...publication } : null,
      planReader,
      indexed,
      key,
      commandBytes: rasterPlan.bytes.byteLength,
      liveCanvas,
      plan: descriptor.plan,
    },
    dirtyTiles,
    requiresFullReplay,
    planReader: selected,
    release() {
      if (replayPlan !== 0) {
        descriptor.exports.raster_plan_release(replayPlan);
        replayPlan = 0;
      }
    },
    statistics: {
      rebuilt,
      decodedRecords: rebuilt
        ? rasterPlan.count
        : changed
        ? publication.ranges.length
        : 0,
      replayedInstances,
      replayedBatches: selected.count,
      // The replay is the plan's damage selection (raster_plan_select).
      damageSelected: selected !== planReader,
    },
  };
}
