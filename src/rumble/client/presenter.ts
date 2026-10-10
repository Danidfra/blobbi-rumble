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
import { seedFromLabel } from '../../playground/seeds';
import { isHolding } from '../combat/combat';
import { powerMultiplier, pushAuthority, speedMultiplier } from '../pickups/power';
import { RUMBLE_BODY } from '../profile';
import { combatOf } from '../sim/read';
import type { MatchSnapshot } from '../sim/snapshot';
import { CAMERA, COMBAT, ORBS, ROUND, SWEEPER } from '../tuning';
import { createArena } from '../view/arenaView';
import { createWorld } from '../view/world';
import { applyCamera, followCamera, framed, wantedCamera, type CameraPose } from '../view/camera';
import { PhysicsDebug } from '../view/debug';
import type { BlobbiIdentityInput } from '@blobbi-kit/3d';
import { CLASSIC, arenaById, type ArenaDef } from '../arena/arenas';
import { themeFor } from '../view/theme';
import { FighterView } from '../view/fighterView';
import type { Arena } from '../view/arenaView';
import { OrbView } from '../view/orbView';
import { BananaView } from '../view/bananaView';
import { extentOf, platformUnder } from '../arena/geometry';
import { BANANAS } from '../tuning';
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
  /** The fighters people at this screen play, and the keys each one struggles with (shown when it is held). */
  strugglers?: { index: number; keys: string }[];
  /** M11F: a player at this screen who is out of the round and aiming a banana peel: where, and the keys. */
  aimers?: { index: number; aim: { x: number; z: number }; keys: string }[];
  /** Debug only: whether the holds are consistent (known where the match runs). */
  holdsConsistent?: boolean;
  /** Show the text HUD (default true). Network mode shows it only for F4; F3 always shows it. */
  textHud?: boolean;
}

export class RumblePresenter {
  readonly engine: Engine;
  readonly scene: Scene;
  readonly views: FighterView[];
  /** Each fighter's default look (its roster seed), to go back to. */
  private readonly defaults: Map<string, string>;
  /** The look a fighter wears instead of its default, by its key (null: the default). */
  private readonly worn = new Map<string, string | null>();
  private readonly env;
  private readonly debug: PhysicsDebug;
  private orbView: OrbView;
  private bananaView: BananaView;
  private sweeperView: SweeperView | null = null;
  /** M11A: the arena drawn, and its definition; rebuilt when the snapshot names another. */
  private arenaView: Arena;
  private def: ArenaDef;
  private cameraPose: CameraPose | null = null;
  private previous: MatchSnapshot | null = null;
  private message = '';
  private readonly lastHazard: Record<string, string> = {};

