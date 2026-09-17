// Streaming fragmented-MP4 box demuxer.
//
// ffmpeg, run with `-movflags frag_keyframe+empty_moov+default_base_moof`,
// writes a fragmented MP4 to stdout as a flat byte stream of ISO-BMFF boxes:
//
//   ftyp  moov  [moof mdat]  [moof mdat]  ...  (mfra at EOF)
//
// For Media Source Extensions the client needs two things, cleanly separated:
//   - an INITIALIZATION segment: ftyp + moov (the decoder setup), sent once.
//   - MEDIA segments: each moof + mdat pair (one fragment of frames), appended
//     in order as they arrive.
//
// The prototype found these boundaries by scanning the raw bytes for the ASCII
// "moof". That is wrong: the bytes 6D 6F 6F 66 can occur inside an mdat payload
// (encoded video is arbitrary bytes), and a boundary that straddles two reads
// is missed entirely. This parser instead walks the actual box structure —
// every box is a big-endian uint32 size followed by a 4-char type — and buffers
// across read boundaries, so it is correct regardless of how ffmpeg happens to
// chunk its output.
//
// Each box's first 8 bytes are: size (uint32 BE) | type (4 ASCII bytes). A size
// of 1 means a 64-bit size follows the type (largesize); a size of 0 means "to
// end of stream". ffmpeg's fMP4 fragments use neither for the boxes we emit,
// but we handle largesize defensively and treat size 0 as "wait for more".

const BOX_HEADER_BYTES = 8;

function boxType(bytes, offset) {
  return String.fromCharCode(
    bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7],
  );
}

// Read a box's total length at `offset`, or null if there aren't enough bytes
// buffered yet to know it (header incomplete, or 64-bit size not yet present).
function boxLength(bytes, view, offset) {
  if (offset + BOX_HEADER_BYTES > bytes.length) return null;
  const size32 = view.getUint32(offset, false);
  if (size32 === 1) {
    // 64-bit largesize lives in the 8 bytes after the type.
    if (offset + 16 > bytes.length) return null;
    const high = view.getUint32(offset + 8, false);
    const low = view.getUint32(offset + 12, false);
    return high * 0x100000000 + low;
  }
  if (size32 === 0) return null; // "to end of stream" — can't delimit a live box.
  return size32;
}

// Create a demuxer. Push raw bytes from ffmpeg stdout via push(); it invokes:
//   onInit(Uint8Array)    once, when ftyp+moov are complete.
//   onSegment(Uint8Array) for each complete moof+mdat media segment.
// Boxes other than ftyp/moov/moof/mdat (e.g. a trailing mfra) are parsed and
// skipped so they never corrupt the stream.
export function createMp4Demuxer({ onInit, onSegment }) {
  // Pending unparsed bytes carried across reads.
  let pending = new Uint8Array(0);

  // Init-segment assembly: collect ftyp and moov, emit once both are seen.
  let sawFtyp = false;
  let sawMoov = false;
  let initEmitted = false;
  const initBoxes = [];

  // Current media segment under assembly: a moof awaiting its mdat.
  let pendingMoof = null;

  function append(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  function emitInitIfReady() {
    if (initEmitted || !sawFtyp || !sawMoov) return;
    let total = 0;
    for (const b of initBoxes) total += b.length;
    const init = new Uint8Array(total);
    let off = 0;
    for (const b of initBoxes) { init.set(b, off); off += b.length; }
    initEmitted = true;
    onInit(init);
  }

  function handleBox(type, box) {
    if (type === 'ftyp') {
      initBoxes.length = 0;            // ftyp starts a fresh init segment.
      initBoxes.push(box);
      sawFtyp = true;
      sawMoov = false;
      initEmitted = false;
    } else if (type === 'moov') {
      initBoxes.push(box);
      sawMoov = true;
      emitInitIfReady();
    } else if (type === 'moof') {
      pendingMoof = box;               // hold until its mdat arrives.
    } else if (type === 'mdat') {
      if (pendingMoof) {
        onSegment(append(pendingMoof, box));
        pendingMoof = null;
      }
      // An mdat with no preceding moof is malformed for fMP4; drop it.
    }
    // Any other box type (mfra, free, etc.) is parsed for its length and
    // skipped — it is neither init nor media.
  }

  return {
    push(chunk) {
      pending = pending.length === 0
        ? (chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk))
        : append(pending, chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));

      const view = new DataView(pending.buffer, pending.byteOffset, pending.byteLength);
      let offset = 0;

      while (true) {
        const len = boxLength(pending, view, offset);
        if (len === null) break;            // need more bytes to size this box.
        if (len < BOX_HEADER_BYTES) {
          // Corrupt/degenerate size; cannot make progress safely.
          throw new Error(`mp4 demux: invalid box length ${len} at offset ${offset}`);
        }
        if (offset + len > pending.length) break; // box not fully buffered yet.

        const type = boxType(pending, offset);
        // Copy the box out so retaining it doesn't pin the whole pending buffer.
        handleBox(type, pending.slice(offset, offset + len));
        offset += len;
      }

      // Drop fully-consumed bytes from the front of pending.
      pending = offset === 0 ? pending : pending.slice(offset);
    },

    get initEmitted() { return initEmitted; },
  };
}
