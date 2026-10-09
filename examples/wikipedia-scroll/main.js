// A Wikipedia article on a paper scroll between two wooden rollers. The
// mouse wheel, the keyboard, or a finger drag on the paper scrolls the
// article, the paper carries the text over the rollers, and the rollers turn
// with the scroll.
//
// One Sandom document covers the whole visible length of the paper: over the
// front of the top roller, down the flat face, and under the bottom roller.
// The document's own scroll container moves the text along that path, so the
// text curls around each roller. Its scrollTop turns the rollers.
//
// Sandom renders into a GPU texture on the device three.js draws with, and
// three.js samples that texture directly: no pixel ever leaves the GPU.

import * as THREE from "three";
import {
  bindProjectedInput,
  createSandomDOM,
  createSceneRenderer,
  createTexturePresenter,
  loadFont,
} from "sandom";
import { installFontSetFallbackFamilies } from "sandom/src/system-fonts.js";
import { ARTICLE_CSS, articleDocument, fetchArticleBody } from "./article.js";

// World units. The paper is PAPER_WIDTH wide; FLAT_HEIGHT of it faces the
// viewer between the rollers; each roller carries half its circumference.
const PAPER_WIDTH = 1.5;
const FLAT_HEIGHT = 2.1;
const ROLLER_RADIUS = 0.085;
const ARC_LENGTH = Math.PI * ROLLER_RADIUS;
const PAPER_LENGTH = ARC_LENGTH + FLAT_HEIGHT + ARC_LENGTH;
const ARC_SEGMENTS = 32;

// Document CSS pixels. The document height follows the paper's aspect, so
// a CSS pixel has the same size along and across the paper.
const DOCUMENT_WIDTH = 600;
const DOCUMENT_HEIGHT = Math.round(DOCUMENT_WIDTH * PAPER_LENGTH / PAPER_WIDTH);
// The texture density is fixed for the document's life; a scroll costs the
// newly exposed rows, not a lower resolution.
const TEXTURE_SCALE = 2;
const PIXELS_PER_UNIT = DOCUMENT_WIDTH / PAPER_WIDTH;

const notice = document.getElementById("notice");
const canvas = document.getElementById("scene");
// A failed load (no WebGPU, no network) replaces the scene with its reason.
globalThis.addEventListener("error", (event) => {
  notice.hidden = false;
  notice.textContent = `The scroll failed: ${event.error?.message ?? event.message}`;
});

const adapter = await navigator.gpu?.requestAdapter();
if (!adapter) {
  throw new Error("This page needs WebGPU: three.js and Sandom share one GPUDevice.");
}
// One device for Sandom, its texture presenter, and three.js.
const device = await adapter.requestDevice();
device.addEventListener("uncapturederror", (event) => {
  console.error(`WebGPU: ${event.error.message}`);
});

// Sandom has no system fonts: the page loads the two families the article
// CSS names from the package, and the coverage index of the Noto fallback
// families, which loads a face only when a script needs it.
const packageFonts = new URL("../test-assets/", import.meta.resolve("sandom"));
const [article] = await Promise.all([
  fetchArticleBody(),
  loadFont("Inter", new URL("Inter-Variable.ttf", packageFonts), { weight: [100, 900] }),
  loadFont("Roboto Slab", new URL("RobotoSlab-Variable.ttf", packageFonts), { weight: [100, 900] }),
  installFontSetFallbackFamilies(),
]);

// ---------------------------------------------------------------- Sandom

const dom = createSandomDOM({
  viewportW: DOCUMENT_WIDTH,
  viewportH: DOCUMENT_HEIGHT,
  deviceScale: TEXTURE_SCALE,
});
const root = dom.createElement("main");
root.setAttribute("lang", "en");
// The tree is connected before its <style> is parsed: a stylesheet applies
// to a tree in the document.
dom.document.appendChild(root);
root.innerHTML = `<style>${ARTICLE_CSS}</style>${articleDocument(article)}`;

