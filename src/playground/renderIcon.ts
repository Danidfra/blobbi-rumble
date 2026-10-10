/**
 * THE APP ICON, rendered from the game's own Blobbi (dev tool, `icon.html`,
 * never in the production build). The canonical Blobbi (every gene at zero,
 * the authored purple adult) from `@blobbi-kit/3d`, exactly as the game
 * builds it, posed happy, seen from a front three-quarter angle on a
 * transparent canvas; then composed on a warm background (the purple's
 * complement) at each size the web app needs:
 *
 *   icon-512.png / icon-192.png   "any": the character large, centred, with padding
 *   icon-512-maskable.png         Android's adaptive mask: the character inside the 80 % safe circle
 *   icon-180.png                  apple-touch-icon: opaque, full bleed (iOS rounds the corners itself)
 *   favicon-32.png                the browser tab
 *
 *   npx vite --port 5199  →  http://127.0.0.1:5199/icon.html?upload=http://127.0.0.1:8099/
 *
 * With `?upload=`, each PNG is POSTed there (a local receiver writes them);
 * the previews show on the page either way. Nothing here changes how the
 * game draws a Blobbi.
 */
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import '@babylonjs/core/Materials/standardMaterial';
import { createCanonicalBlobbi3D } from '@blobbi-kit/3d';

const q = new URLSearchParams(location.search);
const RENDER = 1024;
const canvas = document.createElement('canvas');
canvas.width = canvas.height = RENDER;
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, premultipliedAlpha: false, alpha: true, adaptToDeviceRatio: false });
engine.setSize(RENDER, RENDER);
const scene = new Scene(engine);
scene.clearColor = new Color4(0, 0, 0, 0);
scene.ambientColor = new Color3(0.32, 0.34, 0.36);

// The game's daylight: a cool sky fill with a soft green bounce, one warm sun high and in front.
const sky = new HemisphericLight('sky', new Vector3(0.15, 1, 0.1), scene);
sky.intensity = 0.78;
sky.diffuse = Color3.FromHexString('#eef6ff');
sky.groundColor = Color3.FromHexString('#cfe3c8');
sky.specular = new Color3(0.05, 0.05, 0.05);
const sun = new DirectionalLight('sun', new Vector3(-0.35, -0.8, 0.55).normalize(), scene);
sun.intensity = 0.85;
sun.diffuse = Color3.FromHexString('#fff3e0');

const blobbi = createCanonicalBlobbi3D(scene, { name: 'icon', textureWidth: 1024 });
blobbi.setExpression('happy', 0);
blobbi.setGaze(0.15, 0.1);
// Settle the pose and the expression (idle, standing).
for (let i = 0; i < 90; i++) blobbi.update({ dt: 1 / 60, speed: 0, grounded: true, verticalVelocity: 0 });

// Front three-quarter: the Blobbi turned a little toward the viewer's left, the camera a touch above its eyes.
const yaw = Number(q.get('yaw') ?? 0.42);
blobbi.rig.root.rotation.y = Math.PI + yaw;
const h = blobbi.height;
const camera = new ArcRotateCamera('cam', -Math.PI / 2, Number(q.get('beta') ?? 1.32), 6, new Vector3(0, h * 0.5, 0), scene);
camera.fov = 0.32;
camera.minZ = 0.05;
// Frame the whole character (traits, arms and feet included): fit its bounding box in the view with no margin; the
// compose step adds the padding.
const fit = () => {
  let min = new Vector3(Infinity, Infinity, Infinity);
  let max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const m of blobbi.meshes) {
    if (!m.isEnabled() || !m.isVisible) continue;
    m.computeWorldMatrix(true);
    const b = m.getBoundingInfo().boundingBox;
    min = Vector3.Minimize(min, b.minimumWorld);
    max = Vector3.Maximize(max, b.maximumWorld);
  }
  const centre = min.add(max).scale(0.5);
  const size = max.subtract(min);
  camera.target = centre;
  camera.radius = (Math.max(size.y, Math.hypot(size.x, size.z)) * 0.5) / Math.tan(camera.fov / 2) + Math.max(size.x, size.z) * 0.5;
};
fit();
// Materials and the skin texture compile asynchronously: render only once the scene is ready.
await scene.whenReadyAsync();
for (let i = 0; i < 3; i++) scene.render();

