// Shatter: a settings page on a pane of glass. Click the glass between the
// controls and it breaks from that point into Voronoi shards; every shard
// keeps its slice of the same live Sandom texture, so the toggles still flip
// and the animations still run on a shard lying on the floor.
//
// One GPUDevice serves Sandom and three.js. Sandom renders the document into
// a GPUTexture on that device and three.js samples it as an ExternalTexture,
// with no readback. A pointer hit on any shard gives a UV, the UV is a
// document coordinate, and the document receives a real pointer event
// through bindProjectedInput. One render surface lives as long as the page:
// a toggle flip changes one checkbox, and the surface's loop renders the
// frames that change and the frames the CSS animations advance.

import * as THREE from "three";
import {
  bindProjectedInput,
  createRenderSurface,
  createSandomDOM,
  createSceneRenderer,
  createTexturePresenter,
  loadFont,
} from "sandom";
import { impactSeeds, mulberry32, shardGeometry, voronoiCells } from "./fracture.js";
import { DOCUMENT_HEIGHT, DOCUMENT_HTML, DOCUMENT_WIDTH } from "./ui-document.js";

const PANE_WIDTH = 1.6;
const PANE_HEIGHT = 2.0;
const PANE_THICKNESS = 0.035;
const PANE_CENTER_Y = PANE_HEIGHT / 2 + 0.02;
const FLOOR_Y = 0;
// Texture pixels per document pixel, fixed for the surface's life: the pane
// fills about half the window's height, so 2 keeps text sharp on a
// high-density screen.
const TEXTURE_SCALE = 2;
const STEP_SECONDS = 1 / 60;
const MAX_STEPS = 60 * 10;
// Slower than Earth on purpose: at full gravity the whole fall is over in
// half a second, which reads as a cut rather than a break.
const GRAVITY = -4.2;
const RESTITUTION = 0.28;
const INTACT_HINT = "Flip a toggle, or click the glass between controls to shatter it.";

const notice = document.getElementById("notice");
const canvas = document.getElementById("scene");
const reassembleButton = document.getElementById("reassemble");
const statusLine = document.getElementById("status");
const hint = document.getElementById("hint");
const fail = (message) => {
  notice.textContent = message;
  throw new Error(message);
};

if (!navigator.gpu) fail("This example needs WebGPU: Sandom and three.js share one GPUDevice.");
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) fail("This browser exposes WebGPU but found no GPU adapter.");
const device = await adapter.requestDevice();

// Sandom draws only the fonts it is given. The package ships both families
// the document names; Inter is variable, so one file covers 400 and 600.
const fontDirectory = new URL("../test-assets/", import.meta.resolve("sandom"));
await Promise.all([
  loadFont("Inter", new URL("Inter-Variable.ttf", fontDirectory), { weight: [100, 900] }),
  loadFont("IBM Plex Mono", new URL("IBMPlexMono-Regular.ttf", fontDirectory)),
]);

// ---------------------------------------------------------------- Sandom

const dom = createSandomDOM({
  viewportW: DOCUMENT_WIDTH,
  viewportH: DOCUMENT_HEIGHT,
  deviceScale: TEXTURE_SCALE,
});
const root = dom.createElement("main");
dom.document.appendChild(root);
root.innerHTML = DOCUMENT_HTML;
const toggles = [...root.querySelectorAll(".row input")];

const screenMaterial = new THREE.MeshPhysicalMaterial({
  color: 0x151515,
  emissive: 0xffffff,
  emissiveIntensity: 1,
  roughness: 0.12,
  metalness: 0,
  clearcoat: 1,
  clearcoatRoughness: 0.08,
});
const edgeMaterial = new THREE.MeshPhysicalMaterial({
  color: 0x5fa892,
  roughness: 0.15,
  metalness: 0.1,
  clearcoat: 1,
  clearcoatRoughness: 0.1,
});