const paperMaterial = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  roughness: 0.92,
  metalness: 0,
  emissive: 0x000000,
  side: THREE.DoubleSide,
  // Tone mapping compresses the white paper toward grey and the ink with it.
  toneMapped: false,
});
let externalTexture = null;
// onTexture runs only when Sandom's texture identity changes (the first
// frame, a resize); every other frame updates the same texture in place.
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
    paperMaterial.map = externalTexture;
    paperMaterial.emissiveMap = externalTexture;
    paperMaterial.needsUpdate = true;
  },
});

// A finger drag pans the article on a device with touch input. Touch
// panning moves only touch pointers, so a mouse drag still selects text on a
// touchscreen laptop.
const touchInput = navigator.maxTouchPoints > 0 ||
  matchMedia("(any-pointer: coarse)").matches;
// One surface for the document's life. Its loop renders only when the
// document changed: a scroll, a hover, a selection.
const surface = dom.createRenderSurface(root, {
  createPersistentRenderer: (options) => createSceneRenderer({ ...options, graphicsDevice: device }),
  presentFrame: presenter.presentFrame,
  touchPanning: touchInput,
});
await surface.renderNow();

// Links open the real article pages; the scroll itself does not navigate.
root.addEventListener("click", (event) => {
  let node = event.target;
  while (node && node !== root && node.localName !== "a") node = node.parentNode;
  if (!node || node === root) return;
  const href = node.getAttribute("href");
  if (href) globalThis.open(href, "_blank", "noopener");
  event.preventDefault();
});

// --------------------------------------------------------------- three.js

const threeRenderer = new THREE.WebGPURenderer({ canvas, device, antialias: true });
await threeRenderer.init();
threeRenderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14100c);

const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 40);
const cameraRest = new THREE.Vector3(0.9, 0.35, 5.6);
const cameraTarget = new THREE.Vector3(0, 0, 0);
camera.position.copy(cameraRest);
camera.lookAt(cameraTarget);

// The paper is not tone mapped, so the lights sum to about 1 on its flat
// face: brighter light lifts the ink toward the paper colour.
scene.add(new THREE.HemisphereLight(0xfff2dc, 0x1a120a, 0.5));
const keyLight = new THREE.DirectionalLight(0xffe7c4, 1.0);
keyLight.position.set(-2.5, 3, 4);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xc8d8ff, 0.25);
fillLight.position.set(3, -1, 2);
scene.add(fillLight);

// The paper path in the y–z plane, measured by arc length s from the
// document's top edge: behind the top roller, over it to the front, down the
// flat face, and under the bottom roller to its back.
const topCenterY = FLAT_HEIGHT / 2;
const bottomCenterY = -FLAT_HEIGHT / 2;
function paperPoint(s) {
  if (s < ARC_LENGTH) {
    // Angle from the back (−z) over the top to the front (+z).
    const angle = Math.PI - (s / ARC_LENGTH) * Math.PI;
    return {
      y: topCenterY + Math.sin(angle) * ROLLER_RADIUS,
      z: Math.cos(angle) * ROLLER_RADIUS,
      normalY: Math.sin(angle),
      normalZ: Math.cos(angle),
    };
  }
  if (s < ARC_LENGTH + FLAT_HEIGHT) {
    return { y: FLAT_HEIGHT / 2 - (s - ARC_LENGTH), z: ROLLER_RADIUS, normalY: 0, normalZ: 1 };
  }
  const angle = ((s - ARC_LENGTH - FLAT_HEIGHT) / ARC_LENGTH) * Math.PI;
  return {
    y: bottomCenterY - Math.sin(angle) * ROLLER_RADIUS,
    z: Math.cos(angle) * ROLLER_RADIUS,
    normalY: -Math.sin(angle),
    normalZ: Math.cos(angle),
  };
}

