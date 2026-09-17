// Device model loading for the device viewer.
//
// Parses the checked-in device GLBs (plain accessors, no compression, no
// textures — see models/devices/*/part.py) and generates the screen plate
// mesh from the device metadata. The screen plate is generated here, not
// modeled in CAD, so its shape and UV mapping derive from the same
// device.json record the viewer maps the sandom render with.

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const COMPONENT_ARRAYS = new Map([
  [5121, Uint8Array],
  [5123, Uint16Array],
  [5125, Uint32Array],
  [5126, Float32Array],
]);

const TYPE_COMPONENT_COUNTS = new Map([
  ["SCALAR", 1],
  ["VEC2", 2],
  ["VEC3", 3],
  ["VEC4", 4],
]);

function accessorArray(json, binary, accessorIndex) {
  const accessor = json.accessors[accessorIndex];
  const ArrayType = COMPONENT_ARRAYS.get(accessor.componentType);
  const componentCount = TYPE_COMPONENT_COUNTS.get(accessor.type);
  if (!ArrayType || !componentCount) {
    throw new Error(
      `Unsupported accessor ${accessor.type}/${accessor.componentType}`,
    );
  }
  const view = json.bufferViews[accessor.bufferView];
  const byteOffset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const elementBytes = ArrayType.BYTES_PER_ELEMENT * componentCount;
  const stride = view.byteStride ?? elementBytes;
  if (stride === elementBytes) {
    return new ArrayType(
      binary.buffer,
      binary.byteOffset + byteOffset,
      accessor.count * componentCount,
    ).slice();
  }
  if (stride % ArrayType.BYTES_PER_ELEMENT !== 0) {
    throw new Error(`Unaligned byte stride ${stride}`);
  }
  const componentStride = stride / ArrayType.BYTES_PER_ELEMENT;
  const strided = new ArrayType(
    binary.buffer,
    binary.byteOffset + byteOffset,
    (accessor.count - 1) * componentStride + componentCount,
  );
  const output = new ArrayType(accessor.count * componentCount);
  for (let element = 0; element < accessor.count; element++) {
    for (let component = 0; component < componentCount; component++) {
      output[element * componentCount + component] =
        strided[element * componentStride + component];
    }
  }
  return output;
}

