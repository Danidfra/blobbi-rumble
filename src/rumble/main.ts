/**
 * BLOBBI RUMBLE, MILESTONE 2: two local players, punch, grab and throw,
 * ring-outs and a first-to-three match.
 *
 * One elevated platform over a void. Two visibly different Blobbis from
 * `@blobbi-kit/3d`, each a `Fighter`: the SAME body, controller and
 * combat, with its own keys. Falling off the arena gives the other player
 * the point; both at once is a draw. F3 shows colliders and reach, R
 * restarts a finished match.
 *
 *   physics body ──► position / velocity / ground contact ──► visual Blobbi
 *
 * Nothing visual feeds back into the physics, and the kit package knows
 * nothing of any of this.
 */
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import '@babylonjs/core/Materials/standardMaterial';
import { createEnvironment } from '../playground/environment';
import { seedFromLabel } from '../playground/seeds';
import { createArena } from './arena';
import { applyCamera, followCamera, wantedCamera, type CameraPose } from './camera';
import { endGrab, holdBreaks, holdPull, isHolding, landPunch, release, tickCombat, tryGrab } from './combat/combat';
import { Fighter } from './combat/fighter';
import { Keyboard, P1_BINDINGS, P2_BINDINGS, PlayerInput } from './control/input';
import { PhysicsDebug } from './debug';
import { enableHavok } from './physics/world';
import { RUMBLE_BODY } from './profile';
import { createMatch, matchWinner, restartMatch, ringOut, tickMatch } from './rounds';
import { CAMERA, COMBAT, ROUND } from './tuning';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLElement;
const engine = new Engine(canvas, true, { adaptToDeviceRatio: true, stencil: true });
const scene = new Scene(engine);
const env = createEnvironment(scene, canvas, { props: false });
env.camera.lowerBetaLimit = 0.3;
env.camera.upperBetaLimit = Math.PI / 2 - 0.1;
env.camera.lowerRadiusLimit = CAMERA.minRadius;
env.camera.upperRadiusLimit = CAMERA.maxRadius;
env.camera.alpha = CAMERA.alpha;
env.camera.beta = CAMERA.beta;

const CONTROLS = ['P1  WASD move · LShift run · Space jump · F punch · G grab/throw', 'P2  Arrows move · RShift run · Enter jump · K punch · L grab/throw', 'F3 colliders & reach · R restart a finished match'];

