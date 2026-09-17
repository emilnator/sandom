// Bespoke WebGPU pass for the device viewer.
//
// Draws a parsed device model with the live sandom render texture mapped
// onto the generated screen plate. Runs on the SAME GPUDevice as the sandom
// rasterizer, sampling its persistent main texture directly — zero copies.
// Queue submission order keeps the sampled texture consistent: rotation
// frames between sandom frames re-sample whatever the texture last held.
//
// Shading is deliberately small: two directional lights, a hemispheric
// ambient, a procedural two-tone environment reflection with Schlick
// fresnel, and a soft contact-shadow disc under the floating device.
// The canvas clears to transparent and outputs premultiplied alpha.

import { buildScreenMesh, deviceBounds } from "./device-model.js";
import { materialForNode } from "./device-catalog.js";

const MULTISAMPLE_COUNT = 4;
const DEPTH_FORMAT = "depth24plus";
const IDLE_YAW_RADIANS_PER_SECOND = 0.22;
const IDLE_RESUME_DELAY_MILLISECONDS = 2500;
const CAMERA_FIELD_OF_VIEW_RADIANS = 26 * Math.PI / 180;
const CAMERA_ELEVATION_RADIANS = 13 * Math.PI / 180;
const SHADOW_GAP_FRACTION = 0.16;
const SHADOW_OPACITY = 0.3;

const SHARED_SHADER_FUNCTIONS = /* wgsl */ `
struct FrameUniforms {
  viewProjection: mat4x4<f32>,
  model: mat4x4<f32>,
  cameraPosition: vec4<f32>,
};

fn encodeSrgb(linear: vec3<f32>) -> vec3<f32> {
  let cutoff = linear < vec3<f32>(0.0031308);
  let low = linear * 12.92;
  let high = 1.055 * pow(max(linear, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.4)) -
    0.055;
  return select(high, low, cutoff);
}
`;

const BODY_SHADER = /* wgsl */ `
${SHARED_SHADER_FUNCTIONS}

struct MeshUniforms {
  baseColor: vec4<f32>,
  // x = metallic, y = roughness
  parameters: vec4<f32>,
};

@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(0) @binding(1) var<uniform> mesh: MeshUniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) worldPosition: vec3<f32>,
  @location(1) worldNormal: vec3<f32>,
};

@vertex
fn vertexMain(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
) -> VertexOutput {
  var output: VertexOutput;
  let world = frame.model * vec4<f32>(position, 1.0);
  output.worldPosition = world.xyz;
  output.worldNormal = (frame.model * vec4<f32>(normal, 0.0)).xyz;
  output.position = frame.viewProjection * world;
  return output;
}

fn environment(direction: vec3<f32>) -> vec3<f32> {
  let vertical = direction.y * 0.5 + 0.5;
  let ground = vec3<f32>(0.10, 0.10, 0.115);
  let sky = vec3<f32>(0.55, 0.59, 0.66);
  // A soft bright band near the horizon reads as a studio backdrop.
  let horizon = exp(-abs(direction.y) * 4.0) * vec3<f32>(0.24, 0.25, 0.27);
  return mix(ground, sky, vertical) + horizon;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  var normal = normalize(input.worldNormal);
  let toCamera = normalize(frame.cameraPosition.xyz - input.worldPosition);
  // The models are tessellated double-sided; flip toward the camera.
  if (dot(normal, toCamera) < 0.0) {
    normal = -normal;
  }
  let metallic = mesh.parameters.x;
  let roughness = clamp(mesh.parameters.y, 0.03, 1.0);
  let baseColor = mesh.baseColor.rgb;
  let specularColor = mix(vec3<f32>(0.04), baseColor, metallic);
  let diffuseColor = baseColor * (1.0 - metallic);

  let hemisphere = mix(
    vec3<f32>(0.16, 0.16, 0.18),
    vec3<f32>(0.40, 0.42, 0.46),
    normal.y * 0.5 + 0.5,
  );
  var color = diffuseColor * hemisphere;

  let exponent = 2.0 / (roughness * roughness * roughness * roughness) - 2.0;
  let keyDirection = normalize(vec3<f32>(0.45, 0.75, 0.55));
  let fillDirection = normalize(vec3<f32>(-0.65, 0.15, -0.35));
  var lightDirections = array<vec3<f32>, 2>(keyDirection, fillDirection);
  var lightColors = array<vec3<f32>, 2>(
    vec3<f32>(1.9, 1.85, 1.75),
    vec3<f32>(0.5, 0.54, 0.62),
  );
  for (var index = 0u; index < 2u; index++) {
    let lightDirection = lightDirections[index];
    let lambert = max(dot(normal, lightDirection), 0.0);
    if (lambert <= 0.0) {
      continue;
    }
    let halfVector = normalize(lightDirection + toCamera);
    let specularFalloff = pow(max(dot(normal, halfVector), 0.0), exponent) *
      (exponent + 8.0) / 25.0;
    let fresnel = specularColor +
      (vec3<f32>(1.0) - specularColor) *
        pow(1.0 - max(dot(halfVector, toCamera), 0.0), 5.0);
    color += lightColors[index] * lambert *
      (diffuseColor + specularFalloff * fresnel);
  }

  let reflected = reflect(-toCamera, normal);
  let viewFresnel = specularColor +
    (vec3<f32>(1.0) - specularColor) *
      pow(1.0 - max(dot(normal, toCamera), 0.0), 5.0);
  color += environment(reflected) * viewFresnel *
    mix(0.4, 1.0, metallic) * (1.0 - roughness * 0.7);

  return vec4<f32>(encodeSrgb(color), 1.0);
}
`;

