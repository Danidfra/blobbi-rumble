/**
 * NETWORK MODE (rumble.html?network=1): the match runs on the server; this
 * page is a client of it. It sends its player's intent (never a position,
 * a hit or a pickup) and draws the authoritative states, smoothed:
 *
 *   REMOTE FIGHTERS, the sweeper, everything else: interpolated between the
 *   buffered states around a render time a little behind the server's
 *   (`client/interp.ts`), so 20 states a second, unevenly spaced, draw as
 *   continuous motion.
 *
 *   YOUR FIGHTER: predicted from your keys at once and reconciled against
 *   every state by the inputs it acknowledges (`client/predict.ts`), while
 *   its locomotion is yours; drawn from the interpolated authority while
 *   the server has it (tumbling, stunned, held, out).
 *
 * Gameplay stays the server's: no predicted or interpolated transform is
 * sent anywhere or used for any rule. A punch starts its arm swing at once
 * when the server's last word says it can punch (cosmetic only: whether it
 * lands, and on whom, is the server's); a grab shows nothing until the
 * server says it held.
 *
 * Keys: any of WASD / arrows, Shift, Space / Enter, F / K, G / L; F3 debug,
 * F4 network diagnostics. Dev query flags: `?server=ws://host:port`,
 * `?interp=0` (draw the newest state, as M7B did), `?predict=0`.
 */
import { canAct, type CombatState } from '../combat/combat';
import { Keyboard, PlayerInput, type KeyBindings, type MoveIntent } from '../control/input';
import { inputMessage, isNewer, type ClientMessage, type Control, type ServerMessage, type StateMessage } from '../net/protocol';
import { ROSTER } from '../roster';
import { combatOf } from '../sim/read';
import type { FighterSnapshot, MatchSnapshot } from '../sim/snapshot';
import { COMBAT } from '../tuning';
import { NET_VIEW, SnapshotBuffer, type Sample } from './interp';
import { LocalPredictor, predictable, supported, type Body } from './predict';
import { RumblePresenter } from './presenter';

const NET_BINDINGS: KeyBindings = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  run: ['ShiftLeft', 'ShiftRight'],
  jump: ['Space', 'Enter'],
  punch: ['KeyF', 'KeyK'],
  grab: ['KeyG', 'KeyL'],
};
const CONTROLS = ['YOU  WASD/arrows move · Shift run · Space/Enter jump', '     F/K punch · G/L grab/throw · grabbed? alternate left/right', 'walk into an orb: harder punches and throws this round', 'F3 colliders & reach · F4 network numbers', 'the next match starts by itself'];
/** Movement is resent at least this often, ms, so the server knows the keys are still held (it lets go after a second of silence). */
const KEEPALIVE_MS = 200;
const PUNCH_TIME = COMBAT.punchActive + COMBAT.punchRecovery;

/** Running statistics of a stream of numbers over a sliding window. */
class Window {
  private readonly xs: number[] = [];
  constructor(private readonly size = 120) {}
  add(x: number) {
    this.xs.push(x);
    if (this.xs.length > this.size) this.xs.shift();
  }
  get mean() {
    return this.xs.length ? this.xs.reduce((a, b) => a + b, 0) / this.xs.length : 0;
  }
  get sd() {
    const m = this.mean;
    return this.xs.length ? Math.sqrt(this.xs.reduce((a, b) => a + (b - m) ** 2, 0) / this.xs.length) : 0;
  }
  get max() {
    return this.xs.length ? Math.max(...this.xs) : 0;
  }
  get values(): readonly number[] {
    return this.xs;
  }
}