// The presenter calls onTexture only when Sandom's target texture changes
// identity; every other frame lands in the texture three.js already samples.
let externalTexture = null;
const presenter = createTexturePresenter({
  device,
  onTexture(texture) {
    externalTexture?.dispose();
    externalTexture = new THREE.ExternalTexture(texture);
    externalTexture.colorSpace = THREE.SRGBColorSpace;
    externalTexture.minFilter = THREE.LinearFilter;
    externalTexture.magFilter = THREE.LinearFilter;
    externalTexture.generateMipmaps = false;
    externalTexture.flipY = true;
    externalTexture.needsUpdate = true;
    screenMaterial.map = externalTexture;
    screenMaterial.emissiveMap = externalTexture;
    screenMaterial.needsUpdate = true;
  },
});

// The scene draws only when it has something new to show. requestRender
// asks for one host frame; a request made before the scene exists (the
// first Sandom frame) is drawn once it does.
let renderQueued = false;
let sceneReady = false;
function requestRender() {
  if (renderQueued || !sceneReady) return;
  renderQueued = true;
  requestAnimationFrame(renderFrame);
}

const surface = createRenderSurface(root, {
  viewportWidth: DOCUMENT_WIDTH,
  viewportHeight: DOCUMENT_HEIGHT,
  deviceScale: TEXTURE_SCALE,
  createPersistentRenderer: (options) =>
    createSceneRenderer({ ...options, graphicsDevice: device }),
  // A presented frame lands in the texture the scene samples; draw it.
  presentFrame(frame) {
    presenter.presentFrame(frame);
    requestRender();
  },
});
await surface.renderNow(); // input needs a presented frame
surface.start();

// --------------------------------------------------------------- three.js

const threeRenderer = new THREE.WebGPURenderer({ canvas, device, antialias: true });
await threeRenderer.init();
threeRenderer.shadowMap.enabled = true;
threeRenderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070a);
scene.fog = new THREE.Fog(0x05070a, 6, 14);