const SCREEN_SHADER = /* wgsl */ `
${SHARED_SHADER_FUNCTIONS}

@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(0) @binding(1) var screenSampler: sampler;
@group(0) @binding(2) var screenTexture: texture_2d<f32>;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) textureCoordinates: vec2<f32>,
};

@vertex
fn vertexMain(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) textureCoordinates: vec2<f32>,
) -> VertexOutput {
  var output: VertexOutput;
  output.position = frame.viewProjection * frame.model *
    vec4<f32>(position, 1.0);
  output.textureCoordinates = textureCoordinates;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  // The sandom texture is premultiplied in the presentation encoding.
  // An unlit panel composites the document over the dark screen, exactly
  // like pixels light on hardware: rgb over black keeps rgb, alpha
  // becomes opaque glass.
  let sample = textureSample(
    screenTexture,
    screenSampler,
    input.textureCoordinates,
  );
  return vec4<f32>(sample.rgb, 1.0);
}
`;

const SHADOW_SHADER = /* wgsl */ `
${SHARED_SHADER_FUNCTIONS}

@group(0) @binding(0) var<uniform> frame: FrameUniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) discCoordinates: vec2<f32>,
};

@vertex
fn vertexMain(
  @location(0) position: vec3<f32>,
  @location(1) discCoordinates: vec2<f32>,
) -> VertexOutput {
  var output: VertexOutput;
  output.position = frame.viewProjection * frame.model *
    vec4<f32>(position, 1.0);
  output.discCoordinates = discCoordinates;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let distance = length(input.discCoordinates);
  let alpha = smoothstep(1.0, 0.15, distance) * ${SHADOW_OPACITY};
  // Premultiplied black.
  return vec4<f32>(0.0, 0.0, 0.0, alpha);
}
`;

