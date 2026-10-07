/**
 * BLOBBI RUMBLE: up to four Blobbis, punch, grab and throw, power orbs, a
 * sweeper, ring-outs, last Blobbi standing, first to three.
 *
 * One designed arena over a void. Every fighter is a `Fighter` from the
 * roster: the SAME body, controller and combat, driven by a person's keys
 * (P1, P2) or by a local test bot (P3, P4 by default). Falling off the
 * arena eliminates a fighter from the round; the others play on, and the
 * last one standing takes the point (the last ones falling together is a
 * draw). Three power orbs sit on the arena, whatever the number of
 * fighters. F3 shows colliders, reach and the state of everything, R
 * restarts a finished match. `?players=2|3|4`, `?bots=all`.
 *
 *   physics body ──► position / velocity / ground contact ──► visual Blobbi
 *
 * Nothing visual feeds back into the physics, and the kit package knows
 * nothing of any of this.
 */
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import '@babylonjs/core/Materials/standardMaterial';
import { createEnvironment } from '../playground/environment';
import { seedFromLabel } from '../playground/seeds';
import { createArena } from './arena/arena';
import { spawnPoints } from './arena/layout';
import { createSweeper, resetSweeper, sweeperHit, tickSweeper } from './arena/sweeper';
import { SweeperView } from './arena/sweeperView';
import { applyCamera, followCamera, framed, wantedCamera, type CameraPose } from './camera';
import { endGrab, holdBreaks, holdPull, isHolding, isTumbling, landPunch, punchActive, release, tickCombat, tryGrab, type Reaction } from './combat/combat';
import { Fighter, type FighterFrame } from './combat/fighter';
import { freeHolds, grabTarget, holdsConsistent, punchTarget, settleHolds, type Combatant, type Hold } from './combat/melee';
import { BotInput, type BotWorld } from './control/bot';
import { Keyboard, P1_BINDINGS, P2_BINDINGS, PlayerInput, ScriptableInput, type MoveIntent } from './control/input';
import { PhysicsDebug } from './debug';
import { collectOrbs, createOrbs, resetOrbs, tickOrbs } from './pickups/orbs';
import { OrbView } from './pickups/orbView';
import { nearestContacts } from './physics/contact';
import { enableHavok } from './physics/world';
import { RUMBLE_BODY } from './profile';
import { rosterFor, rosterOptions } from './roster';
import { aliveCount, createMatch, matchWinner, restartMatch, ringOut, tickMatch } from './rounds';
import { CAMERA, COMBAT, ORBS, PUSH, ROUND, SWEEPER } from './tuning';

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

/** What happened, for scripted checks and the playtest report. */
interface RumbleEvent {
  t: number;
  round: number;
  kind: 'punch' | 'grab' | 'throw' | 'interrupt' | 'drop' | 'orb' | 'sweeper' | 'out' | 'round';
  who: number;
  on?: number;
  note?: string;
}

const IDLE: MoveIntent = { x: 0, z: 0, run: false, jump: false, punch: false, grab: false };