// Two camera poses: facing the standing pane, and looking down on the
// floor where the shards land. The camera eases to the pose that matches
// the glass, so the fallen UI reads at a size a pointer can hit.
const PANE_VIEW = { position: new THREE.Vector3(0, 2.1, 5.2), target: new THREE.Vector3(0, 0.75, 0.2) };
const FLOOR_VIEW = { position: new THREE.Vector3(0, 3.6, 1.6), target: new THREE.Vector3(0, 0, -0.8) };
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 40);
const cameraTarget = PANE_VIEW.target.clone();
camera.position.copy(PANE_VIEW.position);
camera.lookAt(cameraTarget);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(16, 16),
  new THREE.MeshStandardMaterial({ color: 0x0b0f14, roughness: 0.35, metalness: 0.05 }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = FLOOR_Y;
floor.receiveShadow = true;
scene.add(floor);

scene.add(new THREE.HemisphereLight(0x2a3a4a, 0x05070a, 0.8));
const keyLight = new THREE.SpotLight(0xdfe9ff, 60, 14, 0.7, 0.6, 1.4);
keyLight.position.set(2.4, 4.2, 3.2);
keyLight.target.position.set(0, 0.8, 0);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.bias = -0.0004;
scene.add(keyLight, keyLight.target);
const rimLight = new THREE.PointLight(0x3ddc97, 8, 8, 1.6);
rimLight.position.set(-2.2, 2.4, -1.4);
scene.add(rimLight);

const shardGroup = new THREE.Group();
scene.add(shardGroup);

// A shard record: the mesh, its rest position, its bounding radius, and
// contact vertices for the floor test. Every mesh shares screenMaterial,
// so every shard samples the one live texture.
let shards = [];
let trajectory = null; // Float32Array, MAX_STEPS × shards × 7
let recordedSteps = 0;
let playbackStep = 0;
let playing = false;
let reassembling = false;
let intact = true;

function buildPane(polygons) {
  for (const shard of shards) {
    shardGroup.remove(shard.mesh);
    shard.mesh.geometry.dispose();
  }
  shards = polygons.map((polygon) => {
    const built = shardGeometry({
      polygon,
      width: PANE_WIDTH,
      height: PANE_HEIGHT,
      thickness: PANE_THICKNESS,
    });
    const mesh = new THREE.Mesh(built.geometry, [screenMaterial, edgeMaterial]);
    mesh.position.set(built.centroid.x, built.centroid.y + PANE_CENTER_Y, 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    shardGroup.add(mesh);
    return {
      mesh,
      rest: mesh.position.clone(),
      radius: built.radius,
      contactPoints: built.contactPoints,
    };
  });
}

const wholePane = [
  { x: -PANE_WIDTH / 2, y: -PANE_HEIGHT / 2 },
  { x: PANE_WIDTH / 2, y: -PANE_HEIGHT / 2 },
  { x: PANE_WIDTH / 2, y: PANE_HEIGHT / 2 },
  { x: -PANE_WIDTH / 2, y: PANE_HEIGHT / 2 },
];
buildPane([wholePane]);

// ---------------------------------------------------------------- physics
//
// Simulated in full at impact time, step by step, into `trajectory`; the
// render loop only plays the recording, forwards for the fall and backwards
// to reassemble, so both are deterministic.

const scratchVector = new THREE.Vector3();
const scratchMatrix = new THREE.Matrix4();
const scratchQuaternion = new THREE.Quaternion();

function shatter(impact) {
  const random = mulberry32(
    Math.floor((impact.x + 1) * 10007) ^ Math.floor((impact.y + 1) * 30011),
  );
  const seeds = impactSeeds({
    width: PANE_WIDTH,
    height: PANE_HEIGHT,
    impact,
    random,
  });
  buildPane(voronoiCells({ width: PANE_WIDTH, height: PANE_HEIGHT, seeds }));

  const count = shards.length;
  const bodies = shards.map((shard) => {
    const dx = shard.rest.x - impact.x;
    const dy = shard.rest.y - PANE_CENTER_Y - impact.y;
    const distance = Math.hypot(dx, dy);
    const falloff = 1 / (1 + distance * 3.5);
    const outward = distance > 1e-4 ? 1 / distance : 0;
    const velocity = new THREE.Vector3(
      dx * outward * (0.6 + random() * 0.6) * falloff * 2.2,
      dy * outward * (0.6 + random() * 0.6) * falloff * 2.2 + 0.4 * falloff,
      0,
    );
    const fallTime = (velocity.y + Math.sqrt(velocity.y ** 2 - 2 * GRAVITY * (shard.rest.y - FLOOR_Y))) /
      -GRAVITY;
    // The pane topples backwards as it breaks: a shard travels away from
    // the camera by about its height above the pane's bottom edge, so the
    // pieces land spread out in the order they hung, not in one heap.
    const heightInPane = shard.rest.y - (PANE_CENTER_Y - PANE_HEIGHT / 2);
    velocity.z = -(0.85 * heightInPane) / fallTime - (0.2 + random() * 0.4) * falloff;
    return {
      position: shard.rest.clone(),
      quaternion: new THREE.Quaternion(),
      velocity,
      // A negative spin about x tips the top edge away from the camera. A
      // quarter turn over the fall lands the shard face up, its UI upright
      // to the camera.
      angularVelocity: new THREE.Vector3(
        -(Math.PI / 2) / fallTime * (0.85 + random() * 0.3),
        (random() - 0.5) * 3 * falloff,
        (random() - 0.5) * 2 * falloff,
      ),
      asleep: false,
    };
  });

  trajectory = new Float32Array(MAX_STEPS * count * 7);
  const write = (step) => {
    let offset = step * count * 7;
    for (const body of bodies) {
      trajectory[offset++] = body.position.x;
      trajectory[offset++] = body.position.y;
      trajectory[offset++] = body.position.z;
      trajectory[offset++] = body.quaternion.x;
      trajectory[offset++] = body.quaternion.y;
      trajectory[offset++] = body.quaternion.z;
      trajectory[offset++] = body.quaternion.w;
    }
  };
  write(0);
  let step = 1;
  for (; step < MAX_STEPS; step++) {
    let awake = 0;
    for (let index = 0; index < count; index++) {
      const body = bodies[index];
      if (body.asleep) continue;
      awake++;
      const shard = shards[index];
      body.velocity.y += GRAVITY * STEP_SECONDS;
      body.position.addScaledVector(body.velocity, STEP_SECONDS);
      const spin = body.angularVelocity.length();
      if (spin > 1e-6) {
        scratchVector.copy(body.angularVelocity).divideScalar(spin);
        scratchQuaternion.setFromAxisAngle(scratchVector, spin * STEP_SECONDS);
        body.quaternion.premultiply(scratchQuaternion).normalize();
      }
      // Floor contact: the lowest transformed vertex of either ring.
      scratchMatrix.makeRotationFromQuaternion(body.quaternion);
      const points = shard.contactPoints;
      let lowest = Infinity;
      let lowestX = 0;
      let lowestZ = 0;
      for (let offset = 0; offset < points.length; offset += 3) {
        scratchVector.set(points[offset], points[offset + 1], points[offset + 2])
          .applyMatrix4(scratchMatrix);
        if (scratchVector.y < lowest) {
          lowest = scratchVector.y;
          lowestX = scratchVector.x;
          lowestZ = scratchVector.z;
        }
      }
      const penetration = FLOOR_Y - (body.position.y + lowest);
      if (penetration > 0) {
        body.position.y += penetration;
        const inertia = 0.4 * shard.radius * shard.radius + 1e-3;
        if (body.velocity.y < 0) {
          const bounce = -body.velocity.y * (1 + RESTITUTION);
          body.velocity.y += bounce;
          body.velocity.x *= 0.82;
          body.velocity.z *= 0.82;
          // Angular impulse from the contact point: r × J over a disc's
          // inertia, which rolls the shard down onto its face.
          body.angularVelocity.x += (lowestZ * bounce) / inertia * 0.5;
          body.angularVelocity.z += (-lowestX * bounce) / inertia * 0.5;
          body.angularVelocity.multiplyScalar(0.55);
        }
        // Gravity about the contact point topples a shard resting on an
        // edge: τ = (centre − contact) × m·g.
        body.angularVelocity.x += (lowestZ * GRAVITY) / inertia * STEP_SECONDS;
        body.angularVelocity.z += (-lowestX * GRAVITY) / inertia * STEP_SECONDS;
        body.angularVelocity.multiplyScalar(0.9);
        const flat = Math.abs(scratchMatrix.elements[9]) > 0.9;
        if (
          body.velocity.lengthSq() < 0.0025 &&
          body.angularVelocity.lengthSq() < 0.04 &&
          (flat || step > 300)
        ) {
          body.velocity.set(0, 0, 0);
          body.angularVelocity.set(0, 0, 0);
          body.asleep = true;
        }
      }
      body.angularVelocity.multiplyScalar(0.995);
    }
    write(step);
    if (awake === 0) {
      step++;
      break;
    }
  }
  recordedSteps = Math.min(step, MAX_STEPS);
  reassembleButton.disabled = false;
  playbackStep = 0;
  playing = true;
  requestRender();
  intact = false;
  hint.textContent = "The shards are live: click a toggle's row on any of them.";
}

function applyStep(step) {
  let offset = step * shards.length * 7;
  for (const shard of shards) {
    shard.mesh.position.set(trajectory[offset], trajectory[offset + 1], trajectory[offset + 2]);
    shard.mesh.quaternion.set(
      trajectory[offset + 3],
      trajectory[offset + 4],
      trajectory[offset + 5],
      trajectory[offset + 6],
    );
    offset += 7;
  }
}

reassembleButton.addEventListener("click", () => {
  if (intact) return;
  playing = false;
  reassembling = true;
  requestRender();
  reassembleButton.disabled = true;
  hint.textContent = "Rewinding.";
});

// ------------------------------------------------------------- pointer I/O

const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();

// Host client point → the document point under it on whichever shard the
// ray hits first, or null on a miss.
function hitDocumentPoint(event) {
  const bounds = canvas.getBoundingClientRect();
  pointerNDC.set(
    ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
    -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
  );
  raycaster.setFromCamera(pointerNDC, camera);
  const hit = raycaster.intersectObjects(shardGroup.children, false)
    .find((candidate) => candidate.uv);
  if (!hit) return null;
  return {
    x: hit.uv.x * DOCUMENT_WIDTH,
    y: hit.uv.y * DOCUMENT_HEIGHT,
    // Pane-space impact for the intact pane, whose only shard is the pane.
    pane: {
      x: (hit.uv.x - 0.5) * PANE_WIDTH,
      y: (0.5 - hit.uv.y) * PANE_HEIGHT,
    },
  };
}

// Document point → host client point: the shard whose front face carries
// the point, its local position interpolated and projected. Null when the
// point faces away or lies outside every front face. bindProjectedInput
// uses it to keep the browser's text-input sink at the caret.
function locateDocumentPoint({ x, y }) {
  const u = x / DOCUMENT_WIDTH;
  const v = y / DOCUMENT_HEIGHT;
  for (const shard of shards) {
    const geometry = shard.mesh.geometry;
    const uvs = geometry.attributes.uv.array;
    const positions = geometry.attributes.position.array;
    const frontCount = geometry.groups[0].count / 2;
    for (let vertex = 0; vertex < frontCount; vertex += 3) {
      const u0 = uvs[vertex * 2], v0 = uvs[vertex * 2 + 1];
      const u1 = uvs[vertex * 2 + 2], v1 = uvs[vertex * 2 + 3];
      const u2 = uvs[vertex * 2 + 4], v2 = uvs[vertex * 2 + 5];
      const area = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
      if (Math.abs(area) < 1e-12) continue;
      const w1 = ((u - u0) * (v2 - v0) - (u2 - u0) * (v - v0)) / area;
      const w2 = ((u1 - u0) * (v - v0) - (u - u0) * (v1 - v0)) / area;
      const w0 = 1 - w1 - w2;
      if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
      scratchVector.set(
        w0 * positions[vertex * 3] + w1 * positions[vertex * 3 + 3] + w2 * positions[vertex * 3 + 6],
        w0 * positions[vertex * 3 + 1] + w1 * positions[vertex * 3 + 4] + w2 * positions[vertex * 3 + 7],
        w0 * positions[vertex * 3 + 2] + w1 * positions[vertex * 3 + 5] + w2 * positions[vertex * 3 + 8],
      );
      shard.mesh.updateMatrixWorld();
      scratchVector.applyMatrix4(shard.mesh.matrixWorld);
      const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(shard.mesh.quaternion);
      if (normal.dot(camera.position.clone().sub(scratchVector)) <= 0) return null;
      scratchVector.project(camera);
      const bounds = canvas.getBoundingClientRect();
      return {
        x: bounds.left + (scratchVector.x + 1) / 2 * bounds.width,
        y: bounds.top + (1 - scratchVector.y) / 2 * bounds.height,
      };
    }
  }
  return null;
}

// The document decides what a press on the intact pane means: a press on a
// control belongs to the page, a press anywhere else breaks the glass.
const onControl = (point) =>
  dom.document.elementFromPoint(point.x, point.y)?.closest("label, button, input") != null;

bindProjectedInput({
  host: canvas,
  backend: dom,
  root,
  project: hitDocumentPoint,
  unproject: locateDocumentPoint,
  claimPointerDown(point) {
    if (!intact || point === null || onControl(point)) return false;
    shatter(point.pane);
    return true;
  },
  cursor: (point) => (intact && point !== null && !onControl(point) ? "crosshair" : null),
  label: "Settings on the glass",
});

// ------------------------------------------------------------ render loop
//
// The scene renders when it has something new to show: a frame Sandom
// presented into the shared texture, a step of the fall, a camera move, or
// a resize. Each of those requests a host frame; an idle page requests
// none. Event handlers change the document; the surface's own loop renders
// it.
let sceneDirty = true;
let cameraMoving = false;
let presentedFrames = 0;
let sceneFrames = 0;

function resize() {
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  threeRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  threeRenderer.setSize(width, height, false);
  sceneDirty = true;
  requestRender();
}
new ResizeObserver(resize).observe(canvas);
resize();

function renderFrame() {
  renderQueued = false;
  if (playing) {
    playbackStep++;
    applyStep(playbackStep);
    if (playbackStep >= recordedSteps - 1) playing = false;
    sceneDirty = true;
  } else if (reassembling) {
    playbackStep = Math.max(0, playbackStep - 3);
    applyStep(playbackStep);
    if (playbackStep === 0) {
      reassembling = false;
      intact = true;
      trajectory = null;
      buildPane([wholePane]);
      hint.textContent = INTACT_HINT;
    }
    sceneDirty = true;
  }
  const view = intact || reassembling ? PANE_VIEW : FLOOR_VIEW;
  if (!camera.position.equals(view.position) || !cameraTarget.equals(view.target)) {
    cameraMoving = camera.position.distanceToSquared(view.position) +
        cameraTarget.distanceToSquared(view.target) > 1e-6;
    if (cameraMoving) {
      camera.position.lerp(view.position, 0.05);
      cameraTarget.lerp(view.target, 0.05);
    } else {
      camera.position.copy(view.position);
      cameraTarget.copy(view.target);
    }
    camera.lookAt(cameraTarget);
    sceneDirty = true;
  }
  if (presenter.frames !== presentedFrames) {
    presentedFrames = presenter.frames;
    sceneDirty = true;
  }
  if (sceneDirty) {
    sceneDirty = false;
    threeRenderer.render(scene, camera);
    sceneFrames++;
    if (sceneFrames % 30 === 0) {
      statusLine.textContent = `${shards.length} ${shards.length === 1 ? "pane" : "shards"} · ` +
        `${presenter.frames} Sandom frames · ${sceneFrames} scene frames`;
    }
  }
  // The fall and the camera ease advance one step per host frame.
  if (playing || reassembling || cameraMoving) requestRender();
}
sceneReady = true;
requestRender();

notice.hidden = true;

// Read-only state, read by automation and handy in the console: whether the
// pane is whole, the shard count, whether the shards or the camera are still
// moving, each toggle's checked state with its row's document rectangle (a
// click anywhere on the row flips it) and its switch's centre, and the two
// projections between client and document coordinates.
globalThis.example = Object.freeze({
  get intact() {
    return intact;
  },
  get shards() {
    return shards.length;
  },
  get moving() {
    return playing || reassembling || cameraMoving;
  },
  get sandomFrames() {
    return presenter.frames;
  },
  get sceneFrames() {
    return sceneFrames;
  },
  get toggles() {
    return toggles.map((input) => {
      const row = input.parentElement.getBoundingClientRect();
      const track = input.nextElementSibling.getBoundingClientRect();
      return {
        label: input.previousElementSibling.textContent,
        checked: input.checked,
        row: { left: row.left, top: row.top, width: row.width, height: row.height },
        track: { x: track.left + track.width / 2, y: track.top + track.height / 2 },
      };
    });
  },
  locate: (documentX, documentY) => locateDocumentPoint({ x: documentX, y: documentY }),
  documentPointAt(clientX, clientY) {
    const point = hitDocumentPoint({ clientX, clientY });
    return point && { x: point.x, y: point.y };
  },
});
