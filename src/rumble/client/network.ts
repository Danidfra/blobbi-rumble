/**
 * NETWORK MODE (rumble.html?network=1): the match runs on the server; this
 * page is a client of it. It sends its player's intent (never a position,
 * a hit or a pickup) and draws the newest authoritative state it has. No
 * match runs here, no prediction, no interpolation: what you see is the
 * server's last state, up to a round trip and a state interval behind your
 * keys. That is the M7B baseline M7C will improve on.
 *
 * The person at this page plays whichever fighter the server assigned; any
 * of WASD / arrows, Shift, Space / Enter, F / K and G / L drive it.
 * `?server=ws://host:port` points it elsewhere than ws://<this host>:8787.
 */
import { Keyboard, PlayerInput, type KeyBindings, type MoveIntent } from '../control/input';
import { isNewer, type ClientMessage, type Control, type ServerMessage, type StateMessage } from '../net/protocol';
import { ROSTER } from '../roster';
import type { MatchSnapshot } from '../sim/snapshot';
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
const CONTROLS = ['YOU  WASD/arrows move · Shift run · Space/Enter jump', '     F/K punch · G/L grab/throw', 'walk into an orb: harder punches and throws this round', 'F3 colliders & reach · the next match starts by itself'];
/** Movement is resent at least this often, ms, so the server knows the keys are still held (it lets go after a second of silence). */
const KEEPALIVE_MS = 200;

export async function startNetwork(canvas: HTMLCanvasElement, hud: HTMLElement) {
  const url = new URLSearchParams(location.search).get('server') ?? `ws://${location.hostname}:8787`;
  const keyboard = new Keyboard([NET_BINDINGS]);
  const input = new PlayerInput(keyboard, NET_BINDINGS);
  let ws: WebSocket | null = null;
  let status = 'connecting';
  let you: string | null = null;
  let players: string[] = [];
  let state: StateMessage | null = null;
  let newest: number | null = null;
  let presenter: RumblePresenter | null = null;
  // Input: the movement last sent, and the one-shot requests not yet sent; every message has a higher seq than the last.
  let seq = 0;
  let sentMove = '';
  let sentAt = 0;
  const actions = { jump: false, punch: false, grab: false };
  // Measurements.
  let rtt = NaN;
  let pingId = 0;
  const stats = { states: 0, stale: 0, bytes: 0, statesPerSec: 0, bytesPerSec: 0, lastStateBytes: 0, windowStart: performance.now() };

  const send = (m: ClientMessage) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };
  const sendInput = (move: Pick<MoveIntent, 'x' | 'z' | 'run'>) => {
    seq += 1;
    send({ t: 'input', seq, intent: { ...move, ...actions } });
    actions.jump = actions.punch = actions.grab = false;
    sentMove = JSON.stringify(move);
    sentAt = performance.now();
  };

  const connect = () => {
    status = `connecting to ${url}`;
    you = null;
    newest = null;
    seq = 0;
    const socket = new WebSocket(url);
    ws = socket;
    socket.onopen = () => (status = 'connected');
    socket.onmessage = (e) => {
      const text = String(e.data);
      stats.bytes += text.length;
      const m = JSON.parse(text) as ServerMessage;
      if (m.t === 'welcome') {
        you = m.you;
        players = m.players;
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

  const frame = (dt: number) => {
    // Input: this frame's movement, and any press since the last frame, kept until it is sent.
    const yaw = presenter?.cameraYaw() ?? 0;
    const intent = input.read(yaw);
    actions.jump ||= intent.jump;
    actions.punch ||= intent.punch;
    actions.grab ||= intent.grab;
    const move = { x: intent.x, z: intent.z, run: intent.run };
    const now = performance.now();
    if (you && (JSON.stringify(move) !== sentMove || actions.jump || actions.punch || actions.grab || now - sentAt > KEEPALIVE_MS)) sendInput(move);

    if (now - stats.windowStart >= 1000) {
      const span = (now - stats.windowStart) / 1000;
      stats.statesPerSec = stats.states / span;
      stats.bytesPerSec = stats.bytes / span;
      stats.states = 0;
      stats.bytes = 0;
      stats.windowStart = now;
    }
    if (!state) {
      hud.textContent = `BLOBBI RUMBLE · network\n${status}\nwaiting for the match…`;
      return;
    }
    const s: MatchSnapshot = state.snapshot;
    if (!presenter) presenter = new RumblePresenter(canvas, hud, s.players.map((id) => ({ id, identity: ROSTER.find((e) => e.label === id)?.identity ?? id })), s.orbs);
    const control: Record<string, Control> = state.control;
    const ack = you ? state.acks[you] : undefined;
    presenter.present(s, dt, {
      status: [
        `NETWORK · ${status}`,
        you ? `you are ${you}` : `watching: all ${players.length} fighters are taken`,
        `rtt ${Number.isNaN(rtt) ? '…' : `${rtt.toFixed(0)} ms`} · ${stats.statesPerSec.toFixed(1)} states/s · ${(stats.bytesPerSec / 1024).toFixed(1)} KB/s · state ${stats.lastStateBytes} B`,
        `tick ${state.tick}${ack !== undefined ? ` · inputs ${ack}/${seq} acked` : ''}${stats.stale ? ` · ${stats.stale} stale dropped` : ''}`,
        '',
      ],
      driver: (i) => (s.players[i] === you ? 'YOU' : control[s.players[i]] === 'human' ? 'human' : 'bot'),
      matchOverHint: 'the next match starts soon',
      controls: CONTROLS,
    });
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
