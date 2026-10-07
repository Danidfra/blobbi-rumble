/**
 * THE PLAYGROUND: one scene, one controllable Blobbi, a lineup of presets,
 * and a small panel. Everything that makes a Blobbi is `@blobbi-kit/3d`;
 * this file only decides which Blobbi to ask for and wires the controls.
 */
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import '@babylonjs/core/Materials/standardMaterial';
import { EMOTIONS, MOTION_STATES, canonicalBlobbiSeed, createBlobbi3D, createBlobbiIdentity, createCanonicalBlobbi3D, type Blobbi3D, type MotionState } from '@blobbi-kit/3d';
import { seedFromLabel } from './seeds';
import { createEnvironment } from './environment';
import { CharacterController } from './controller';
import { PRESETS } from './presets';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const panel = document.getElementById('panel') as HTMLElement;
const engine = new Engine(canvas, true, { adaptToDeviceRatio: true, stencil: true });
const scene = new Scene(engine);
const env = createEnvironment(scene, canvas);
const controller = new CharacterController();

interface Live {
  blobbi: Blobbi3D;
  label: string;
}

let player: Live | null = null;
let lineup: Live[] = [];
let gazeFollow = true;
let pinned: MotionState | null = null;
let expression: string = 'neutral';
let sleeping = false;

/** `null` is the canonical Blobbi: no seed decides it (every gene at zero, the authored purple). */
function makeBlobbi(seed: string | null, name: string): Blobbi3D {
  const options = { name, shadows: env.shadows };
  return seed === null ? createCanonicalBlobbi3D(scene, options) : createBlobbi3D(seed, scene, options);
}

function setPlayer(seed: string | null, label: string) {
  player?.blobbi.dispose();
  const blobbi = makeBlobbi(seed, 'player');
  player = { blobbi, label };
  blobbi.setExpression(expression as never, 0);
  blobbi.setSleeping(sleeping);
  blobbi.animator.setState(pinned);
  controller.state.position.set(0, 0, 0);
  renderIdentity();
  for (const b of panel.querySelectorAll('button[data-seed]')) b.classList.toggle('active', (b as HTMLElement).dataset.label === label);
}

function setLineup(on: boolean) {
  for (const l of lineup) l.blobbi.dispose();
  lineup = [];
  if (!on) return;
  const shown = PRESETS.slice(0, 8);
  shown.forEach((preset, i) => {
    const blobbi = makeBlobbi(preset.seed, `lineup-${i}`);
    const x = (i - (shown.length - 1) / 2) * 1.15;
    blobbi.rig.root.position.set(x, 0, -2.6);
    blobbi.setExpression('happy', 0);
    lineup.push({ blobbi, label: preset.label });
  });
}

// ─── Panel ───────────────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { text?: string } = {}, ...children: (Node | string)[]) {
  const node = document.createElement(tag);
  const { text, ...rest } = props;
  Object.assign(node, rest);
  if (text) node.textContent = text;
  for (const c of children) node.append(c);
  return node;
}

const identityBox = el('div', { className: 'identity' });
const swatches = el('div', { className: 'swatches' });

function renderIdentity() {
  if (!player) return;
  const { identity, morphology, inferred } = player.blobbi;
  const t = identity.traits;
  const lines = [
    `seed       ${identity.seed.slice(0, 16)}…`,
    `colors     base ${identity.colors.base}  secondary ${identity.colors.secondary}`,
    `           eye ${identity.colors.eye}  accent ${identity.colors.accent ?? 'none'}`,
    `traits     antenna ${t.antenna} · horns ${t.horns} · ears ${t.ears} · tail ${t.tail}`,
    `           pattern ${t.pattern} · mark ${t.specialMark} · belly ${t.belly} · freckles ${t.freckles}`,
    `body       width ×${morphology.bodyWidth.toFixed(3)} · height ×${morphology.bodyHeight.toFixed(3)} · top ×${morphology.topWidth.toFixed(3)} · belly ×${morphology.belly.toFixed(3)}`,
    `face       eyes ×${morphology.eyeSize.toFixed(3)} · spacing ×${morphology.eyeSpacing.toFixed(3)} · height ${morphology.eyeHeight.toFixed(1)}u · mouth ×${morphology.mouthWidth.toFixed(3)}`,
    `limbs      arms ×${morphology.armSize.toFixed(3)} · feet ×${morphology.footSize.toFixed(3)} · stance ×${morphology.footSpacing.toFixed(3)}`,
    inferred.length ? `inferred   ${inferred.join(', ')}` : `inferred   nothing: the identity is complete`,
  ];
  identityBox.textContent = lines.join('\n');
  swatches.replaceChildren(
    ...[identity.colors.base, identity.colors.secondary, identity.colors.eye, identity.colors.accent ?? '#ffffff00'].map((hex) => {
      const s = el('div', { className: 'swatch' });
      s.style.background = hex;
      s.title = hex;
      return s;
    }),
  );
}