  constructor(
    canvas: HTMLCanvasElement,
    private readonly hud: HTMLElement,
    fighters: readonly PresentedFighter[],
    orbs: MatchSnapshot['orbs'],
    arenaId: string = CLASSIC.id,
  ) {
    this.engine = new Engine(canvas, true, { adaptToDeviceRatio: true, stencil: true });
    this.scene = new Scene(this.engine);
    this.env = createWorld(this.scene, canvas);
    const cam = this.env.camera;
    cam.lowerBetaLimit = 0.3;
    cam.upperBetaLimit = Math.PI / 2 - 0.1;
    cam.lowerRadiusLimit = CAMERA.minRadius;
    cam.upperRadiusLimit = CAMERA.maxRadius;
    cam.alpha = CAMERA.alpha;
    cam.beta = CAMERA.beta;
    this.def = arenaById(arenaId) ?? CLASSIC;
    this.arenaView = createArena(this.scene, this.env.shadows, this.def);
    this.debug = new PhysicsDebug(this.scene, hud, this.def);
    this.defaults = new Map(fighters.map((f) => [f.id, seedFromLabel(f.identity)]));
    this.views = fighters.map((f) => new FighterView(f.id, f.id, this.scene, this.defaults.get(f.id)!, this.env.shadows));
    this.orbView = new OrbView(this.scene, orbs, this.env.shadows);
    this.bananaView = new BananaView(this.scene, this.env.shadows);
    if (this.def.sweeper) this.sweeperView = new SweeperView(this.scene, this.env.shadows, themeFor(this.def.theme), this.def.sweeper);
    cam.upperRadiusLimit = this.def.camera.maxRadius;
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'F3') return;
      this.debug.toggle();
      for (const v of this.views) v.showDebug(this.debug.on);
      this.orbView.showDebug(this.debug.on);
      this.sweeperView?.showDebug(this.debug.on);
      e.preventDefault();
    });
    window.addEventListener('resize', () => this.engine.resize());
  }

  /** The camera's yaw, for camera-relative keys. */
  /** M11F: the floor's height under a point (for the aim reticle), or 0. */
  private floorHeight(p: { x: number; z: number }): number {
    return platformUnder(this.def.platforms, p)?.y ?? 0;
  }

  /** M11F: keep an aim point within the arena's extent. */
  clampAim(p: { x: number; z: number }): { x: number; z: number } {
    const e = extentOf(this.def.platforms);
    return { x: Math.max(-e.halfWidth, Math.min(e.halfWidth, p.x)), z: Math.max(-e.halfDepth, Math.min(e.halfDepth, p.z)) };
  }

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
  /** What just happened, in words (a ring-out, a round or match decided), until the next round clears it. */
  get currentMessage(): string {
    return this.message;
  }

  /** A fighter's name tag: a person's name, or (null) its slot label again. Presentation only. */
  /**
   * M9B: a fighter takes a look (the player's chosen Blobbi's Rumble form)
   * or goes back to its default. The old body is disposed and a new one is
   * built on the spot, the same slot, the same rings and tag; the snapshot
   * places it on the next frame, so no match state is involved. The same
   * key again builds nothing. A body the kit refuses leaves the default;
   * the return says what is worn now.
   */
  setLook(id: string, look: BlobbiIdentityInput | null, key: string | null): 'worn' | 'default' | 'unchanged' {
    const i = this.views.findIndex((v) => v.id === id);
    const seed = this.defaults.get(id);
    if (i < 0 || !seed) return 'unchanged';
    const current = this.worn.get(id) ?? null;
    if (current === key) return 'unchanged';
    const old = this.views[i];
    let view: FighterView;
    try {
      view = new FighterView(id, old.label, this.scene, look ?? seed, this.env.shadows);
    } catch {
      // Nothing the kit can build: keep what is there (the default, or the previous form).
      return current === null ? 'default' : 'unchanged';
    }
    view.setTag(old.tagText, old.tagMono);
    view.showDebug(this.debug.on);
    this.views[i] = view;
    old.dispose();
    this.worn.set(id, look ? key : null);
    return look ? 'worn' : 'default';
  }

  setTag(id: string, name: string | null) {
    const view = this.views.find((v) => v.label === id);
    view?.setTag(name ?? id, name === null);
  }

  /** M11A: the arena the snapshot names: rebuilt when it changes (a rotation, another room). */
  private syncArena(s: MatchSnapshot) {
    if (s.arena === this.def.id) return;
    const def = arenaById(s.arena);
    if (!def) return;
    this.arenaView.dispose();
    this.sweeperView?.dispose();
    this.sweeperView = null;
    this.orbView.dispose();
    this.def = def;
    this.arenaView = createArena(this.scene, this.env.shadows, def);
    this.orbView = new OrbView(this.scene, s.orbs, this.env.shadows);
    if (def.sweeper) this.sweeperView = new SweeperView(this.scene, this.env.shadows, themeFor(def.theme), def.sweeper);
    this.debug.build(def);
    this.orbView.showDebug(this.debug.on);
    this.sweeperView?.showDebug(this.debug.on);
    this.env.camera.upperRadiusLimit = def.camera.maxRadius;
    this.cameraPose = null;
  }

  /** The arena in play, by name. */
  get arenaName(): string {
    return this.def.name;
  }

  present(s: MatchSnapshot, dt: number, info: HudInfo, own?: { id: string; jumped: boolean }) {
    this.syncArena(s);
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
    const aimer = info.aimers?.find((a) => s.fighters[a.index]?.eliminated && s.phase === 'playing');
    this.bananaView.update(dt, s.bananas, aimer ? { x: aimer.aim.x, y: this.floorHeight(aimer.aim), z: aimer.aim.z } : null);
    if (this.sweeperView && s.sweeper) this.sweeperView.apply(s.sweeper.angle);
    this.arenaView.applyPieces(s.pieces, s.time);
    this.arenaView.applyTime(s.time);
    this.debug.sync(s);
    if (s.phase === 'matchOver' && s.matchWinner) this.message = `${s.matchWinner} WINS THE MATCH · ${info.matchOverHint}`;

    // The camera frames whoever is still in the round and on the arena.
    const wanted = this.subjects(s);
    const camRules = { ...CAMERA, bounds: this.def.camera.bounds, maxRadius: this.def.camera.maxRadius };
    if (!this.cameraPose) this.cameraPose = wantedCamera(wanted, camRules);
    else if (wanted.length > 0) this.cameraPose = followCamera(this.cameraPose, wantedCamera(wanted, camRules), dt);
    applyCamera(this.env.camera, this.cameraPose);

    const lines = [...(info.status ?? []), `${this.def.name} · round ${s.round} · first to ${ROUND.target} · last Blobbi standing`, ''];
    s.fighters.forEach((f, i) => {
      const who = `${f.id} ${info.driver(i).padEnd(5)}`;
      const state = f.alive ? (f.eliminated ? 'OUT' : 'in ') : 'OUT';
      const power = `×${powerMultiplier(f.powerLevel).toFixed(2)}${f.powerLevel > 0 ? ` (${f.powerLevel})` : ''}`;
      const bot = info.botState?.(i);
      lines.push(`${who} ${state}  ${'●'.repeat(f.score)}${'○'.repeat(Math.max(0, ROUND.target - f.score))}  ${power.padEnd(11)}${bot && !f.eliminated ? `  ${bot}` : ''}`);
    });
    lines.push('', this.message || (s.phase === 'playing' ? '' : '…'));
    for (const a of info.aimers ?? []) {
      const f = s.fighters[a.index];
      if (!f?.eliminated || s.phase !== 'playing') continue;
      const alive = s.fighters.filter((x) => x.alive).length;
      const why = alive < BANANAS.minAlive ? `no peels with ${alive} left in the round` : f.bananas.left === 0 ? 'no peels left this round' : f.bananas.cooldown > 0 ? `next peel in ${f.bananas.cooldown.toFixed(1)} s` : `${f.bananas.left} peel${f.bananas.left === 1 ? '' : 's'} left`;
      lines.push(`${f.id} OUT · aim ${a.keys} · ${why}`);
    }
    for (const { index, keys } of info.strugglers ?? []) {
      const f = s.fighters[index];
      if (!f || f.eliminated) continue;
      if (f.ledge) {
        // M11C: the grip left, and what the keys do on the ledge.
        const filled = Math.round(f.ledge.grip * 10);
        lines.push(`${f.id} ${f.ledge.phase === 'climb' ? 'CLIMBING' : 'HANGING'} · GRIP [${'█'.repeat(filled)}${'-'.repeat(10 - filled)}] jump to climb · grab or push away to let go`);
        continue;
      }
      if (!f.heldBy) continue;
      const filled = Math.round(f.combat.struggle * 10);
      lines.push(`${f.id} GRABBED by ${f.heldBy} · STRUGGLE [${'█'.repeat(filled)}${'-'.repeat(10 - filled)}] alternate ${keys} to break free`);
    }
    lines.push('', ...info.controls);
    if (info.footer?.length) lines.push('', ...info.footer);
    if (this.debug.on) lines.push(...this.debugLines(s, info));
    const text = info.textHud !== false || this.debug.on;
    const display = text ? '' : 'none';
    if (this.hud.style.display !== display) this.hud.style.display = display;
    if (text) this.debug.print(lines);
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
      if (f.heldBy && f.combat.struggle > (was.combat.struggle ?? 0)) this.views[i].struggled();
      if (f.escapes > (was.escapes ?? 0)) {
        this.views[i].struck();
        this.message = `${f.id} BROKE FREE of ${was.heldBy ?? 'the hold'}`;
      }
    });
    s.orbs.forEach((o, i) => {
      if (prev.orbs[i].active && !o.active) this.orbView.taken(i);
    });
    // M11F: a peel that went before its time was slipped on: a burst where it lay.
    for (const b of prev.bananas) {
      if (b.age < BANANAS.lifetime - 0.2 && !s.bananas.some((n) => n.owner === b.owner && Math.abs(n.x - b.x) < 1e-6 && Math.abs(n.z - b.z) < 1e-6)) this.bananaView.burst(b.x, b.y, b.z);
    }
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
      s.sweeper && this.def.sweeper ? `sweeper ${((s.sweeper.angle * 180) / Math.PI).toFixed(0)}° · ${this.def.sweeper.angularSpeed} rad/s · reach ${this.def.sweeper.reach} m (ring) · tick ${s.tick}` : `no sweeper · tick ${s.tick}`,
      ...s.fighters.map((f) => `${f.id} power ${f.powerLevel}: push ×${pushAuthority(f.powerLevel).toFixed(2)} speed ×${speedMultiplier(f.powerLevel).toFixed(2)} · last impact ${this.lastHazard[f.id] ?? '0.00'}`),
    ];
  }
}
