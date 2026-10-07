/**
 * BLOBBI RUMBLE, THE BROWSER CLIENT: up to four Blobbis, punch, grab and
 * throw, power orbs, a sweeper, ring-outs, last Blobbi standing, first to
 * three. `?players=2|3|4`, `?bots=all`; F3 debug, R restarts a finished
 * match.
 *
 * The match itself is `sim/match.ts`, the authority: it owns the bodies,
 * combat, orbs, sweeper, rounds and scores, in a physics world of its own
 * that is never drawn. This client only produces intents (P1 and P2 from
 * the keyboard, P3 and P4 from local test bots), steps the match once per
 * frame, and draws what the snapshot says:
 *
 *   keys / bots ──intent──► RumbleMatch.step(dt) ──snapshot + events──► views, camera, HUD
 *
 * Nothing drawn feeds back into the match, and the kit package knows
 * nothing of any of this.
 */
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import '@babylonjs/core/Materials/standardMaterial';
import { createEnvironment } from '../playground/environment';
import { seedFromLabel } from '../playground/seeds';
import { isHolding } from './combat/combat';
import { BotInput, botWorldFrom } from './control/bot';
import { Keyboard, P1_BINDINGS, P2_BINDINGS, PlayerInput, ScriptableInput, type MoveIntent } from './control/input';
import { powerMultiplier, pushAuthority, speedMultiplier } from './pickups/power';
import { loadHavok } from './physics/world';
import { RUMBLE_BODY } from './profile';
import { rosterFor, rosterOptions } from './roster';
import { createRumbleMatch } from './sim/match';
import { combatOf } from './sim/read';
import type { MatchEvent, MatchSnapshot } from './sim/snapshot';
import { CAMERA, COMBAT, ORBS, ROUND, SWEEPER } from './tuning';
import { createArena } from './view/arenaView';
import { applyCamera, followCamera, framed, wantedCamera, type CameraPose } from './view/camera';
import { PhysicsDebug } from './view/debug';
import { FighterView } from './view/fighterView';
import { OrbView } from './view/orbView';
import { SweeperView } from './view/sweeperView';

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

const CONTROLS = ['P1  WASD move · LShift run · Space jump · F punch · G grab/throw', 'P2  Arrows move · RShift run · Enter jump · K punch · L grab/throw', 'walk into an orb: harder punches and throws this round', 'F3 colliders & reach · R restart a finished match'];