async function start() {
  const plugin = await enableHavok(scene, RUMBLE_BODY.gravity);
  const arena = createArena(scene, env.shadows);
  const debug = new PhysicsDebug(scene, hud);
  const keyboard = new Keyboard([P1_BINDINGS, P2_BINDINGS]);
  // Two visibly different individuals (a yellow one with ears, a pink one with horns and antennae), one gameplay body each.
  const p1 = new Fighter('P1', scene, seedFromLabel('abc123'), arena.spawns.a, Math.PI / 2, new PlayerInput(keyboard, P1_BINDINGS), env.shadows);
  const p2 = new Fighter('P2', scene, seedFromLabel('blobbi-1'), arena.spawns.b, -Math.PI / 2, new PlayerInput(keyboard, P2_BINDINGS), env.shadows);
  const fighters: [Fighter, Fighter] = [p1, p2];
  for (const f of fighters) debug.track(f.body.body);
  const match = createMatch();
  let cameraPose: CameraPose = wantedCamera(p1.body.feet(), p2.body.feet());
  let message = '';

  window.addEventListener('keydown', (e) => {
    if (e.code === 'F3') {
      debug.toggle();
      for (const f of fighters) f.showDebug(debug.on);
      e.preventDefault();
    }
    if (e.code === 'KeyR' && match.phase === 'matchOver') newMatch();
  });

  const resetRound = () => {
    for (const f of fighters) f.reset();
    cameraPose = wantedCamera(p1.body.feet(), p2.body.feet());
  };
  const newMatch = () => {
    restartMatch(match);
    resetRound();
    message = '';
  };

  /** One fighter's attack and hold on the other, this frame. */
  const interact = (me: Fighter, other: Fighter, intent: { punch: boolean; grab: boolean }, dt: number) => {
    // A landed punch: knockback along the facing, a short stun; a hold on the victim breaks.
    const knock = landPunch(me.combat, me.at(), me.facing(), other.combat, other.at());
    if (knock) {
      if (isHolding(other.combat)) endGrab(other.combat, me.combat);
      other.knock(knock);
    }
    if (intent.grab) {
      if (isHolding(me.combat)) other.knock(release(me.combat, other.combat, me.facing(), me.velocity()));
      else tryGrab(me.combat, me.at(), me.facing(), other.combat, other.at());
    }
    if (isHolding(me.combat)) {
      if (holdBreaks(me.combat, me.at(), other.at())) endGrab(me.combat, other.combat);
      else {
        const pull = holdPull(me.at(), me.facing(), me.velocity(), other.at(), other.velocity(), dt);
        other.knock(pull.victim);
        me.knock(pull.grabber);
      }
    }
  };

  const frame = (dt: number) => {
    const look = env.camera.target.subtract(env.camera.position);
    const cameraYaw = Math.atan2(look.x, look.z);
    const playing = match.phase === 'playing';
    for (const f of fighters) f.input.enabled = playing;
    for (const f of fighters) tickCombat(f.combat, dt);
    const frames = fighters.map((f) => f.update(dt, cameraYaw));
    if (playing) {
      interact(p1, p2, frames[0].intent, dt);
      interact(p2, p1, frames[1].intent, dt);
    }
    fighters.forEach((f, i) => f.follow(dt, frames[i]));

    // Ring-out: who crossed the fall line this frame. A fall breaks any hold.
    const fell: [boolean, boolean] = [p1.checkFall(dt), p2.checkFall(dt)];
    if (fell[0] || fell[1]) {
      endGrab(p1.combat, p2.combat);
      endGrab(p2.combat, p1.combat);
    }
    if (ringOut(match, fell)) {
      message = match.lastWinner === null ? 'DOUBLE RING-OUT · no point' : `${fighters[match.lastWinner].label} SCORES`;
    }
    if (tickMatch(match, dt)) {
      resetRound();
      message = '';
    }
    if (match.phase === 'matchOver') message = `${fighters[matchWinner(match)!].label} WINS · press R to play again`;

    cameraPose = followCamera(cameraPose, wantedCamera(p1.body.feet(), p2.body.feet()), dt);
    applyCamera(env.camera, cameraPose);

    const lines = [
      `P1  ${match.score[0]} - ${match.score[1]}  P2     round ${match.round} · first to ${ROUND.target}`,
      message || (playing ? '' : '…'),
      '',
      ...CONTROLS,
    ];
    if (debug.on) {
      const state = (f: Fighter) => {
        const c = f.combat;
        const v = f.body.velocity();
        const what = c.held ? 'held' : isHolding(c) ? 'holding' : c.stun > 0 ? `stun ${c.stun.toFixed(2)}` : c.punchTime >= 0 ? 'punch' : 'free';
        return `${f.label}  ${f.blobbi.animator.state.padEnd(5)} ${what.padEnd(10)} v ${Math.hypot(v.x, v.z).toFixed(2)} vy ${v.y.toFixed(2)} ${f.body.grounded() ? 'ground' : 'air'} cd ${c.punchCooldown.toFixed(2)}`;
      };
      lines.push('', state(p1), state(p2), `grab ${COMBAT.grabRange} m (blue) · punch ${COMBAT.punchRange} m (red) · cam r ${cameraPose.radius.toFixed(1)}`);
    }
    debug.print(lines);
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
      p1,
      p2,
      match,
      arena,
      keyboard,
      debug,
      plugin,
      get cameraPose() {
        return cameraPose;
      },
      /** Drive frames by hand (a hidden tab gets none); scripted checks step the physics at a fixed 1/60 s. */
      step(frames = 1) {
        for (let i = 0; i < frames; i++) frame(1 / 60);
      },
      key(code: string, down: boolean) {
        window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
      },
      /** A press: down and up. */
      press(code: string) {
        window.dispatchEvent(new KeyboardEvent('keydown', { code }));
        window.dispatchEvent(new KeyboardEvent('keyup', { code }));
      },
      newMatch,
    },
  });
}

start().catch((err) => {
  hud.textContent = `Havok failed to start: ${err}`;
  console.error(err);
});