function paperGeometry() {
  const stations = [];
  for (let index = 0; index <= ARC_SEGMENTS; index++) stations.push((index / ARC_SEGMENTS) * ARC_LENGTH);
  const flatSegments = 8;
  for (let index = 1; index <= flatSegments; index++) {
    stations.push(ARC_LENGTH + (index / flatSegments) * FLAT_HEIGHT);
  }
  for (let index = 1; index <= ARC_SEGMENTS; index++) {
    stations.push(ARC_LENGTH + FLAT_HEIGHT + (index / ARC_SEGMENTS) * ARC_LENGTH);
  }
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  for (const [row, s] of stations.entries()) {
    const point = paperPoint(s);
    for (const side of [0, 1]) {
      positions.push((side - 0.5) * PAPER_WIDTH, point.y, point.z);
      normals.push(0, point.normalY, point.normalZ);
      // v = 0 at the document's top edge, the convention of the projected
      // input binding and of a GPU texture sampled with flipY = true.
      uvs.push(side, s / PAPER_LENGTH);
    }
    if (row > 0) {
      const a = (row - 1) * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

const paper = new THREE.Mesh(paperGeometry(), paperMaterial);
scene.add(paper);

// Rollers: a wooden rod under each paper arc, with turned knobs past the
// paper edges. The grain stripes make the rotation visible.
const woodCanvas = new OffscreenCanvas(512, 64);
const woodContext = woodCanvas.getContext("2d");
woodContext.fillStyle = "#5a3418";
woodContext.fillRect(0, 0, 512, 64);
for (let stripe = 0; stripe < 24; stripe++) {
  woodContext.fillStyle = stripe % 2 ? "#6b3f1f" : "#4b2a13";
  woodContext.fillRect(0, (stripe * 64) / 24, 512, 64 / 48);
}
const woodTexture = new THREE.CanvasTexture(woodCanvas);
woodTexture.colorSpace = THREE.SRGBColorSpace;
woodTexture.wrapS = woodTexture.wrapT = THREE.RepeatWrapping;
// The lights are set for the paper; the wood takes a stronger albedo.
const woodMaterial = new THREE.MeshStandardMaterial({ map: woodTexture, color: new THREE.Color(2.6, 2.6, 2.6), roughness: 0.5, metalness: 0.05 });
const knobMaterial = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.55, 0.3, 0.14), roughness: 0.35, metalness: 0.1 });

function roller(centerY) {
  const group = new THREE.Group();
  const rodLength = PAPER_WIDTH + 0.16;
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(ROLLER_RADIUS * 0.97, ROLLER_RADIUS * 0.97, rodLength, 48), woodMaterial);
  rod.rotation.z = Math.PI / 2;
  group.add(rod);
  const knobProfile = [
    new THREE.Vector2(0, 0), new THREE.Vector2(0.07, 0), new THREE.Vector2(0.11, 0.05),
    new THREE.Vector2(0.12, 0.1), new THREE.Vector2(0.09, 0.15), new THREE.Vector2(0.05, 0.19),
    new THREE.Vector2(0, 0.2),
  ];
  for (const direction of [-1, 1]) {
    const knob = new THREE.Mesh(new THREE.LatheGeometry(knobProfile, 32), knobMaterial);
    knob.rotation.z = -direction * Math.PI / 2;
    knob.position.x = direction * rodLength / 2;
    group.add(knob);
  }
  group.position.y = centerY;
  scene.add(group);
  return group;
}
const topRoller = roller(topCenterY);
const bottomRoller = roller(bottomCenterY);

// A cord from the top knobs, so the scroll hangs.
const cordMaterial = new THREE.MeshStandardMaterial({ color: 0x8a1c14, roughness: 0.8 });
const cordCurve = new THREE.QuadraticBezierCurve3(
  new THREE.Vector3(-(PAPER_WIDTH / 2 + 0.12), FLAT_HEIGHT / 2, 0),
  new THREE.Vector3(0, FLAT_HEIGHT / 2 + 0.95, 0),
  new THREE.Vector3(PAPER_WIDTH / 2 + 0.12, FLAT_HEIGHT / 2, 0),
);
scene.add(new THREE.Mesh(new THREE.TubeGeometry(cordCurve, 48, 0.012, 8), cordMaterial));