async function start() {
  const havok = await loadHavok();
  const options = rosterOptions(location.search);
  const roster = rosterFor(options);
  const match = createRumbleMatch({ havok, players: roster.map((e) => ({ id: e.label })) });
  const ids = match.ids;

  // Presentation: the arena, the fighters' looks, the orbs, the sweeper, the debug layer.
  createArena(scene, env.shadows);
  const debug = new PhysicsDebug(scene, hud);
  const views = roster.map((e) => new FighterView(e.label, e.label, scene, seedFromLabel(e.identity), env.shadows));
  let snapshot: MatchSnapshot = match.snapshot();
  const orbView = new OrbView(scene, snapshot.orbs, env.shadows);
  const sweeperView = new SweeperView(scene, env.shadows);

  // Intent producers: the keyboard for people, test bots for the rest, each behind a scripting hook for checks.
  const keyboard = new Keyboard([P1_BINDINGS, P2_BINDINGS]);
  const bots: (BotInput | null)[] = [];
  const inputs = roster.map((entry, i) => {
    const driver = entry.keys ? new PlayerInput(keyboard, entry.keys) : new BotInput(i + 1);
    bots.push(driver instanceof BotInput ? driver : null);
    return new ScriptableInput(driver);
  });
  /** Scripted checks may switch the bots off; matches are counted so each one's bot rounds differ. */
  let botsOn = true;
  let matchCount = 0;
  const resetBots = (round: number) => bots.forEach((b) => b?.reset(round + 1000 * matchCount));

  const subjects = (s: MatchSnapshot) =>
    s.fighters
      .map((f) => ({ x: f.position.x, y: f.position.y - RUMBLE_BODY.capsuleCenterY, z: f.position.z, alive: !f.eliminated }))
      .filter((f) => framed(f, f.alive))
      .map(({ x, y, z }) => ({ x, y, z }));
  let cameraPose: CameraPose = wantedCamera(subjects(snapshot));
  let message = '';
  const lastHazard: Record<string, string> = {};
  const events: MatchEvent[] = [];

  window.addEventListener('keydown', (e) => {
    if (e.code === 'F3') {
      debug.toggle();
      for (const v of views) v.showDebug(debug.on);
      orbView.showDebug(debug.on);
      sweeperView.showDebug(debug.on);
      e.preventDefault();
    }
    if (e.code === 'KeyR' && snapshot.phase === 'matchOver') newMatch();
  });

  const newMatch = () => {
    matchCount += 1;
    show(match.restart(), match.snapshot());
    snapshot = match.snapshot();
  };

  /** Show what the match decided: feedback on the views, messages, and fresh starts. Returns who jumped. */
  const show = (stepEvents: readonly MatchEvent[], s: MatchSnapshot) => {
    const jumped = new Set<string>();
    const outs: string[] = [];
    let decided = false;
    const view = (id: string | null | undefined) => views[ids.indexOf(id ?? '')];
    for (const e of stepEvents) {
      events.push(e);
      switch (e.kind) {
        case 'jump':
          jumped.add(e.who!);
          break;
        case 'punch':
        case 'throw':
          view(e.on)?.struck();
          break;
        case 'sweeper':
          view(e.who)?.struck();
          lastHazard[e.who!] = `${e.reaction} ${e.impact!.toFixed(2)} ${e.note}`;
          break;
        case 'orb':
          view(e.who)?.powered();
          orbView.taken(e.orb!);
          break;
        case 'out':
          outs.push(e.who!);
          break;
        case 'round':
          decided = true;
          message = e.who === null ? `${outs.join(' & ')} OUT · nobody left · no point` : `${e.who} IS THE LAST BLOBBI STANDING`;
          break;
        case 'newRound':
        case 'match':
        case 'newMatch':
          for (const v of views) v.reset();
          resetBots(s.round);
          cameraPose = wantedCamera(subjects(s));
          message = '';
          break;
      }
    }
    if (outs.length > 0 && !decided && s.phase === 'playing') message = `${outs.join(' & ')} OUT · ${s.fighters.filter((f) => f.alive).length} left`;
    return jumped;
  };

  const frame = (dt: number) => {
    const look = env.camera.target.subtract(env.camera.position);
    const cameraYaw = Math.atan2(look.x, look.z);
    // Intents for this step, from what the producers see now.
    const before = snapshot;
    const playing = before.phase === 'playing';
    inputs.forEach((input, i) => (input.enabled = playing && !before.fighters[i].eliminated && (botsOn || !bots[i] || input.script !== null)));
    bots.forEach((b, i) => b?.plan(botWorldFrom(before, ids[i]), dt));
    inputs.forEach((input, i) => match.setInput(ids[i], input.read(cameraYaw)));

    // The authority steps; the client draws the outcome.
    const stepEvents = match.step(dt);
    snapshot = match.snapshot();
    const s = snapshot;
    const jumped = show(stepEvents, s);
    s.fighters.forEach((f, i) => views[i].apply(f, dt, jumped.has(f.id)));
    orbView.update(dt, s.orbs);
    sweeperView.apply(s.sweeper.angle);
    debug.sync(s);
    if (s.phase === 'matchOver' && s.matchWinner) message = `${s.matchWinner} WINS THE MATCH · press R to play again`;

    // The camera frames whoever is still in the round and on the arena.
    const wanted = subjects(s);
    if (wanted.length > 0) cameraPose = followCamera(cameraPose, wantedCamera(wanted), dt);
    applyCamera(env.camera, cameraPose);

    const lines = [`round ${s.round} · first to ${ROUND.target} · last Blobbi standing`, ''];
    s.fighters.forEach((f, i) => {
      const who = `${f.id} ${bots[i] ? 'bot ' : 'keys'}`;
      const state = f.alive ? (f.eliminated ? 'OUT' : 'in ') : 'OUT';
      const power = `×${powerMultiplier(f.powerLevel).toFixed(2)}${f.powerLevel > 0 ? ` (${f.powerLevel})` : ''}`;
      const bot = bots[i] && !f.eliminated ? `  ${bots[i]!.memory.state.toLowerCase()}` : '';
      lines.push(`${who}  ${state}  ${'●'.repeat(f.score)}${'○'.repeat(Math.max(0, ROUND.target - f.score))}  ${power.padEnd(11)}${bot}`);
    });
    lines.push('', message || (s.phase === 'playing' ? '' : '…'), '', ...CONTROLS);
    if (debug.on) {
      const state = (i: number) => {
        const f = s.fighters[i];
        if (f.eliminated) return `${f.id}  out`;
        const c = combatOf(f);
        const v = f.velocity;
        const what = c.tumble >= 0 ? `tumble ${c.tumble.toFixed(2)}` : c.recovering >= 0 ? `recover ${c.recovering.toFixed(2)}` : f.heldBy ? `held by ${f.heldBy}` : isHolding(c) ? `holding ${f.holding ?? '?'} ${(c.holdAngle * 57.3).toFixed(0)}°` : c.stun > 0 ? `stun ${c.stun.toFixed(2)}` : c.punchTime >= 0 ? 'punch' : 'free';
        const touch = f.touching ? ` touch ${f.touching}` : '';
        return `${f.id}  ${views[i].blobbi.animator.state.padEnd(5)} ${what.padEnd(16)} v ${Math.hypot(v.x, v.z).toFixed(2)} vy ${v.y.toFixed(2)} ${f.grounded ? 'ground' : 'air'} tilt ${((f.tilt * 180) / Math.PI).toFixed(0)}°${touch}`;
      };
      const orbLine = s.orbs.map((o, i) => `${i}:${o.active ? 'up' : `back in ${o.timer.toFixed(1)}s`}`).join(' · ');
      lines.push('', ...s.fighters.map((_, i) => state(i)), `holds ${match.holdsConsistent() ? 'consistent' : 'INCONSISTENT'} · grab ${COMBAT.grabRange} m (blue) · punch ${COMBAT.punchRange} m (red) · cam r ${cameraPose.radius.toFixed(1)}`);
      lines.push(`orbs ${orbLine} · reach ${ORBS.collectRadius} m (yellow)`, `sweeper ${((s.sweeper.angle * 180) / Math.PI).toFixed(0)}° · ${SWEEPER.angularSpeed} rad/s · reach ${SWEEPER.reach} m (ring) · tick ${s.tick}`);
      s.fighters.forEach((f) => lines.push(`${f.id} power ${f.powerLevel}: push ×${pushAuthority(f.powerLevel).toFixed(2)} speed ×${speedMultiplier(f.powerLevel).toFixed(2)} · last impact ${f.lastImpact.toFixed(2)} · sweeper ${lastHazard[f.id] || '-'}`));
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
      match,
      views,
      bots,
      events,
      get snapshot() {
        return snapshot;
      },
      get cameraPose() {
        return cameraPose;
      },
      /** Drive frames by hand (a hidden tab gets none); scripted checks step at a fixed 1/60 s. */
      step(frames = 1, dt = 1 / 60) {
        for (let i = 0; i < frames; i++) frame(dt);
      },
      key(code: string, down: boolean) {
        window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
      },
      press(code: string) {
        window.dispatchEvent(new KeyboardEvent('keydown', { code }));
        window.dispatchEvent(new KeyboardEvent('keyup', { code }));
      },
      /** Scripted checks: drive fighter `i` with this intent (null hands it back), and switch the bots on or off. */
      script(i: number, intent: Partial<MoveIntent> | null) {
        inputs[i].script = intent ? { x: 0, z: 0, run: false, jump: false, punch: false, grab: false, ...intent } : null;
      },
      setBots(on: boolean) {
        botsOn = on;
      },
      holdsConsistent: () => match.holdsConsistent(),
      newMatch,
    },
  });
}

start().catch((err) => {
  hud.textContent = `Havok failed to start: ${err}`;
  console.error(err);
});