function createMeshBuffers(device, primitive) {
  const buffers = {};
  buffers.positions = device.createBuffer({
    size: primitive.positions.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffers.positions, 0, primitive.positions);
  buffers.normals = device.createBuffer({
    size: primitive.normals.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffers.normals, 0, primitive.normals);
  if (primitive.uvs) {
    buffers.uvs = device.createBuffer({
      size: primitive.uvs.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffers.uvs, 0, primitive.uvs);
  }
  const indexFormat = primitive.indices instanceof Uint32Array
    ? "uint32"
    : "uint16";
  const paddedLength = Math.ceil(primitive.indices.byteLength / 4) * 4;
  buffers.indices = device.createBuffer({
    size: paddedLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffers.indices, 0, primitive.indices);
  return {
    ...buffers,
    indexFormat,
    indexCount: primitive.indices.length,
  };
}

function perspective(fieldOfView, aspect, near, far) {
  const focal = 1 / Math.tan(fieldOfView / 2);
  return new Float32Array([
    focal / aspect, 0, 0, 0,
    0, focal, 0, 0,
    0, 0, far / (near - far), -1,
    0, 0, (far * near) / (near - far), 0,
  ]);
}

function lookAt(eye, target, up) {
  const forward = normalize3(subtract3(eye, target));
  const right = normalize3(cross3(up, forward));
  const trueUp = cross3(forward, right);
  return new Float32Array([
    right[0], trueUp[0], forward[0], 0,
    right[1], trueUp[1], forward[1], 0,
    right[2], trueUp[2], forward[2], 0,
    -dot3(right, eye), -dot3(trueUp, eye), -dot3(forward, eye), 1,
  ]);
}

function subtract3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize3(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function multiply4(a, b) {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[k * 4 + row] * b[column * 4 + k];
      }
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

// Model matrix: translate to origin, stand upright when the pose asks for
// it, then spin about the world Y axis.
function modelMatrix(yaw, pose, center) {
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const yawMatrix = new Float32Array([
    cosYaw, 0, -sinYaw, 0,
    0, 1, 0, 0,
    sinYaw, 0, cosYaw, 0,
    0, 0, 0, 1,
  ]);
  // Standing pose: rotate +90 degrees about X (GLB +Y normal becomes +Z).
  const poseMatrix = pose === "standing"
    ? new Float32Array([
      1, 0, 0, 0,
      0, 0, 1, 0,
      0, -1, 0, 0,
      0, 0, 0, 1,
    ])
    : new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]);
  const translation = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    -center[0], -center[1], -center[2], 1,
  ]);
  return multiply4(yawMatrix, multiply4(poseMatrix, translation));
}

function posedExtents(bounds, pose) {
  const corners = [];
  for (const x of [bounds.minimum[0], bounds.maximum[0]]) {
    for (const y of [bounds.minimum[1], bounds.maximum[1]]) {
      for (const z of [bounds.minimum[2], bounds.maximum[2]]) {
        const centered = [
          x - bounds.center[0],
          y - bounds.center[1],
          z - bounds.center[2],
        ];
        corners.push(
          pose === "standing"
            ? [centered[0], centered[2], -centered[1]]
            : centered,
        );
      }
    }
  }
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const corner of corners) {
    for (let axis = 0; axis < 3; axis++) {
      if (corner[axis] < minimum[axis]) minimum[axis] = corner[axis];
      if (corner[axis] > maximum[axis]) maximum[axis] = corner[axis];
    }
  }
  return { minimum, maximum };
}

const FRAME_UNIFORM_BYTES = 144;
const MESH_UNIFORM_STRIDE = 256;