function buildPanel() {
  panel.append(el('h1', { text: 'Blobbi 3D playground' }));
  panel.append(el('p', { className: 'hint', text: 'WASD / arrows to walk, Shift to run, Space to jump. Drag to orbit, wheel to zoom.' }));

  panel.append(el('h2', { text: 'Seed' }));
  const presets = el('div', { className: 'presets' });
  for (const preset of PRESETS) {
    const b = el('button', { text: preset.label, title: preset.note });
    b.dataset.seed = preset.seed ?? '';
    b.dataset.label = preset.label;
    b.onclick = () => setPlayer(preset.seed, preset.label);
    presets.append(b);
  }
  panel.append(presets);
  const seedInput = el('input', { type: 'text', placeholder: 'paste a 64-hex seed or type a label' }) as HTMLInputElement;
  const seedGo = el('button', { text: 'Show' });
  seedGo.onclick = () => {
    const value = seedInput.value.trim();
    if (!value) return;
    const seed = canonicalBlobbiSeed(value) ?? seedFromLabel(value);
    setPlayer(seed, value);
  };
  seedInput.onkeydown = (e) => {
    if (e.key === 'Enter') seedGo.click();
    e.stopPropagation();
  };
  panel.append(el('div', { className: 'row' }, seedInput, seedGo));
  panel.append(swatches, identityBox);

  panel.append(el('h2', { text: 'Face' }));
  const exprSelect = el('select') as HTMLSelectElement;
  for (const name of ['neutral', ...EMOTIONS]) exprSelect.append(el('option', { value: name, text: name }));
  exprSelect.onchange = () => {
    expression = exprSelect.value;
    player?.blobbi.setExpression(expression as never);
  };
  panel.append(el('div', { className: 'row' }, el('label', { text: 'expression' }), exprSelect));
  const sleepBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
  sleepBox.onchange = () => {
    sleeping = sleepBox.checked;
    player?.blobbi.setSleeping(sleeping);
  };
  panel.append(el('label', { className: 'check' }, sleepBox, 'sleeping'));
  const gazeBox = el('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  gazeBox.onchange = () => (gazeFollow = gazeBox.checked);
  panel.append(el('label', { className: 'check' }, gazeBox, 'eyes follow the pointer'));

  panel.append(el('h2', { text: 'Motion' }));
  const stateSelect = el('select') as HTMLSelectElement;
  stateSelect.append(el('option', { value: '', text: 'auto (from movement)' }));
  for (const s of MOTION_STATES.slice(0, 6)) stateSelect.append(el('option', { value: s, text: `pin: ${s}` }));
  stateSelect.onchange = () => {
    pinned = (stateSelect.value || null) as MotionState | null;
    player?.blobbi.animator.setState(pinned);
    controller.enabled = pinned === null;
  };
  panel.append(el('div', { className: 'row' }, el('label', { text: 'state' }), stateSelect));

  panel.append(el('h2', { text: 'Compare' }));
  const lineupBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
  lineupBox.onchange = () => setLineup(lineupBox.checked);
  panel.append(el('label', { className: 'check' }, lineupBox, 'show the first eight presets in a row'));
  const turnBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
  turnBox.onchange = () => (turntable = turnBox.checked);
  panel.append(el('label', { className: 'check' }, turnBox, 'turntable (idle Blobbi slowly turns)'));
}

let turntable = false;
/** Whether the camera follows the player (off while a script frames something else). */
let followCamera = true;
/** How far (metres, along the camera's right) the followed Blobbi is kept off centre, so the panel never covers it. */
const PANEL_OFFSET = 0.5;
buildPanel();
setPlayer(PRESETS[1].seed, PRESETS[1].label);

// Pointer position for the gaze.
let pointer = { x: 0, y: 0 };
canvas.addEventListener('pointermove', (e) => {
  pointer = { x: (e.clientX / canvas.clientWidth) * 2 - 1, y: (e.clientY / canvas.clientHeight) * 2 - 1 };
});

// ─── Loop ────────────────────────────────────────────────────────────────────

function frame(dt: number) {
  // The camera's yaw: where "forward" is for the keys.
  const look = env.camera.target.subtract(env.camera.position);
  const cameraYaw = Math.atan2(look.x, look.z);
  controller.update(dt, cameraYaw);
  if (player) {
    const st = controller.state;
    const root = player.blobbi.rig.root;
    root.position.copyFrom(st.position);
    if (turntable && st.speed < 0.05 && st.grounded) st.yaw += dt * 0.6;
    root.rotation.y = st.yaw;
    if (gazeFollow) {
      // Look toward the pointer, in the Blobbi's own frame: only while the face is turned toward the camera.
      const toCamera = env.camera.position.subtract(root.position);
      const rel = Math.atan2(toCamera.x, toCamera.z) - st.yaw;
      const facingCamera = Math.cos(rel);
      player.blobbi.setGaze(facingCamera > 0 ? pointer.x * 0.9 : 0, pointer.y * 0.6);
    } else player.blobbi.setGaze(0, 0);
    player.blobbi.update({ dt, speed: st.speed, grounded: st.grounded, verticalVelocity: st.velocity.y, jumped: st.jumped, landed: st.landed, impact: st.impact });
    if (followCamera) {
      // Keep the Blobbi a little right of centre, clear of the panel, whichever way the camera orbits.
      const right = env.camera.getDirection(Vector3.Right());
      const wanted = new Vector3(st.position.x, st.position.y + 0.55, st.position.z).subtract(right.scale(PANEL_OFFSET));
      env.camera.target.copyFrom(Vector3.Lerp(env.camera.target, wanted, 1 - Math.exp(-dt * 6)));
    }
  }
  for (const l of lineup) l.blobbi.update({ dt, speed: 0, grounded: true, verticalVelocity: 0 });
  scene.render();
}

let last = performance.now();
engine.runRenderLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  frame(dt);
});
window.addEventListener('resize', () => engine.resize());

// Expose for inspection from the console.
Object.assign(window, {
  blobbiPlayground: {
    scene,
    get player() {
      return player;
    },
    get follow() {
      return followCamera;
    },
    set follow(value: boolean) {
      followCamera = value;
    },
    controller,
    createBlobbiIdentity,
    /** Advance the playground by hand (a hidden tab gets no animation frames; tests and screenshots step it). */
    step(frames = 1, dt = 1 / 60) {
      for (let i = 0; i < frames; i++) frame(dt);
    },
    /** Press or release a key as the controller sees it. */
    key(code: string, down: boolean) {
      window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
    },
  },
});