// Column-major 4x4 helpers, sized for this parser's needs only.
function composeTransform(node) {
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function multiplyTransforms(a, b) {
  const out = new Array(16);
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

function transformPositions(positions, matrix) {
  for (let index = 0; index < positions.length; index += 3) {
    const x = positions[index];
    const y = positions[index + 1];
    const z = positions[index + 2];
    positions[index] = matrix[0] * x + matrix[4] * y + matrix[8] * z +
      matrix[12];
    positions[index + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z +
      matrix[13];
    positions[index + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z +
      matrix[14];
  }
}

// The device transforms are rigid (rotation + translation, unit scale), so
// normals transform by the same rotation block.
function transformNormals(normals, matrix) {
  for (let index = 0; index < normals.length; index += 3) {
    const x = normals[index];
    const y = normals[index + 1];
    const z = normals[index + 2];
    normals[index] = matrix[0] * x + matrix[4] * y + matrix[8] * z;
    normals[index + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z;
    normals[index + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z;
  }
}

export function parseDeviceGLB(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2) {
    throw new Error("Not a GLB version 2 file");
  }
  let offset = 12;
  let json = null;
  let binary = null;
  while (offset < view.byteLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkKind = view.getUint32(offset + 4, true);
    const chunk = bytes.subarray(offset + 8, offset + 8 + chunkLength);
    if (chunkKind === CHUNK_JSON) {
      json = JSON.parse(new TextDecoder().decode(chunk));
    } else if (chunkKind === CHUNK_BIN) {
      binary = chunk;
    }
    offset += 8 + chunkLength;
  }
  if (json === null || binary === null) {
    throw new Error("GLB is missing its JSON or binary chunk");
  }
  const required = json.extensionsRequired ?? [];
  if (required.length > 0) {
    throw new Error(
      `GLB requires unsupported extensions: ${required.join(", ")}`,
    );
  }
  const primitives = [];
  const visit = (nodeIndex, parentMatrix) => {
    const node = json.nodes[nodeIndex];
    const matrix = multiplyTransforms(parentMatrix, composeTransform(node));
    if (node.mesh !== undefined) {
      for (const primitive of json.meshes[node.mesh].primitives) {
        if ((primitive.mode ?? 4) !== 4) {
          throw new Error("Only triangle primitives are supported");
        }
        const positions = accessorArray(
          json,
          binary,
          primitive.attributes.POSITION,
        );
        const normals = accessorArray(
          json,
          binary,
          primitive.attributes.NORMAL,
        );
        transformPositions(positions, matrix);
        transformNormals(normals, matrix);
        const material = primitive.material === undefined
          ? null
          : json.materials[primitive.material];
        primitives.push({
          name: node.name ?? `node-${nodeIndex}`,
          positions,
          normals,
          indices: accessorArray(json, binary, primitive.indices),
          // glTF baseColorFactor is linear RGBA.
          baseColor: material?.pbrMetallicRoughness?.baseColorFactor ??
            [1, 1, 1, 1],
        });
      }
    }
    for (const child of node.children ?? []) visit(child, matrix);
  };
  const identity = composeTransform({});
  for (const root of json.scenes[json.scene ?? 0].nodes) {
    visit(root, identity);
  }
  return primitives;
}

// Rounded-rectangle screen plate from the device.json screen record.
// The outline is convex, so a center fan triangulates it. UV (0,0) is the
// viewport's top left; u follows uDirection, v follows vDirection.
const SCREEN_CORNER_SEGMENTS = 10;
const SCREEN_PROUD_MILLIMETERS = 0.12;

export function buildScreenMesh(screen) {
  const { uHalfExtent, vHalfExtent, cornerRadius } = screen;
  const [cx, cy, cz] = screen.center;
  const [nx, ny, nz] = screen.normal;
  const [ux, uy, uz] = screen.uDirection;
  const [vx, vy, vz] = screen.vDirection;
  const outline = [];
  // Corner centers in (u, v) screen coordinates, counter-clockwise when
  // viewed against the normal; the arc sweep per corner is 90 degrees.
  const corners = [
    [uHalfExtent - cornerRadius, vHalfExtent - cornerRadius, 0],
    [-(uHalfExtent - cornerRadius), vHalfExtent - cornerRadius, 90],
    [-(uHalfExtent - cornerRadius), -(vHalfExtent - cornerRadius), 180],
    [uHalfExtent - cornerRadius, -(vHalfExtent - cornerRadius), 270],
  ];
  for (const [centerU, centerV, startDegrees] of corners) {
    for (let segment = 0; segment <= SCREEN_CORNER_SEGMENTS; segment++) {
      const angle = (startDegrees + 90 * segment / SCREEN_CORNER_SEGMENTS) *
        Math.PI / 180;
      outline.push([
        centerU + cornerRadius * Math.cos(angle),
        centerV + cornerRadius * Math.sin(angle),
      ]);
    }
  }
  const vertexCount = outline.length + 1;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const emit = (index, u, v) => {
    positions[index * 3] = cx + ux * u + vx * v +
      nx * SCREEN_PROUD_MILLIMETERS;
    positions[index * 3 + 1] = cy + uy * u + vy * v +
      ny * SCREEN_PROUD_MILLIMETERS;
    positions[index * 3 + 2] = cz + uz * u + vz * v +
      nz * SCREEN_PROUD_MILLIMETERS;
    normals[index * 3] = nx;
    normals[index * 3 + 1] = ny;
    normals[index * 3 + 2] = nz;
    uvs[index * 2] = u / (2 * uHalfExtent) + 0.5;
    uvs[index * 2 + 1] = v / (2 * vHalfExtent) + 0.5;
  };
  emit(0, 0, 0);
  outline.forEach(([u, v], index) => emit(index + 1, u, v));
  const indices = new Uint16Array(outline.length * 3);
  for (let index = 0; index < outline.length; index++) {
    const next = (index + 1) % outline.length;
    indices[index * 3] = 0;
    indices[index * 3 + 1] = 1 + index;
    indices[index * 3 + 2] = 1 + next;
  }
  return { positions, normals, uvs, indices };
}

export function deviceBounds(primitives) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const { positions } of primitives) {
    for (let index = 0; index < positions.length; index += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const value = positions[index + axis];
        if (value < minimum[axis]) minimum[axis] = value;
        if (value > maximum[axis]) maximum[axis] = value;
      }
    }
  }
  const center = [
    (minimum[0] + maximum[0]) / 2,
    (minimum[1] + maximum[1]) / 2,
    (minimum[2] + maximum[2]) / 2,
  ];
  const radius = Math.hypot(
    maximum[0] - center[0],
    maximum[1] - center[1],
    maximum[2] - center[2],
  );
  return { minimum, maximum, center, radius };
}
