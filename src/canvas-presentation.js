import { linearRgbToWorkingMatrix } from "./color.js";

export function createCanvasPresenter({
  canvas,
  device,
  renderMode = "standard",
  extended = false,
  colorSpace = extended ? "display-p3" : "srgb",
  alphaMode = renderMode === "high-dynamic-range" ? "opaque" : "premultiplied",
}) {
  const isHTMLCanvas = typeof HTMLCanvasElement !== "undefined" &&
    canvas instanceof HTMLCanvasElement;
  const isOffscreenCanvas = typeof OffscreenCanvas !== "undefined" &&
    canvas instanceof OffscreenCanvas;
  if (!isHTMLCanvas && !isOffscreenCanvas) {
    throw new TypeError(
      "createCanvasPresenter: canvas must be an HTMLCanvasElement or OffscreenCanvas",
    );
  }
  if (!device || typeof device.createShaderModule !== "function") {
    throw new TypeError("createCanvasPresenter: device must be a GPUDevice");
  }
  if (renderMode !== "standard" && renderMode !== "high-dynamic-range") {
    throw new RangeError(
      `createCanvasPresenter: unknown render mode "${renderMode}"`,
    );
  }
  if (renderMode === "high-dynamic-range" && !extended) {
    throw new Error(
      "createCanvasPresenter: high-dynamic-range rendering requires an extended rgba16float canvas",
    );
  }

  const context = canvas.getContext("webgpu");
  if (!context) {
    throw new Error(
      "createCanvasPresenter: the browser did not provide a WebGPU canvas",
    );
  }
  const format = extended
    ? "rgba16float"
    : navigator.gpu.getPreferredCanvasFormat();
  if (colorSpace !== "srgb" && colorSpace !== "display-p3") {
    throw new RangeError(
      `createCanvasPresenter: unknown canvas color space "${colorSpace}"`,
    );
  }
  context.configure({
    device,
    format,
    colorSpace,
    alphaMode,
    toneMapping: { mode: extended ? "extended" : "standard" },
  });

  // The canvas interprets its pixels in `colorSpace`. The working texture
  // holds the mode's working encoding, so presentation must express those
  // values in the canvas's own space:
  //
  // - standard mode, srgb canvas: the extended sign-mirrored encoded-sRGB
  //   working values ARE srgb canvas values - plain copy.
  // - standard mode, display-p3 canvas: decode the sign-mirrored sRGB
  //   transfer, convert linear sRGB into linear display-p3, re-encode.
  //   Copying without converting re-tags sRGB numbers as p3 and shifts
  //   every color; wide-gamut working components (outside [0, 1] in sRGB
  //   terms) land inside the p3 unit range instead of surviving as
  //   extended values the compositor may clip.
  // - high-dynamic-range mode: working is linear Rec. 2020; convert into
  //   the canvas primaries and encode with the sign-mirrored sRGB curve
  //   (display-p3 and srgb share that transfer).
  let fragmentBody = `
  let sampled = textureSample(renderedTexture, renderedSampler, input.textureCoordinates);
  if (sampled.a == 0.0) { return vec4f(0.0); }
  return sampled;`;
  let colorFunctions = "";
  const conversionFragmentBody = (matrix, decode) => `
  let sampled = textureSample(renderedTexture, renderedSampler, input.textureCoordinates);
  if (sampled.a == 0.0) { return vec4f(0.0); }
  let straight = ${decode ? "decodeSrgb(sampled.rgb / sampled.a)" : "sampled.rgb / sampled.a"};
  let encoded = encodeSrgb(mat3x3f(
    ${matrix[0][0]}, ${matrix[1][0]}, ${matrix[2][0]},
    ${matrix[0][1]}, ${matrix[1][1]}, ${matrix[2][1]},
    ${matrix[0][2]}, ${matrix[1][2]}, ${matrix[2][2]},
  ) * straight);
  return vec4f(encoded * sampled.a, sampled.a);`;
  const transferFunctions = `
fn decodeSrgb(value: vec3f) -> vec3f {
  let sign = select(vec3f(1.0), vec3f(-1.0), value < vec3f(0.0));
  let magnitude = abs(value);
  return sign * select(
    pow((magnitude + vec3f(0.055)) / 1.055, vec3f(2.4)),
    magnitude / 12.92,
    magnitude <= vec3f(0.04045),
  );
}
fn encodeSrgb(value: vec3f) -> vec3f {
  let sign = select(vec3f(1.0), vec3f(-1.0), value < vec3f(0.0));
  let magnitude = abs(value);
  return sign * select(
    1.055 * pow(magnitude, vec3f(1.0 / 2.4)) - 0.055,
    12.92 * magnitude,
    magnitude <= vec3f(0.0031308),
  );
}`;
  if (renderMode === "high-dynamic-range") {
    colorFunctions = transferFunctions;
    fragmentBody = conversionFragmentBody(
      linearRgbToWorkingMatrix("rec2020", colorSpace),
      false,
    );
  } else if (colorSpace === "display-p3") {
    colorFunctions = transferFunctions;
    fragmentBody = conversionFragmentBody(
      linearRgbToWorkingMatrix("srgb", "display-p3"),
      true,
    );
  }

  const shaderModule = device.createShaderModule({
    code: `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) textureCoordinates: vec2f,
}
@vertex fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  let positions = array(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let textureCoordinates = array(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0),
    vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0),
  );
  var output: VertexOutput;
  output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  output.textureCoordinates = textureCoordinates[vertexIndex];
  return output;
}
@group(0) @binding(0) var renderedTexture: texture_2d<f32>;
@group(0) @binding(1) var renderedSampler: sampler;
${colorFunctions}
@fragment fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  ${fragmentBody}
}
`,
  });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: shaderModule, entryPoint: "vertexMain" },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      targets: [{ format }],
    },
    primitive: { topology: "triangle-list" },
  });
  const sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
  });

  return Object.freeze({
    format,
    dynamicRange: extended ? "high-dynamic-range" : "standard",
    present(textureImage) {
      if (!textureImage?.texture) {
        throw new TypeError("canvas presenter requires a GPU texture image");
      }
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: textureImage.texture.createView() },
          { binding: 1, resource: sampler },
        ],
      });
      const commandEncoder = device.createCommandEncoder();
      const renderPass = commandEncoder.beginRenderPass({
        colorAttachments: [{
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      renderPass.setPipeline(pipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.draw(6);
      renderPass.end();
      device.queue.submit([commandEncoder.finish()]);
    },
    destroy() {
      context.unconfigure();
    },
  });
}