/** The rendered character's opaque bounds on the transparent canvas, in pixels. */
function opaqueBounds(src: HTMLCanvasElement) {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(src, 0, 0);
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let x0 = c.width;
  let y0 = c.height;
  let x1 = 0;
  let y1 = 0;
  for (let y = 0; y < c.height; y++)
    for (let x = 0; x < c.width; x++)
      if (data[(y * c.width + x) * 4 + 3] > 8) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

const sprite = document.createElement('canvas');
sprite.width = sprite.height = RENDER;
sprite.getContext('2d')!.drawImage(canvas, 0, 0);
const box = opaqueBounds(sprite);

/** One icon: the background, a soft ground shadow, and the character scaled so its larger side is `fill` of the icon. */
function compose(size: number, fill: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  // A warm, light background: the purple's complement, bright enough that the dark eyes and the purple read at 16 px.
  const g = ctx.createRadialGradient(size * 0.5, size * 0.42, size * 0.05, size * 0.5, size * 0.5, size * 0.75);
  g.addColorStop(0, '#fff7df');
  g.addColorStop(0.55, '#ffe2a8');
  g.addColorStop(1, '#ffc27a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const scale = (size * fill) / Math.max(box.w, box.h);
  const w = box.w * scale;
  const hh = box.h * scale;
  const x = (size - w) / 2;
  // Optically centred: a little low, so the feet and the shadow sit under the middle.
  const y = (size - hh) / 2 + size * 0.02;
  ctx.fillStyle = 'rgba(150, 90, 30, 0.22)';
  ctx.beginPath();
  ctx.ellipse(size / 2, y + hh * 0.985, w * 0.36, Math.max(1, hh * 0.05), 0, 0, Math.PI * 2);
  ctx.fill();
  // Downscale in halving steps for a crisp small icon.
  let src: HTMLCanvasElement = sprite;
  let sx = box.x;
  let sy = box.y;
  let sw = box.w;
  let sh = box.h;
  while (sw / 2 > w) {
    const half = document.createElement('canvas');
    half.width = Math.ceil(src.width / 2);
    half.height = Math.ceil(src.height / 2);
    const hc = half.getContext('2d')!;
    hc.imageSmoothingQuality = 'high';
    hc.drawImage(src, 0, 0, half.width, half.height);
    src = half;
    sx /= 2;
    sy /= 2;
    sw /= 2;
    sh /= 2;
  }
  ctx.drawImage(src, sx, sy, sw, sh, x, y, w, hh);
  return c;
}

const icons: [string, HTMLCanvasElement][] = [
  ['icon-512.png', compose(512, 0.8)],
  ['icon-192.png', compose(192, 0.8)],
  ['icon-180.png', compose(180, 0.78)],
  ['icon-512-maskable.png', compose(512, 0.6)],
  ['favicon-32.png', compose(32, 0.92)],
];

document.body.style.cssText = 'margin:0;padding:16px;background:#333;color:#eee;font:13px system-ui;display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start';
for (const [name, c] of icons) {
  const fig = document.createElement('figure');
  fig.style.cssText = 'margin:0;text-align:center';
  const img = document.createElement('img');
  img.src = c.toDataURL('image/png');
  img.width = Math.min(256, c.width);
  img.style.cssText = `image-rendering:${c.width < 64 ? 'pixelated' : 'auto'};border-radius:${name.includes('180') ? '22%' : name.includes('maskable') ? '50%' : '0'}`;
  const cap = document.createElement('figcaption');
  cap.textContent = `${name} (${c.width}px)`;
  fig.append(img, cap);
  document.body.append(fig);
}

const upload = q.get('upload');
const done = (async () => {
  if (!upload) return 'previews only';
  for (const [name, c] of icons) {
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
    await fetch(`${upload}${name}`, { method: 'POST', body: blob });
  }
  return `uploaded ${icons.length}`;
})();
Object.assign(window, { iconDone: done, iconBox: box });