export function createDeviceScene({
  device,
  canvas,
  primitives,
  screen,
  pose,
  initialYaw = -0.5,
}) {
  const context = canvas.getContext("webgpu");
  if (!context) {
    throw new Error("Device viewer requires a WebGPU canvas context");
  }
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "premultiplied" });

  const bounds = deviceBounds(primitives);
  const extents = posedExtents(bounds, pose);
  const framingRadius = Math.max(
    Math.hypot(extents.maximum[0], extents.maximum[1]),
    Math.hypot(extents.minimum[0], extents.minimum[1]),
    bounds.radius * 0.85,
  );
  const groundY = extents.minimum[1] -
    (extents.maximum[1] - extents.minimum[1]) * SHADOW_GAP_FRACTION;

  const meshes = primitives.map((primitive) => ({
    buffers: createMeshBuffers(device, primitive),
    baseColor: primitive.baseColor,
    material: materialForNode(primitive.name),
  }));
  const screenMesh = createMeshBuffers(device, buildScreenMesh(screen));

  // Contact shadow quad on the ground plane, sized to the posed footprint.
  const shadowHalfX = (extents.maximum[0] - extents.minimum[0]) * 0.62;
  const shadowHalfZ = (extents.maximum[2] - extents.minimum[2]) * 0.62;
  // The shadow vertex positions are authored in the centered, posed world
  // frame at ground height; only the yaw spin applies to them, keeping the
  // ellipse aligned with the device footprint.
  const shadowPositions = new Float32Array([
    -shadowHalfX, groundY, -shadowHalfZ,
    shadowHalfX, groundY, -shadowHalfZ,
    shadowHalfX, groundY, shadowHalfZ,
    -shadowHalfX, groundY, shadowHalfZ,
  ]);
  const shadowDisc = new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]);
  const shadowIndices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const shadowBuffers = {
    positions: device.createBuffer({
      size: shadowPositions.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    }),
    disc: device.createBuffer({
      size: shadowDisc.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    }),
    indices: device.createBuffer({
      size: shadowIndices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    }),
  };
  device.queue.writeBuffer(shadowBuffers.positions, 0, shadowPositions);
  device.queue.writeBuffer(shadowBuffers.disc, 0, shadowDisc);
  device.queue.writeBuffer(shadowBuffers.indices, 0, shadowIndices);

  const frameUniformBuffer = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const shadowFrameUniformBuffer = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const meshUniformBuffer = device.createBuffer({
    size: MESH_UNIFORM_STRIDE * meshes.length,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  meshes.forEach((mesh, index) => {
    const data = new Float32Array(8);
    data.set(mesh.baseColor, 0);
    data[4] = mesh.material.metallic;
    data[5] = mesh.material.roughness;
    device.queue.writeBuffer(
      meshUniformBuffer,
      index * MESH_UNIFORM_STRIDE,
      data,
    );
  });

  const bodyModule = device.createShaderModule({ code: BODY_SHADER });
  const screenModule = device.createShaderModule({ code: SCREEN_SHADER });
  const shadowModule = device.createShaderModule({ code: SHADOW_SHADER });

  const multisampleState = { count: MULTISAMPLE_COUNT };
  const depthState = {
    format: DEPTH_FORMAT,
    depthWriteEnabled: true,
    depthCompare: "less",
  };
  const premultipliedBlend = {
    color: {
      srcFactor: "one",
      dstFactor: "one-minus-src-alpha",
      operation: "add",
    },
    alpha: {
      srcFactor: "one",
      dstFactor: "one-minus-src-alpha",
      operation: "add",
    },
  };

  const bodyPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: bodyModule,
      entryPoint: "vertexMain",
      buffers: [
        {
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
        },
        {
          arrayStride: 12,
          attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" }],
        },
      ],
    },
    fragment: {
      module: bodyModule,
      entryPoint: "fragmentMain",
      targets: [{ format, blend: premultipliedBlend }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: depthState,
    multisample: multisampleState,
  });

  const screenPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: screenModule,
      entryPoint: "vertexMain",
      buffers: [
        {
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
        },
        {
          arrayStride: 12,
          attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" }],
        },
        {
          arrayStride: 8,
          attributes: [{ shaderLocation: 2, offset: 0, format: "float32x2" }],
        },
      ],
    },
    fragment: {
      module: screenModule,
      entryPoint: "fragmentMain",
      targets: [{ format, blend: premultipliedBlend }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: depthState,
    multisample: multisampleState,
  });

  const shadowPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: shadowModule,
      entryPoint: "vertexMain",
      buffers: [
        {
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
        },
        {
          arrayStride: 8,
          attributes: [{ shaderLocation: 1, offset: 0, format: "float32x2" }],
        },
      ],
    },
    fragment: {
      module: shadowModule,
      entryPoint: "fragmentMain",
      targets: [{ format, blend: premultipliedBlend }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: DEPTH_FORMAT,
      depthWriteEnabled: false,
      depthCompare: "less",
    },
    multisample: multisampleState,
  });

  const meshBindGroups = meshes.map((_, index) =>
    device.createBindGroup({
      layout: bodyPipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: {
            buffer: frameUniformBuffer,
            size: FRAME_UNIFORM_BYTES,
          },
        },
        {
          binding: 1,
          resource: {
            buffer: meshUniformBuffer,
            offset: index * MESH_UNIFORM_STRIDE,
            size: 32,
          },
        },
      ],
    })
  );
  const shadowBindGroup = device.createBindGroup({
    layout: shadowPipeline.getBindGroupLayout(0),
    entries: [
      {
        binding: 0,
        resource: {
          buffer: shadowFrameUniformBuffer,
          size: FRAME_UNIFORM_BYTES,
        },
      },
    ],
  });

  const screenSampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
  });
  let screenBindGroup = null;
  let screenTexture = null;

  let colorTarget = null;
  let depthTarget = null;
  let targetWidth = 0;
  let targetHeight = 0;

  function ensureTargets() {
    if (
      colorTarget !== null && targetWidth === canvas.width &&
      targetHeight === canvas.height
    ) {
      return;
    }
    colorTarget?.destroy();
    depthTarget?.destroy();
    targetWidth = canvas.width;
    targetHeight = canvas.height;
    colorTarget = device.createTexture({
      size: { width: targetWidth, height: targetHeight },
      sampleCount: MULTISAMPLE_COUNT,
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    depthTarget = device.createTexture({
      size: { width: targetWidth, height: targetHeight },
      sampleCount: MULTISAMPLE_COUNT,
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  const state = {
    yaw: initialYaw,
    lastFrameTime: null,
    lastInteractionTime: -Infinity,
  };

  return Object.freeze({
    // The GPUDevice this scene's resources live on. The persistent scene
    // renderer destroys and replaces its device when the document viewport
    // changes, so the worker compares this against each presented frame's
    // device and rebuilds the scene on mismatch.
    device,
    currentYaw() {
      return state.yaw;
    },
    // Re-adopt the shared canvas after another cached scene presented on
    // it, and drop the frame-time base so the idle spin does not jump by
    // the time this scene spent inactive.
    activate() {
      context.configure({ device, format, alphaMode: "premultiplied" });
      state.lastFrameTime = null;
    },
    setScreenTexture(textureImage) {
      if (screenTexture === textureImage.texture) return;
      screenTexture = textureImage.texture;
      screenBindGroup = device.createBindGroup({
        layout: screenPipeline.getBindGroupLayout(0),
        entries: [
          {
            binding: 0,
            resource: {
              buffer: frameUniformBuffer,
              size: FRAME_UNIFORM_BYTES,
            },
          },
          { binding: 1, resource: screenSampler },
          { binding: 2, resource: screenTexture.createView() },
        ],
      });
    },
    // Casts the canvas pixel through the camera onto the screen plane and
    // returns viewport-relative coordinates: {x, y} in 0..1 (clamped) plus
    // an `inside` flag for the unclamped rectangle. Returns null when the
    // screen faces away from the camera or lies parallel to the ray.
    screenPointFromCanvas(canvasX, canvasY) {
      if (targetWidth === 0 || targetHeight === 0) return null;
      const aspect = targetWidth / targetHeight;
      const distance = framingRadius /
        Math.tan(CAMERA_FIELD_OF_VIEW_RADIANS / 2) * 1.18;
      const eye = [
        0,
        Math.sin(CAMERA_ELEVATION_RADIANS) * distance,
        Math.cos(CAMERA_ELEVATION_RADIANS) * distance,
      ];
      // Camera basis, matching lookAt(eye, origin, +Y): backward points
      // from the origin toward the eye.
      const backward = normalize3(eye);
      const right = normalize3(cross3([0, 1, 0], backward));
      const trueUp = cross3(backward, right);
      const halfTangent = Math.tan(CAMERA_FIELD_OF_VIEW_RADIANS / 2);
      const ndcX = (canvasX / targetWidth) * 2 - 1;
      const ndcY = 1 - (canvasY / targetHeight) * 2;
      const cameraX = ndcX * halfTangent * aspect;
      const cameraY = ndcY * halfTangent;
      const direction = normalize3([
        right[0] * cameraX + trueUp[0] * cameraY - backward[0],
        right[1] * cameraX + trueUp[1] * cameraY - backward[1],
        right[2] * cameraX + trueUp[2] * cameraY - backward[2],
      ]);
      const model = modelMatrix(state.yaw, pose, bounds.center);
      const point = (p) => [
        model[0] * p[0] + model[4] * p[1] + model[8] * p[2] + model[12],
        model[1] * p[0] + model[5] * p[1] + model[9] * p[2] + model[13],
        model[2] * p[0] + model[6] * p[1] + model[10] * p[2] + model[14],
      ];
      const rotate = (v) => [
        model[0] * v[0] + model[4] * v[1] + model[8] * v[2],
        model[1] * v[0] + model[5] * v[1] + model[9] * v[2],
        model[2] * v[0] + model[6] * v[1] + model[10] * v[2],
      ];
      const planePoint = point(screen.center);
      const planeNormal = rotate(screen.normal);
      const facing = dot3(direction, planeNormal);
      // The screen must face the camera; a near-parallel ray has no
      // usable intersection either.
      if (facing > -1e-6) return null;
      const t = dot3(subtract3(planePoint, eye), planeNormal) / facing;
      if (t <= 0) return null;
      const hit = [
        eye[0] + direction[0] * t,
        eye[1] + direction[1] * t,
        eye[2] + direction[2] * t,
      ];
      const offset = subtract3(hit, planePoint);
      const along = dot3(offset, rotate(screen.uDirection));
      const down = dot3(offset, rotate(screen.vDirection));
      const inside = Math.abs(along) <= screen.uHalfExtent &&
        Math.abs(down) <= screen.vHalfExtent;
      return {
        x: Math.min(1, Math.max(0, along / (2 * screen.uHalfExtent) + 0.5)),
        y: Math.min(1, Math.max(0, down / (2 * screen.vHalfExtent) + 0.5)),
        inside,
      };
    },
    orbitBy(deltaYawRadians, timeMilliseconds) {
      state.yaw += deltaYawRadians;
      state.lastInteractionTime = timeMilliseconds;
    },
    render(timeMilliseconds) {
      ensureTargets();
      if (state.lastFrameTime !== null) {
        const elapsed = (timeMilliseconds - state.lastFrameTime) / 1000;
        if (
          timeMilliseconds - state.lastInteractionTime >=
            IDLE_RESUME_DELAY_MILLISECONDS
        ) {
          state.yaw += IDLE_YAW_RADIANS_PER_SECOND * elapsed;
        }
      }
      state.lastFrameTime = timeMilliseconds;

      const aspect = targetWidth / targetHeight;
      const distance = framingRadius /
        Math.tan(CAMERA_FIELD_OF_VIEW_RADIANS / 2) * 1.18;
      const eye = [
        0,
        Math.sin(CAMERA_ELEVATION_RADIANS) * distance,
        Math.cos(CAMERA_ELEVATION_RADIANS) * distance,
      ];
      const viewProjection = multiply4(
        perspective(
          CAMERA_FIELD_OF_VIEW_RADIANS,
          aspect,
          distance / 20,
          distance * 4,
        ),
        lookAt(eye, [0, 0, 0], [0, 1, 0]),
      );
      const model = modelMatrix(state.yaw, pose, bounds.center);

      const frameData = new Float32Array(36);
      frameData.set(viewProjection, 0);
      frameData.set(model, 16);
      frameData.set([...eye, 1], 32);
      device.queue.writeBuffer(frameUniformBuffer, 0, frameData);

      // The shadow ignores the device pose/centering: its quad is authored
      // in the posed frame already, sitting on the ground plane.
      const shadowModel = modelMatrix(state.yaw, "grounded", [0, 0, 0]);
      const shadowFrameData = new Float32Array(36);
      shadowFrameData.set(viewProjection, 0);
      shadowFrameData.set(shadowModel, 16);
      shadowFrameData.set([...eye, 1], 32);
      device.queue.writeBuffer(shadowFrameUniformBuffer, 0, shadowFrameData);

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: colorTarget.createView(),
          resolveTarget: context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "discard",
        }],
        depthStencilAttachment: {
          view: depthTarget.createView(),
          depthClearValue: 1,
          depthLoadOp: "clear",
          depthStoreOp: "discard",
        },
      });

      pass.setPipeline(shadowPipeline);
      pass.setBindGroup(0, shadowBindGroup);
      pass.setVertexBuffer(0, shadowBuffers.positions);
      pass.setVertexBuffer(1, shadowBuffers.disc);
      pass.setIndexBuffer(shadowBuffers.indices, "uint16");
      pass.drawIndexed(6);

      pass.setPipeline(bodyPipeline);
      meshes.forEach((mesh, index) => {
        pass.setBindGroup(0, meshBindGroups[index]);
        pass.setVertexBuffer(0, mesh.buffers.positions);
        pass.setVertexBuffer(1, mesh.buffers.normals);
        pass.setIndexBuffer(mesh.buffers.indices, mesh.buffers.indexFormat);
        pass.drawIndexed(mesh.buffers.indexCount);
      });

      if (screenBindGroup !== null) {
        pass.setPipeline(screenPipeline);
        pass.setBindGroup(0, screenBindGroup);
        pass.setVertexBuffer(0, screenMesh.positions);
        pass.setVertexBuffer(1, screenMesh.normals);
        pass.setVertexBuffer(2, screenMesh.uvs);
        pass.setIndexBuffer(screenMesh.indices, screenMesh.indexFormat);
        pass.drawIndexed(screenMesh.indexCount);
      }

      pass.end();
      device.queue.submit([encoder.finish()]);
    },
    destroy() {
      context.unconfigure();
      colorTarget?.destroy();
      depthTarget?.destroy();
      for (const mesh of meshes) {
        mesh.buffers.positions.destroy();
        mesh.buffers.normals.destroy();
        mesh.buffers.indices.destroy();
      }
      screenMesh.positions.destroy();
      screenMesh.normals.destroy();
      screenMesh.uvs.destroy();
      screenMesh.indices.destroy();
      shadowBuffers.positions.destroy();
      shadowBuffers.disc.destroy();
      shadowBuffers.indices.destroy();
      frameUniformBuffer.destroy();
      shadowFrameUniformBuffer.destroy();
      meshUniformBuffer.destroy();
    },
  });
}
