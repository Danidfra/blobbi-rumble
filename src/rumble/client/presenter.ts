/**
 * THE PRESENTER: everything the player sees, drawn from match snapshots
 * alone, the same way whether the snapshot came from a match in this page
 * (local mode) or from the server (network mode). The scene, the arena,
 * the visual Blobbis, orbs, sweeper, camera, HUD and F3 debug.
 *
 * It needs no event stream: what a client shows of a moment it reads from
 * the difference between two snapshots, which no snapshot rate can drop.
 * A fighter's `hits` counter went up: the squash; `jumps` went up: the jump
 * animation; its power level went up: the ring's flash; an orb went from
 * there to gone: its burst; fighters left the round, the round was decided,
 * a new round or match began: the messages and fresh views.
 */
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import '@babylonjs/core/Materials/standardMaterial';
import { createEnvironment } from '../../playground/environment';
import { seedFromLabel } from '../../playground/seeds';
import { isHolding } from '../combat/combat';
import { powerMultiplier, pushAuthority, speedMultiplier } from '../pickups/power';
import { RUMBLE_BODY } from '../profile';
import { combatOf } from '../sim/read';
import type { MatchSnapshot } from '../sim/snapshot';
import { CAMERA, COMBAT, ORBS, ROUND, SWEEPER } from '../tuning';
import { createArena } from '../view/arenaView';
import { applyCamera, followCamera, framed, wantedCamera, type CameraPose } from '../view/camera';
import { PhysicsDebug } from '../view/debug';
import { FighterView } from '../view/fighterView';
import { OrbView } from '../view/orbView';
import { SweeperView } from '../view/sweeperView';

export interface PresentedFighter {
  id: string;
  /** The Blobbi's identity label (`seedFromLabel`). */
  identity: string;
}

/** What the driving mode adds to a frame's HUD. */
export interface HudInfo {
  /** Lines above the match's (connection, who you are, network numbers). */
  status?: string[];
  /** Lines appended at the end (network diagnostics). */
  footer?: string[];
  /** How each fighter is driven, for its HUD line ("keys", "bot", "YOU", …), and the bot's state if it is one. */
  driver: (i: number) => string;
  botState?: (i: number) => string | null;
  /** The match-over line's ending. */
  matchOverHint: string;
  controls: string[];
  /** Debug only: whether the holds are consistent (known where the match runs). */
  holdsConsistent?: boolean;
}

export class RumblePresenter {
  readonly engine: Engine;
  readonly scene: Scene;
  readonly views: FighterView[];
  private readonly env;
  private readonly debug: PhysicsDebug;
  private readonly orbView: OrbView;
  private readonly sweeperView: SweeperView;
  private cameraPose: CameraPose | null = null;
  private previous: MatchSnapshot | null = null;
  private message = '';
  private readonly lastHazard: Record<string, string> = {};