// The rollers turn by the paper travel: one roller circumference of scroll is
// one turn. Scroll events come from the document; the frame loop only eases.
const scroller = root.querySelector(".paper");
let targetAngle = 0;
let rollerAngle = 0;
// The article and the document size are fixed after load, so the scroll range
// is measured once. Reading scrollHeight or clientHeight lays the document out
// synchronously; scrollTop does not.
const scrollMax = scroller.scrollHeight - scroller.clientHeight;
scroller.addEventListener("scroll", () => {
  targetAngle = scroller.scrollTop / (PIXELS_PER_UNIT * ROLLER_RADIUS);
});

// ------------------------------------------------------------- pointer I/O

const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();
let parallax = { x: 0, y: 0 };

// The document point under a canvas event: the paper's uv at the ray hit, in
// document CSS pixels, or null off the paper.
function project(event) {
  const bounds = canvas.getBoundingClientRect();
  pointerNDC.set(
    ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
    -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
  );
  raycaster.setFromCamera(pointerNDC, camera);
  const hit = raycaster.intersectObject(paper, false)[0];
  if (hit?.uv) return { x: hit.uv.x * DOCUMENT_WIDTH, y: hit.uv.y * DOCUMENT_HEIGHT };
  // The wheel scrolls the article from anywhere on the canvas.
  if (event.type === "wheel") return { x: DOCUMENT_WIDTH / 2, y: DOCUMENT_HEIGHT / 2 };
  return null;
}

canvas.addEventListener("pointermove", (event) => {
  const bounds = canvas.getBoundingClientRect();
  parallax = {
    x: ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
    y: ((event.clientY - bounds.top) / bounds.height) * 2 - 1,
  };
});

bindProjectedInput({
  host: canvas,
  backend: dom,
  root,
  project,
  label: "Dead Sea Scrolls article",
});

// ------------------------------------------------------------ render loop

function fit() {
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  camera.aspect = width / height;
  // The knobs reach 0.28 past each paper edge.
  const horizontalExtent = PAPER_WIDTH + 0.7;
  const verticalExtent = FLAT_HEIGHT + 0.5;
  const needed = Math.max(verticalExtent, horizontalExtent / camera.aspect);
  cameraRest.setLength(needed / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))));
  camera.updateProjectionMatrix();
  threeRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  threeRenderer.setSize(width, height, false);
}
new ResizeObserver(fit).observe(canvas);
fit();

// The three.js loop reads state and draws; it never changes the Sandom
// document, whose own loop renders only when the document changes.
function renderFrame() {
  rollerAngle += (targetAngle - rollerAngle) * 0.35;
  // Paper moves up the front: the top roller turns it over the top toward the
  // back, and the bottom roller feeds it up from the back.
  topRoller.rotation.x = -rollerAngle;
  bottomRoller.rotation.x = -rollerAngle;
  camera.position.x += (cameraRest.x + parallax.x * 0.25 - camera.position.x) * 0.05;
  camera.position.y += (cameraRest.y - parallax.y * 0.15 - camera.position.y) * 0.05;
  camera.position.z += (cameraRest.z - camera.position.z) * 0.05;
  camera.lookAt(cameraTarget);
  threeRenderer.render(scene, camera);
  requestAnimationFrame(renderFrame);
}
notice.hidden = true;
requestAnimationFrame(renderFrame);

// Read-only state, read by automation and handy in the console. It exists
// once the scene runs.
globalThis.example = Object.freeze({
  get scrollTop() { return scroller.scrollTop; },
  scrollMax,
  get rollerAngle() { return rollerAngle; },
  get sandomFrames() { return presenter.frames; },
});
