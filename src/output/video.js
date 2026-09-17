// Streaming video backend — feeds raw frames to ffmpeg via stdin
// (wide-color plan, package 6: explicit output requests and color
// metadata; no request is inferred from a filename or extension).
//
// Usage:
//   const recorder = await createRecorder({
//     width, height, output,
//     outputRequest: { format: 'video' },              // BT.709 8-bit
//   });
//   recorder.writeFrame(frame);   // a working render result, called per frame
//   await recorder.finish();      // closes stdin, waits for ffmpeg to exit
//
// A standard-dynamic-range request encodes eight-bit `yuv420p` with BT.709
// primaries, transfer, and matrix flags. A high-dynamic-range request (PQ
// or HLG) encodes ten-bit `yuv420p10le` through libx265 with Rec. 2020
// flags plus mastering-display and content-light metadata. `h264` cannot
// carry those fields and rejects a high-dynamic-range request before any
// process starts.

import { validateOutputRequest } from "./image.js";
import { packSignal } from "./packing.js";
import { transformImageForOutput } from "./color-transform.js";

const TRANSFER_FLAGS = { pq: "smpte2084", hlg: "arib-std-b67" };

// Builds the complete ffmpeg invocation plan for one validated request.
// Pure - exported for tests to inspect without spawning a process.
export function buildRecorderPlan(validated, { width, height, output }) {
  const codec = validated.codecOptions.codec ??
    (validated.dynamicRange === "high" ? "hevc" : "h264");
  const container = validated.codecOptions.container ?? "mp4";
  const frameRate = validated.codecOptions.frameRate ?? 30;
  if (validated.dynamicRange === "high" && codec === "h264") {
    throw new Error(
      "video output: h264 cannot preserve Rec. 2100 transfer and mastering metadata; " +
        "request the hevc codec for high-dynamic-range output",
    );
  }
  if (validated.bitDepth === 10 && codec === "h264") {
    throw new Error("video output: h264 output is eight-bit; ten-bit output requires hevc");
  }
  const high = validated.dynamicRange === "high";
  const inputPixelFormat = high ? "rgba64le" : "rgba";
  const args = [
    "-y",
    "-f", "rawvideo",
    "-pix_fmt", inputPixelFormat,
    "-s", `${width}x${height}`,
    "-r", String(frameRate),
    "-i", "pipe:0",
  ];
  if (high) {
    const transferFlag = TRANSFER_FLAGS[validated.colorEncoding.transferFunction];
    const x265Params = [
      `colorprim=bt2020`,
      `transfer=${transferFlag}`,
      `colormatrix=bt2020nc`,
      `master-display=` + masterDisplayX265(validated.masteringDisplay),
    ];
    if (validated.contentLightLevel !== null) {
      x265Params.push(
        `max-cll=${Math.round(validated.contentLightLevel.maxContentLightLevel)},${
          Math.round(validated.contentLightLevel.maxFrameAverageLightLevel)
        }`,
      );
    }
    args.push(
      "-c:v", "libx265",
      "-pix_fmt", "yuv420p10le",
      "-preset", "fast",
      "-crf", "18",
      "-color_primaries", "bt2020",
      "-color_trc", transferFlag,
      "-colorspace", "bt2020nc",
      "-x265-params", x265Params.join(":"),
    );
  } else {
    args.push(
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-preset", "fast",
      "-crf", "18",
      "-color_primaries", "bt709",
      "-color_trc", "bt709",
      "-colorspace", "bt709",
      "-color_range", "tv",
    );
  }
  args.push("-f", container === "mkv" ? "matroska" : "mp4", output);
  return { args, inputPixelFormat, codec, container, frameRate };
}

// x265 master-display string: G/B/R/WP in 0.00002 chromaticity units,
// L(max,min) in 0.0001 candela units, Rec. 2020 mastering primaries.
function masterDisplayX265(masteringDisplay) {
  const unit = (v) => Math.round(v / 0.00002);
  const green = `G(${unit(0.17)},${unit(0.797)})`;
  const blue = `B(${unit(0.131)},${unit(0.046)})`;
  const red = `R(${unit(0.708)},${unit(0.292)})`;
  const white = `WP(${unit(0.3127)},${unit(0.329)})`;
  const luminance = `L(${Math.round(masteringDisplay.maxLuminance * 10000)},${
    Math.round(masteringDisplay.minLuminance * 10000)
  })`;
  return `${green}${blue}${red}${white}${luminance}`;
}

// Packs one transformed signal frame into the ffmpeg input pixel format:
// 8-bit RGBA bytes, or 16-bit little-endian RGBA words for the
// high-dynamic-range path.
function packSignalFrame(signal, high) {
  return packSignal(signal, high ? 16 : 8);
}

export function createRecorder(options) {
  const { width, height, output, outputRequest } = options;
  if (outputRequest === undefined) {
    throw new Error(
      "createRecorder requires an explicit outputRequest; requests are never inferred from the output filename",
    );
  }
  const validated = validateOutputRequest(outputRequest);
  if (validated.format !== "video") {
    throw new Error(`createRecorder requires format "video", got "${validated.format}"`);
  }
  const plan = buildRecorderPlan(validated, { width, height, output });
  const high = validated.dynamicRange === "high";

  const process = new Deno.Command("ffmpeg", {
    args: plan.args,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const writer = process.stdin.getWriter();
  let frameCount = 0;

  return {
    async writeFrame(frame) {
      // A working render result transforms through the central path. A
      // plain Uint8Array is an already-encoded byte-domain frame
      // (diagnostic sinks) and passes through on the eight-bit path only.
      if (frame instanceof Uint8Array) {
        if (high) {
          throw new Error(
            "video output: a high-dynamic-range stream requires working render results, not byte frames",
          );
        }
        await writer.write(frame);
      } else {
        const { pixels } = transformImageForOutput(frame, validated);
        await writer.write(packSignalFrame(pixels, high));
      }
      frameCount++;
    },

    async finish() {
      await writer.close();
      const { code, stderr } = await process.output();
      if (code !== 0) {
        const err = new TextDecoder().decode(stderr);
        throw new Error(`ffmpeg exited with code ${code}: ${err}`);
      }
      return { frameCount };
    },
  };
}