  constructor(
    canvas: HTMLCanvasElement,
    private readonly hud: HTMLElement,
    fighters: readonly PresentedFighter[],
    orbs: MatchSnapshot['orbs'],
  ) {
    this.engine = new Engine(canvas, true, { adaptToDeviceRatio: true, stencil: true });
    this.scene = new Scene(this.engine);
    this.env = createEnvironment(this.scene, canvas, { props: false });
    const cam = this.env.camera;
    cam.lowerBetaLimit = 0.3;
    cam.upperBetaLimit = Math.PI / 2 - 0.1;
    cam.lowerRadiusLimit = CAMERA.minRadius;
    cam.upperRadiusLimit = CAMERA.maxRadius;
    cam.alpha = CAMERA.alpha;
    cam.beta = CAMERA.beta;
    createArena(this.scene, this.env.shadows);
    this.debug = new PhysicsDebug(this.scene, hud);
    this.views = fighters.map((f) => new FighterView(f.id, f.id, this.scene, seedFromLabel(f.identity), this.env.shadows));
    this.orbView = new OrbView(this.scene, orbs, this.env.shadows);
    this.sweeperView = new SweeperView(this.scene, this.env.shadows);
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'F3') return;
      this.debug.toggle();
      for (const v of this.views) v.showDebug(this.debug.on);
      this.orbView.showDebug(this.debug.on);
      this.sweeperView.showDebug(this.debug.on);
      e.preventDefault();
    });
    window.addEventListener('resize', () => this.engine.resize());
  }

  /** The camera's yaw, for camera-relative keys. */
  cameraYaw(): number {
    const look = this.env.camera.target.subtract(this.env.camera.position);
    return Math.atan2(look.x, look.z);
  }

  get camera(): CameraPose | null {
    return this.cameraPose;
  }

  /** Draw a frame: `s` is the newest snapshot (it may be the same as last frame's), `dt` the frame's seconds. */
  /**
   * `own`: the fighter this client predicts, whose jump animation follows
   * the prediction (`jumped`) rather than the server's counter, which
   * arrives a round trip later.
   */
  present(s: MatchSnapshot, dt: number, info: HudInfo, own?: { id: string; jumped: boolean }) {
    const prev = this.previous;
    const fresh = prev === null || s.tick !== prev.tick;
    const jumped = new Set<string>();
    if (fresh) this.compare(prev, s, jumped);
    if (own) {
      jumped.delete(own.id);
      if (own.jumped) jumped.add(own.id);
    }
    this.previous = s;
    s.fighters.forEach((f, i) => this.views[i].apply(f, dt, jumped.has(f.id)));
    this.orbView.update(dt, s.orbs);
    this.sweeperView.apply(s.sweeper.angle);
    this.debug.sync(s);
    if (s.phase === 'matchOver' && s.matchWinner) this.message = `${s.matchWinner} WINS THE MATCH · ${info.matchOverHint}`;

    // The camera frames whoever is still in the round and on the arena.
    const wanted = this.subjects(s);
    if (!this.cameraPose) this.cameraPose = wantedCamera(wanted);
    else if (wanted.length > 0) this.cameraPose = followCamera(this.cameraPose, wantedCamera(wanted), dt);
    applyCamera(this.env.camera, this.cameraPose);

    const lines = [...(info.status ?? []), `round ${s.round} · first to ${ROUND.target} · last Blobbi standing`, ''];
    s.fighters.forEach((f, i) => {
      const who = `${f.id} ${info.driver(i).padEnd(5)}`;
      const state = f.alive ? (f.eliminated ? 'OUT' : 'in ') : 'OUT';
      const power = `×${powerMultiplier(f.powerLevel).toFixed(2)}${f.powerLevel > 0 ? ` (${f.powerLevel})` : ''}`;
      const bot = info.botState?.(i);
      lines.push(`${who} ${state}  ${'●'.repeat(f.score)}${'○'.repeat(Math.max(0, ROUND.target - f.score))}  ${power.padEnd(11)}${bot && !f.eliminated ? `  ${bot}` : ''}`);
    });
    lines.push('', this.message || (s.phase === 'playing' ? '' : '…'), '', ...info.controls);
    if (info.footer?.length) lines.push('', ...info.footer);
    if (this.debug.on) lines.push(...this.debugLines(s, info));
    this.debug.print(lines);
    this.scene.render();
  }

  /** What happened between two snapshots, shown. */
  private compare(prev: MatchSnapshot | null, s: MatchSnapshot, jumped: Set<string>) {
    if (!prev) return;
    const newRound = s.round !== prev.round || (prev.phase !== 'playing' && s.phase === 'playing');
    if (newRound) {
      for (const v of this.views) v.reset();
      this.cameraPose = wantedCamera(this.subjects(s));
      this.message = '';
    }
    s.fighters.forEach((f, i) => {
      const was = prev.fighters[i];
      if (f.hits > was.hits) this.views[i].struck();
      if (f.jumps > was.jumps) jumped.add(f.id);
      if (f.powerLevel > was.powerLevel && !newRound) this.views[i].powered();
      if (f.lastImpact !== was.lastImpact || f.hits > was.hits) this.lastHazard[f.id] = `${f.lastImpact.toFixed(2)}`;
    });
    s.orbs.forEach((o, i) => {
      if (prev.orbs[i].active && !o.active) this.orbView.taken(i);
    });
    if (newRound) return;
    const outs = s.fighters.filter((f, i) => prev.fighters[i].alive && !f.alive).map((f) => f.id);
    if (prev.phase === 'playing' && s.phase === 'roundOver') {
      this.message = s.lastRoundWinner ? `${s.lastRoundWinner} IS THE LAST BLOBBI STANDING` : `${outs.join(' & ')} OUT · nobody left · no point`;
    } else if (outs.length > 0 && s.phase === 'playing') {
      this.message = `${outs.join(' & ')} OUT · ${s.fighters.filter((f) => f.alive).length} left`;
    }
  }

  private subjects(s: MatchSnapshot) {
    return s.fighters
      .map((f) => ({ x: f.position.x, y: f.position.y - RUMBLE_BODY.capsuleCenterY, z: f.position.z, alive: !f.eliminated }))
      .filter((f) => framed(f, f.alive))
      .map(({ x, y, z }) => ({ x, y, z }));
  }

  private debugLines(s: MatchSnapshot, info: HudInfo): string[] {
    const state = (i: number) => {
      const f = s.fighters[i];
      if (f.eliminated) return `${f.id}  out`;
      const c = combatOf(f);
      const v = f.velocity;
      const what = c.tumble >= 0 ? `tumble ${c.tumble.toFixed(2)}` : c.recovering >= 0 ? `recover ${c.recovering.toFixed(2)}` : f.heldBy ? `held by ${f.heldBy}` : isHolding(c) ? `holding ${f.holding ?? '?'} ${(c.holdAngle * 57.3).toFixed(0)}°` : c.stun > 0 ? `stun ${c.stun.toFixed(2)}` : c.punchTime >= 0 ? 'punch' : 'free';
      const touch = f.touching ? ` touch ${f.touching}` : '';
      return `${f.id}  ${this.views[i].blobbi.animator.state.padEnd(5)} ${what.padEnd(16)} v ${Math.hypot(v.x, v.z).toFixed(2)} vy ${v.y.toFixed(2)} ${f.grounded ? 'ground' : 'air'} tilt ${((f.tilt * 180) / Math.PI).toFixed(0)}°${touch}`;
    };
    const orbLine = s.orbs.map((o, i) => `${i}:${o.active ? 'up' : `back in ${o.timer.toFixed(1)}s`}`).join(' · ');
    const holds = info.holdsConsistent === undefined ? '' : `holds ${info.holdsConsistent ? 'consistent' : 'INCONSISTENT'} · `;
    return [
      '',
      ...s.fighters.map((_, i) => state(i)),
      `${holds}grab ${COMBAT.grabRange} m (blue) · punch ${COMBAT.punchRange} m (red) · cam r ${this.cameraPose?.radius.toFixed(1)}`,
      `orbs ${orbLine} · reach ${ORBS.collectRadius} m (yellow)`,
      `sweeper ${((s.sweeper.angle * 180) / Math.PI).toFixed(0)}° · ${SWEEPER.angularSpeed} rad/s · reach ${SWEEPER.reach} m (ring) · tick ${s.tick}`,
      ...s.fighters.map((f) => `${f.id} power ${f.powerLevel}: push ×${pushAuthority(f.powerLevel).toFixed(2)} speed ×${speedMultiplier(f.powerLevel).toFixed(2)} · last impact ${this.lastHazard[f.id] ?? '0.00'}`),
    ];
  }
}