export async function startNetwork(canvas: HTMLCanvasElement, hud: HTMLElement) {
  const q = new URLSearchParams(location.search);
  const url = q.get('server') ?? `ws://${location.hostname}:8787`;
  const useInterp = q.get('interp') !== '0';
  const usePredict = q.get('predict') !== '0';
  const keyboard = new Keyboard([NET_BINDINGS]);
  const input = new PlayerInput(keyboard, NET_BINDINGS);
  // Dev: ?delay=ms overrides the interpolation delay, to measure it.
  const delay = q.has('delay') ? Number(q.get('delay')) / 1000 : NET_VIEW.delay;
  const buffer = new SnapshotBuffer({ ...NET_VIEW, delay });
  const predictor = new LocalPredictor();
  let ws: WebSocket | null = null;
  let status = 'connecting';
  let you: string | null = null;
  let players: string[] = [];
  let tickHz = 60;
  let state: StateMessage | null = null;
  let newest: number | null = null;
  let presenter: RumblePresenter | null = null;
  let showNet = false;
  // Input: the movement last sent, and the one-shot requests not yet sent; every message has a higher seq than the last.
  let seq = 0;
  let sentMove = '';
  let sentAt = 0;
  const actions = { jump: false, punch: false, grab: false };
  // The cosmetic punch: when it started (client seconds), and whether the server's own punch display is being held back for it.
  let cosmeticPunch = -1;
  let suppressAuthPunch = false;
  let suppressSince = 0;
  // Measurements.
  let rtt = NaN;
  let pingId = 0;
  const stats = { states: 0, stale: 0, bytes: 0, statesPerSec: 0, bytesPerSec: 0, lastStateBytes: 0, windowStart: performance.now(), lastArrival: 0, extrapolatedFrames: 0, frozenFrames: 0, frames: 0 };
  const gaps = new Window(100);
  const aheadW = new Window(120);
  const errors = new Window(200);
  let lastSample: Sample | null = null;
  /** Per fighter, the positions drawn in the last frames (for the smoothness measurement). */
  const drawn: { x: number; z: number; t: number }[][] = [];

  const send = (m: ClientMessage) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };
  const sendInput = (move: Pick<MoveIntent, 'x' | 'z' | 'run'>) => {
    seq += 1;
    send(inputMessage(seq, move, actions));
    actions.jump = actions.punch = actions.grab = false;
    sentMove = JSON.stringify(move);
    sentAt = performance.now();
  };

  const connect = () => {
    status = `connecting to ${url}`;
    you = null;
    newest = null;
    seq = 0;
    predictor.reset();
    const socket = new WebSocket(url);
    ws = socket;
    socket.onopen = () => (status = 'connected');
    socket.onmessage = (e) => {
      const text = String(e.data);
      stats.bytes += text.length;
      const now = performance.now() / 1000;
      const m = JSON.parse(text) as ServerMessage;
      if (m.t === 'welcome') {
        you = m.you;
        players = m.players;
        tickHz = m.tickHz;
        predictor.reset();
        status = `connected · ${m.tickHz} Hz match, ${m.snapshotHz} Hz state`;
      } else if (m.t === 'state') {
        // Late or repeated states are dropped: the newest tick wins.
        if (!isNewer(m.tick, newest)) {
          stats.stale += 1;
          return;
        }
        newest = m.tick;
        state = m;
        stats.states += 1;
        stats.lastStateBytes = text.length;
        if (stats.lastArrival) gaps.add((now - stats.lastArrival) * 1000);
        stats.lastArrival = now;
        buffer.push(m.snapshot, now);
        // Your fighter: reconcile the prediction with what the server says it did with your inputs.
        const i = you ? m.snapshot.players.indexOf(you) : -1;
        if (i >= 0) {
          const f = m.snapshot.fighters[i];
          const allowed = usePredict && predictable(f, m.snapshot.phase === 'playing');
          const r = predictor.reconcile(f, m.tick, 1 / tickHz, m.acks[you!] ?? -1, m.ackTicks?.[you!] ?? m.tick, allowed);
          if (r.kind === 'kept' || r.kind === 'smoothed' || r.kind === 'snapped') errors.add(r.error);
        }
      } else if (m.t === 'pong') {
        rtt = performance.now() - m.ct;
      }
    };
    socket.onclose = () => {
      status = 'disconnected · retrying';
      you = null;
      setTimeout(connect, 2000);
    };
  };
  connect();
  setInterval(() => send({ t: 'ping', id: ++pingId, ct: performance.now() }), 1000);
  // A tab that loses focus or is hidden lets go of everything at once.
  const release = () => {
    keyboard.held.clear();
    sendInput({ x: 0, z: 0, run: false });
  };
  window.addEventListener('blur', release);
  document.addEventListener('visibilitychange', () => document.hidden && release());
  window.addEventListener('keydown', (e) => {
    if (e.code === 'F4') {
      showNet = !showNet;
      e.preventDefault();
    }
  });

  /** Your fighter as drawn: predicted (or handed over from the interpolated authority), with the newest server word on everything discrete. */
  const ownFighter = (interp: FighterSnapshot, latest: FighterSnapshot, playing: boolean, now: number): FighterSnapshot => {
    const authority: Body = { x: interp.position.x, y: interp.position.y, z: interp.position.z, vx: interp.velocity.x, vy: interp.velocity.y, vz: interp.velocity.z, yaw: interp.yaw };
    const shown = predictor.show(authority);
    // The server has you: drawn from the interpolated authority, but your struggle bar reads its newest word (still the server's).
    if (!predictor.predicting) return { ...interp, position: { x: shown.x, y: shown.y, z: shown.z }, combat: { ...interp.combat, struggle: interp.heldBy ? latest.combat.struggle : 0 } };
    const body = predictor.body!;
    // The punch's arm: the cosmetic swing while it runs; the server's own swing held back until that punch is over.
    let punchTime = latest.combat.punchTime;
    if (cosmeticPunch >= 0) {
      const t = now - cosmeticPunch;
      if (t < PUNCH_TIME) punchTime = t;
      else cosmeticPunch = -1;
    }
    if (cosmeticPunch < 0 && suppressAuthPunch) {
      if (latest.combat.punchTime < 0 && now - suppressSince > 0.1) suppressAuthPunch = false;
      else if (now - suppressSince > 1) suppressAuthPunch = false;
      else punchTime = -1;
    }
    return {
      ...latest,
      position: { x: shown.x, y: shown.y, z: shown.z },
      velocity: { x: body.vx, y: body.vy, z: body.vz },
      yaw: shown.yaw,
      grounded: supported(body),
      upright: true,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      tilt: 0,
      combat: { ...latest.combat, punchTime },
    };
  };

  const frame = (dt: number) => {
    const nowMs = performance.now();
    const now = nowMs / 1000;
    stats.frames += 1;
    // Input: this frame's movement, and any press since the last frame, kept until it is sent.
    const yaw = presenter?.cameraYaw() ?? 0;
    const intent = input.read(yaw);
    actions.jump ||= intent.jump;
    actions.punch ||= intent.punch;
    actions.grab ||= intent.grab;
    const move = { x: intent.x, z: intent.z, run: intent.run };
    const latestSnap = buffer.newest;
    const meIndex = you && latestSnap ? latestSnap.players.indexOf(you) : -1;
    // The cosmetic punch starts only when the server's last word says a punch could start.
    if (intent.punch && meIndex >= 0) {
      const c: CombatState = combatOf(latestSnap!.fighters[meIndex]);
      if (canAct(c) && c.punchCooldown <= 0 && predictor.predicting) {
        cosmeticPunch = now;
        suppressAuthPunch = true;
        suppressSince = now;
      }
    }
    if (you && (JSON.stringify(move) !== sentMove || actions.jump || actions.punch || actions.grab || nowMs - sentAt > KEEPALIVE_MS)) sendInput(move);
    // The frame of input this ran under, for prediction and its replay.
    if (you) predictor.frame(dt, seq, { ...move, jump: intent.jump, punch: false, grab: false });

    if (nowMs - stats.windowStart >= 1000) {
      const span = (nowMs - stats.windowStart) / 1000;
      stats.statesPerSec = stats.states / span;
      stats.bytesPerSec = stats.bytes / span;
      stats.states = 0;
      stats.bytes = 0;
      stats.windowStart = nowMs;
    }
    if (!state || !latestSnap) {
      hud.textContent = `BLOBBI RUMBLE · network\n${status}\nwaiting for the match…`;
      return;
    }
    // What to draw: the interpolated match (or, with ?interp=0, the newest state as it is).
    const sample = useInterp ? buffer.sample(now) : null;
    lastSample = sample;
    let s: MatchSnapshot = sample?.snapshot ?? latestSnap;
    if (sample) {
      aheadW.add(sample.ahead);
      if (sample.extrapolated) stats.extrapolatedFrames += 1;
      if (sample.late > NET_VIEW.maxExtrapolate) stats.frozenFrames += 1;
    }
    let ownJumped = false;
    if (meIndex >= 0) {
      const own = ownFighter(s.fighters[meIndex], latestSnap.fighters[meIndex], latestSnap.phase === 'playing', now);
      ownJumped = predictor.predicting && predictor.jumpedThisFrame;
      s = { ...s, fighters: s.fighters.map((f, i) => (i === meIndex ? own : f)) };
    }
    s.fighters.forEach((f, i) => {
      (drawn[i] ??= []).push({ x: f.position.x, z: f.position.z, t: now });
      if (drawn[i].length > 240) drawn[i].shift();
    });
    if (!presenter) presenter = new RumblePresenter(canvas, hud, s.players.map((id) => ({ id, identity: ROSTER.find((e) => e.label === id)?.identity ?? id })), s.orbs);
    const control: Record<string, Control> = state.control;
    const ack = you ? state.acks[you] : undefined;
    const m = predictor.metrics;
    presenter.present(
      s,
      dt,
      {
        status: [`NETWORK · ${status}`, you ? `you are ${you}` : `watching: all ${players.length} fighters are taken`, `rtt ${Number.isNaN(rtt) ? '…' : `${rtt.toFixed(0)} ms`} · ${stats.statesPerSec.toFixed(1)} states/s · ${(stats.bytesPerSec / 1024).toFixed(1)} KB/s`, ''],
        driver: (i) => (s.players[i] === you ? 'YOU' : control[s.players[i]] === 'human' ? 'human' : 'bot'),
        matchOverHint: 'the next match starts soon',
        controls: CONTROLS,
        strugglers: meIndex >= 0 ? [{ index: meIndex, keys: '← ↔ → (A ↔ D)' }] : [],
        footer: showNet
          ? [
              `NET  view ${useInterp ? `interpolated, ${(delay * 1000).toFixed(0)} ms behind` : 'newest state (no interpolation)'} · states ahead ${sample?.ahead ?? '-'} (mean ${aheadW.mean.toFixed(1)})${sample?.extrapolated ? ` · EXTRAPOLATING ${(sample.late * 1000).toFixed(0)} ms` : ''}`,
              `     state gaps ${gaps.mean.toFixed(0)} ± ${gaps.sd.toFixed(0)} ms (max ${gaps.max.toFixed(0)}) · extrapolated ${stats.extrapolatedFrames} / frozen ${stats.frozenFrames} of ${stats.frames} frames · tick ${state.tick}`,
              `     prediction ${usePredict ? (predictor.predicting ? 'ON' : 'server has you') : 'off'} · inputs ${ack ?? '-'}/${seq} acked, ${m.pending} frames pending · error ${(m.lastError * 100).toFixed(1)} cm (mean ${(errors.mean * 100).toFixed(1)}, max ${(errors.max * 100).toFixed(1)}) · kept ${m.kept} smoothed ${m.smoothed} snapped ${m.snapped} (resumed ${m.resumed}, ${m.resumeSnaps} by snap) · offset ${(m.offset * 100).toFixed(1)} cm`,
            ]
          : [],
      },
      predictor.predicting && meIndex >= 0 ? { id: you!, jumped: ownJumped } : undefined,
    );
  };

  let last = performance.now();
  const loop = () => {
    const now = performance.now();
    frame(Math.min(0.05, (now - last) / 1000));
    last = now;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  Object.assign(window, {
    rumble: {
      mode: 'network',
      get you() {
        return you;
      },
      get state() {
        return state;
      },
      get snapshot() {
        return state?.snapshot ?? null;
      },
      get rtt() {
        return rtt;
      },
      get seq() {
        return seq;
      },
      stats,
      /** Diagnostics for scripted measurements. */
      net: {
        gaps,
        errors,
        aheadW,
        drawn,
        predictor,
        get sample() {
          return lastSample;
        },
        flags: { useInterp, usePredict },
      },
      key(code: string, down: boolean) {
        window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
      },
      press(code: string) {
        window.dispatchEvent(new KeyboardEvent('keydown', { code }));
        window.dispatchEvent(new KeyboardEvent('keyup', { code }));
      },
    },
  });
}
