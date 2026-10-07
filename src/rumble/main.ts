/**
 * BLOBBI RUMBLE, MILESTONE 1: the Havok physics sandbox.
 *
 * One elevated platform over a void. Two visually different Blobbis from
 * `@blobbi-kit/3d`, each carried by the SAME normalized gameplay capsule
 * owned by Havok. A is the player (WASD / arrows, Shift to run, Space to
 * jump); B is a dummy with mass that collides, can be pushed, and falls.
 * Falling bodies respawn. F3 shows the colliders and the physics HUD.
 *
 *   physics body ──► position / velocity / ground contact ──► visual Blobbi
 *
 * Nothing visual feeds back into the physics, and the kit package knows
 * nothing of Havok.
 */
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import '@babylonjs/core/Materials/standardMaterial';
import { createBlobbi3D, type Blobbi3D } from '@blobbi-kit/3d';
import { createEnvironment } from '../playground/environment';
import { seedFromLabel } from '../playground/seeds';
import { createArena } from './arena';
import { animatorInput, facingYaw, initialBridge } from './control/animationBridge';
import { KeyboardInput } from './control/input';
import { PlayerController } from './control/playerController';
import { PhysicsDebug } from './debug';
import { createGameplayBody, type GameplayBody } from './physics/body';
import { enableHavok } from './physics/world';
import { RUMBLE_BODY } from './profile';
import { initialFallState, updateFall } from './respawn';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLElement;
const engine = new Engine(canvas, true, { adaptToDeviceRatio: true, stencil: true });
const scene = new Scene(engine);
const env = createEnvironment(scene, canvas, { props: false });
env.camera.lowerBetaLimit = 0.3;
env.camera.upperBetaLimit = Math.PI / 2 - 0.1;
env.camera.radius = 9;
env.camera.beta = 1.05;

interface Fighter {
  label: string;
  blobbi: Blobbi3D;
  body: GameplayBody;
  spawn: Vector3;
  yaw: number;
  bridge: ReturnType<typeof initialBridge>;
  fall: ReturnType<typeof initialFallState>;
}

async function start() {
  const plugin = await enableHavok(scene, RUMBLE_BODY.gravity);
  const arena = createArena(scene, env.shadows);
  const debug = new PhysicsDebug(scene, hud);

  const fighter = (label: string, seedLabel: string, spawn: Vector3): Fighter => {
    const blobbi = createBlobbi3D(seedFromLabel(seedLabel), scene, { name: label, shadows: env.shadows });
    const body = createGameplayBody(scene, `${label}-body`, spawn);
    debug.track(body.body);
    return { label, blobbi, body, spawn: spawn.clone(), yaw: 0, bridge: initialBridge(), fall: initialFallState() };
  };
  // Two visibly different individuals (a yellow one with ears, a pink one with horns and antennae), one gameplay body each.
  const a = fighter('A', 'abc123', arena.spawns.a);
  const b = fighter('B', 'blobbi-1', arena.spawns.b);
  a.yaw = Math.PI / 2;
  b.yaw = -Math.PI / 2;
  b.blobbi.setExpression('surprised', 0);

  const input = new KeyboardInput();
  const controller = new PlayerController(a.body, input);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'F3') {
      debug.toggle();
      e.preventDefault();
    }
  });

  const follow = (f: Fighter, dt: number, grounded: boolean, jumped: boolean) => {
    const v = f.body.velocity();
    f.yaw = facingYaw(v.x, v.z, f.yaw, dt);
    const feet = f.body.feet();
    f.blobbi.rig.root.position.copyFrom(feet);
    f.blobbi.rig.root.rotation.y = f.yaw;
    f.blobbi.update(animatorInput({ vx: v.x, vy: v.y, vz: v.z, grounded }, jumped, f.bridge, dt));
    if (updateFall(f.fall, feet.y, dt)) {
      f.body.teleport(f.spawn);
      f.bridge = initialBridge();
    }
  };

  const frame = (dt: number) => {
    const look = env.camera.target.subtract(env.camera.position);
    const cameraYaw = Math.atan2(look.x, look.z);
    const frame = controller.update(dt, cameraYaw);
    follow(a, dt, frame.grounded, frame.jumped);
    follow(b, dt, b.body.grounded(), false);
    // The camera keeps the player in view and the dummy in frame.
    const target = a.body.feet();
    target.y += 0.5;
    env.camera.target.copyFrom(Vector3.Lerp(env.camera.target, target, 1 - Math.exp(-dt * 5)));
    const v = frame.velocity;
    debug.print([
      'BLOBBI RUMBLE · M1 physics sandbox',
      'WASD/arrows move · Shift run · Space jump · F3 colliders',
      '',
      `A  ${a.blobbi.animator.state.padEnd(5)}  v ${Math.hypot(v.x, v.z).toFixed(2)} m/s  vy ${v.y.toFixed(2)}  ${frame.grounded ? 'ground' : 'air'}`,
      `B  ${b.blobbi.animator.state.padEnd(5)}  v ${Math.hypot(b.body.velocity().x, b.body.velocity().z).toFixed(2)} m/s  ${b.body.grounded() ? 'ground' : 'air'}`,
      `Falls: A ${a.fall.falls} | B ${b.fall.falls}`,
      debug.on ? `colliders ON  A ${a.body.position().asArray().map((n) => n.toFixed(2)).join(' ')}` : 'colliders off',
    ]);
    scene.render();
  };
  let last = performance.now();
  engine.runRenderLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    frame(dt);
  });
  window.addEventListener('resize', () => engine.resize());
  Object.assign(window, {
    rumble: {
      scene,
      a,
      b,
      arena,
      input,
      debug,
      plugin,
      /** Drive frames by hand (a hidden tab gets none); scripted checks step the physics at a fixed 1/60 s. */
      step(frames = 1) {
        for (let i = 0; i < frames; i++) frame(1 / 60);
      },
      key(code: string, down: boolean) {
        window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
      },
    },
  });
}

start().catch((err) => {
  hud.textContent = `Havok failed to start: ${err}`;
  console.error(err);
});