async function start() {
  const plugin = await enableHavok(scene, RUMBLE_BODY.gravity);
  createArena(scene, env.shadows);
  const debug = new PhysicsDebug(scene, hud);
  const keyboard = new Keyboard([P1_BINDINGS, P2_BINDINGS]);
  const options = rosterOptions(location.search);
  const roster = rosterFor(options);
  const spawns = spawnPoints(options.count);
  const bots: (BotInput | null)[] = [];
  const scripts: ScriptableInput[] = [];
  /** Scripted checks may switch the bots off, and count matches so each one's rounds differ. */
  let botsOn = true;
  let matchCount = 0;
  const fighters = roster.map((entry, i) => {
    const driver = entry.keys ? new PlayerInput(keyboard, entry.keys) : new BotInput(i + 1);
    bots.push(driver instanceof BotInput ? driver : null);
    const input = new ScriptableInput(driver);
    scripts.push(input);
    return new Fighter(entry.label, scene, seedFromLabel(entry.identity), new Vector3(spawns[i].x, 0, spawns[i].z), spawns[i].yaw, input, env.shadows);
  });
  const n = fighters.length;
  for (const f of fighters) debug.track(f.body.body);
  const orbs = createOrbs();
  const orbView = new OrbView(scene, orbs, env.shadows);
  const sweeper = createSweeper(n);
  const sweeperView = new SweeperView(scene, env.shadows);
  debug.track(sweeperView.bar.physicsBody!);
  const lastHazard: string[] = Array(n).fill('');
  const match = createMatch(n);
  const subjects = () => fighters.filter((f) => framed(f.body.feet(), !f.eliminated)).map((f) => f.body.feet());
  let cameraPose: CameraPose = wantedCamera(subjects());
  let message = '';
  let time = 0;
  let frameCount = 0;
  const events: RumbleEvent[] = [];
  const log = (e: Omit<RumbleEvent, 't' | 'round'>) => events.push({ t: +time.toFixed(2), round: match.round, ...e });
  const wasTouching: boolean[] = Array(n).fill(false);
  let lastIntents: MoveIntent[] = fighters.map(() => IDLE);
  let lastContacts: number[] = Array(n).fill(-1);

  window.addEventListener('keydown', (e) => {
    if (e.code === 'F3') {
      debug.toggle();
      for (const f of fighters) f.showDebug(debug.on);
      orbView.showDebug(debug.on);
      sweeperView.showDebug(debug.on);
      e.preventDefault();
    }
    if (e.code === 'KeyR' && match.phase === 'matchOver') newMatch();
  });

  const resetRound = () => {
    for (const f of fighters) f.reset();
    for (const f of fighters) f.body.setGravityFactor(1);
    for (const b of bots) b?.reset(match.round + 1000 * matchCount);
    resetOrbs(orbs);
    resetSweeper(sweeper);
    sweeperView.apply(sweeper);
    cameraPose = wantedCamera(subjects());
  };
  const newMatch = () => {
    matchCount += 1;
    restartMatch(match);
    resetRound();
    message = '';
  };

  const combatants = (): Combatant[] => fighters.map((f) => ({ combat: f.combat, at: f.at(), facing: f.facing(), active: !f.eliminated }));
  /** Holds that ended: each victim has its weight back. */
  const dropped = (holds: Hold[]) => {
    for (const h of holds) fighters[h.holder].letGo(fighters[h.victim]);
  };
  /** A blow lands on `j` (a punch or the sweeper): any hold it is part of ends first, as holder or as held, then the reaction. */
  const strike = (list: Combatant[], j: number, reaction: Reaction, by: number) => {
    const ended = freeHolds(list, j);
    dropped(ended);
    for (const h of ended) if (by !== h.holder && by !== h.victim) log({ kind: 'interrupt', who: by, on: j, note: `${fighters[h.holder].label} lost ${fighters[h.victim].label}` });
    fighters[j].react(reaction, (COMBAT.hitSpin * reaction.impact) / COMBAT.tumbleThreshold);
  };

  /** One fighter's attack and hold this frame, against whichever fighter it takes. */
  const interact = (list: Combatant[], i: number, intent: MoveIntent, dt: number) => {
    const me = fighters[i];
    if (me.eliminated) return;
    // A punch in its active window lands on one fighter: the nearest in reach and arc.
    if (punchActive(me.combat)) {
      const j = punchTarget(list, i);
      if (j >= 0) {
        const other = fighters[j];
        const reaction = landPunch(me.combat, me.at(), me.facing(), me.speedAlongFacing(), me.power, other.combat, other.at(), RUMBLE_BODY.walkSpeed);
        if (reaction) {
          log({ kind: 'punch', who: i, on: j, note: `${reaction.kind} ${reaction.impact.toFixed(1)}${other.combat.held ? ' on a held body' : isHolding(other.combat) ? ' on a carrier' : ''}` });
          strike(list, j, reaction, i);
        }
      }
    }
    if (intent.grab) {
      const v = me.combat.victim;
      if (isHolding(me.combat) && v >= 0) {
        const victim = fighters[v];
        const thrown = release(me.combat, victim.combat, me.holdDir(), me.velocity(), me.power);
        me.letGo(victim);
        victim.react(thrown, COMBAT.throwSpin);
        log({ kind: 'throw', who: i, on: v, note: thrown.impact.toFixed(1) });
      } else {
        const j = grabTarget(list, i);
        if (j >= 0 && tryGrab(me.combat, me.at(), me.facing(), fighters[j].combat, fighters[j].at(), COMBAT, { grabber: i, victim: j })) {
          me.hold(fighters[j]);
          log({ kind: 'grab', who: i, on: j });
        }
      }
    }
    const v = me.combat.victim;
    if (isHolding(me.combat) && v >= 0) {
      const victim = fighters[v];
      const anchor = me.holdStep(dt);
      if (holdBreaks(me.combat, anchor, victim.feet()) || isTumbling(me.combat)) {
        endGrab(me.combat, victim.combat);
        me.letGo(victim);
        log({ kind: 'drop', who: i, on: v, note: 'hold broke' });
      } else {
        const pull = holdPull(anchor, me.velocity(), victim.feet(), victim.velocity3(), dt);
        victim.push(pull.victim.x, pull.victim.y, pull.victim.z);
        me.push(pull.grabber.x, 0, pull.grabber.z);
      }
    }
  };

  const botWorld = (self: number, list: Combatant[]): BotWorld => ({
    self,
    fighters: list.map((c, j) => ({ ...c, powerLevel: fighters[j].powerLevel })),
    orbs,
    sweeperAngle: sweeper.angle,
    grounded: fighters[self].body.grounded(),
  });

  const frame = (dt: number) => {
    time += dt;
    frameCount += 1;
    const look = env.camera.target.subtract(env.camera.position);
    const cameraYaw = Math.atan2(look.x, look.z);
    const playing = match.phase === 'playing';
    fighters.forEach((f, i) => (f.input.enabled = playing && !f.eliminated && (botsOn || !bots[i] || scripts[i].script !== null)));
    for (const f of fighters) if (!f.eliminated) tickCombat(f.combat, dt);

    // Body against body: each touching fighter's pushing contest is with the nearest body it touches.
    const centres = fighters.map((f) => (f.eliminated ? null : f.body.position()));
    const contacts = nearestContacts(centres, PUSH.contactMargin);
    lastContacts = contacts;
    fighters.forEach((f, i) => {
      const touching = contacts[i] >= 0;
      if (touching !== wasTouching[i]) {
        wasTouching[i] = touching;
        f.body.setFriction(touching ? PUSH.contactFriction : RUMBLE_BODY.friction);
      }
    });

    // The bots look at the arena as it stands, and decide.
    const before = combatants();
    bots.forEach((b, i) => b?.plan(botWorld(i, before), dt));

    // Steering. A shoving match is two touching fighters pushing into each other (read from the last frame's intents: one frame late, never wrong by much).
    const frames: FighterFrame[] = fighters.map((f, i) => {
      if (f.eliminated) {
        f.input.read(cameraYaw); // presses are consumed, so none queue up for the next round
        return { grounded: false, jumped: false, intent: IDLE };
      }
      const j = contacts[i];
      if (j < 0) return f.update(dt, cameraYaw);
      const a = centres[i]!;
      const b = centres[j]!;
      const span = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const toward = { x: (b.x - a.x) / span, z: (b.z - a.z) / span };
      const mine = lastIntents[i];
      const theirs = lastIntents[j];
      const shoving = mine.x * toward.x + mine.z * toward.z > 0.3 && -(theirs.x * toward.x + theirs.z * toward.z) > 0.3;
      return f.update(dt, cameraYaw, { gain: PUSH.gain, brakeGain: PUSH.brakeGain, authority: f.pushAuthority, toward, shoving, headOnCos: PUSH.headOnCos });
    });
    lastIntents = frames.map((fr) => fr.intent);

    if (playing) {
      // Attacks resolve one fighter at a time; the first to act turns round with the frames, so no seat always wins a simultaneous grab.
      const list = combatants();
      for (let k = 0; k < n; k++) {
        const i = (k + frameCount) % n;
        interact(list, i, frames[i].intent, dt);
      }
    }
    // Every hold stays a true pair (a holder that tumbled lets go here).
    dropped(settleHolds(combatants()));

    // Orbs: taken by whoever reaches one (the nearest), back after a while where no one stands.
    const bodies = fighters.map((f) => (f.eliminated ? null : f.body.position()));
    if (playing) {
      collectOrbs(orbs, bodies).forEach((taker, i) => {
        if (taker < 0) return;
        fighters[taker].gainPower();
        orbView.taken(i);
        log({ kind: 'orb', who: taker, note: `orb ${i} → level ${fighters[taker].powerLevel}` });
      });
    }
    tickOrbs(orbs, dt, bodies);
    orbView.update(dt);

    // The sweeper turns; a fighter under its leading face takes its blow, through the same reaction as a punch (no player power in it).
    tickSweeper(sweeper, dt);
    sweeperView.apply(sweeper);
    if (playing) {
      const list = combatants();
      fighters.forEach((f, i) => {
        if (f.eliminated) return;
        const hit = sweeperHit(sweeper, i, f.body.position(), RUMBLE_BODY.capsuleRadius, RUMBLE_BODY.capsuleCenterY);
        if (!hit) return;
        strike(list, i, hit.reaction, -1);
        lastHazard[i] = `${hit.reaction.kind} ${hit.reaction.impact.toFixed(2)} at ${hit.along.toFixed(2)} m (${hit.speed.toFixed(2)} m/s)`;
        log({ kind: 'sweeper', who: i, note: lastHazard[i] });
      });
    }
    const tilts = fighters.map((f) => (f.eliminated ? 0 : f.settle()));
    fighters.forEach((f, i) => {
      if (!f.eliminated) f.follow(dt, frames[i]);
    });

    // Ring-outs: who crossed the fall line this frame. Each is out of the round: its holds end, its body leaves play.
    const fell = fighters.map((f) => !f.eliminated && f.checkFall(dt));
    if (fell.some(Boolean)) {
      const list = combatants();
      fell.forEach((out, i) => {
        if (!out) return;
        dropped(freeHolds(list, i));
        if (match.phase === 'playing') {
          fighters[i].eliminate(new Vector3(i * 3, -40, 0));
          log({ kind: 'out', who: i, note: `${aliveCount(match) - 1} left` });
        }
      });
      const outs = fell.map((f, i) => (f ? fighters[i].label : '')).filter(Boolean);
      if (ringOut(match, fell)) {
        message = match.lastWinner === null ? `${outs.join(' & ')} OUT · nobody left · no point` : `${fighters[match.lastWinner].label} IS THE LAST BLOBBI STANDING`;
        log({ kind: 'round', who: match.lastWinner ?? -1, note: match.lastWinner === null ? 'draw' : 'win' });
      } else if (match.phase === 'playing') message = `${outs.join(' & ')} OUT · ${aliveCount(match)} left`;
    }
    const ended = tickMatch(match, dt);
    if (ended === 'round') {
      resetRound();
      message = '';
    } else if (ended === 'over') {
      // The scene settles: everyone back at their spawns, at rest, until a restart.
      resetRound();
    }
    if (match.phase === 'matchOver') message = `${fighters[matchWinner(match)!].label} WINS THE MATCH · press R to play again`;

    // The camera frames whoever is still in the round and on the arena.
    const wanted = subjects();
    if (wanted.length > 0) cameraPose = followCamera(cameraPose, wantedCamera(wanted), dt);
    applyCamera(env.camera, cameraPose);

    const lines = [`round ${match.round} · first to ${ROUND.target} · last Blobbi standing`, ''];
    fighters.forEach((f, i) => {
      const who = `${f.label} ${bots[i] ? 'bot ' : 'keys'}`;
      const state = match.alive[i] ? (f.eliminated ? 'OUT' : 'in ') : 'OUT';
      const power = `×${f.power.toFixed(2)}${f.powerLevel > 0 ? ` (${f.powerLevel})` : ''}`;
      const bot = bots[i] && !f.eliminated ? `  ${bots[i]!.memory.state.toLowerCase()}` : '';
      lines.push(`${who}  ${state}  ${'●'.repeat(match.score[i])}${'○'.repeat(Math.max(0, ROUND.target - match.score[i]))}  ${power.padEnd(11)}${bot}`);
    });
    lines.push('', message || (playing ? '' : '…'), '', ...CONTROLS);
    if (debug.on) {
      const state = (f: Fighter, i: number) => {
        const c = f.combat;
        const v = f.body.velocity();
        if (f.eliminated) return `${f.label}  out`;
        const what = c.tumble >= 0 ? `tumble ${c.tumble.toFixed(2)}` : c.recovering >= 0 ? `recover ${c.recovering.toFixed(2)}` : c.held ? `held by ${fighters[c.holder]?.label ?? '?'}` : isHolding(c) ? `holding ${fighters[c.victim]?.label ?? '?'} ${(c.holdAngle * 57.3).toFixed(0)}°` : c.stun > 0 ? `stun ${c.stun.toFixed(2)}` : c.punchTime >= 0 ? 'punch' : 'free';
        const touch = lastContacts[i] >= 0 ? ` touch ${fighters[lastContacts[i]].label}` : '';
        return `${f.label}  ${f.blobbi.animator.state.padEnd(5)} ${what.padEnd(16)} v ${Math.hypot(v.x, v.z).toFixed(2)} vy ${v.y.toFixed(2)} ${f.body.grounded() ? 'ground' : 'air'} tilt ${((tilts[i] * 180) / Math.PI).toFixed(0)}°${touch}`;
      };
      const orbLine = orbs.map((o, i) => `${i}:${o.active ? 'up' : `back in ${o.timer.toFixed(1)}s`}`).join(' · ');
      lines.push('', ...fighters.map(state), `holds ${holdsConsistent(combatants()) ? 'consistent' : 'INCONSISTENT'} · grab ${COMBAT.grabRange} m (blue) · punch ${COMBAT.punchRange} m (red) · cam r ${cameraPose.radius.toFixed(1)}`);
      lines.push(`orbs ${orbLine} · reach ${ORBS.collectRadius} m (yellow)`, `sweeper ${((sweeper.angle * 180) / Math.PI).toFixed(0)}° · ${SWEEPER.angularSpeed} rad/s · reach ${SWEEPER.reach} m (ring)`);
      fighters.forEach((f, i) => lines.push(`${f.label} power ${f.powerLevel}: push ×${f.pushAuthority.toFixed(2)} speed ×${f.speedMultiplier.toFixed(2)} · last impact ${f.lastImpact.toFixed(2)} · sweeper ${lastHazard[i] || '-'}`));
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
      fighters,
      bots,
      p1: fighters[0],
      p2: fighters[1],
      match,
      orbs,
      sweeper,
      keyboard,
      debug,
      plugin,
      events,
      get cameraPose() {
        return cameraPose;
      },
      /** Scripted checks: drive fighter `i` with this intent (null hands it back), and switch the bots on or off. */
      script(i: number, intent: Partial<MoveIntent> | null) {
        scripts[i].script = intent ? { ...IDLE, ...intent } : null;
      },
      setBots(on: boolean) {
        botsOn = on;
      },
      /** Whether every hold is a true pair, nobody with two holders. */
      holdsConsistent: () => holdsConsistent(combatants()),
      /** Drive frames by hand (a hidden tab gets none); scripted checks step the physics at a fixed 1/60 s. */
      step(frames = 1, dt = 1 / 60) {
        for (let i = 0; i < frames; i++) frame(dt);
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
