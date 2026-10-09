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
 * IDENTITY (M8A): optional Nostr identity beside the game connection
 * (`identity.ts`). The server only vouches "P2 holds
 * pubkey X"; names and pictures are looked up here, on a few relays, off
 * the frame loop, and only ever change labels: nothing from a relay touches
 * the match, the prediction or the interpolation.
 *
 * ROOMS (M8B): the page is in one room of the server: the open room, a
 * room from a share link (/play/A7F2), or a new one it asked for; Host /
 * Join switch rooms in place (a new connection, the same page). The
 * interface is `shell.ts`: quiet chips and a scoreboard while playing,
 * panels on demand, the banner when play is impossible; the text HUD is
 * F3 / F4 only.
 *
 * Keys: any of WASD / arrows, Shift, Space / Enter, F / K, G / L; F3 debug,
 * F4 network diagnostics. Dev query flags: `?server=ws://host:port`,
 * `?interp=0` (draw the newest state, as M7B did), `?predict=0`.
 */
import { canAct, type CombatState } from '../combat/combat';
import { Keyboard, PlayerInput, type KeyBindings, type MoveIntent } from '../control/input';
import { resolveServerUrl } from '../net/endpoint';
import { CONNECTION, initialConnection, onClose, onRetry, onWelcome, statusLine } from './connection';
import { createShell, type InviteMode } from './shell';
import { sendInvite, type InviteStatus } from './inviteSender';
import { InviteInbox } from './inviteInbox';
import { InboxSetup } from './inboxSetup';
import { PeopleFinder } from './people';
import { pageAddress, roomIntent, shareLink, socketUrl, type RoomIntent } from './room';
import { classifyServer, type ServerTrust } from '../net/serverTrust';
import type { RoomInfo, ServerInfo } from '../net/protocol';
import { inputMessage, isNewer, type ClientMessage, type Control, type ServerMessage, type StateMessage } from '../net/protocol';
import { ROSTER } from '../roster';
import { combatOf } from '../sim/read';
import type { FighterSnapshot, MatchSnapshot } from '../sim/snapshot';
import { COMBAT } from '../tuning';
import { NET_VIEW, SnapshotBuffer, type Sample } from './interp';
import { LocalPredictor, predictable, supported, type Body } from './predict';
import { RumblePresenter } from './presenter';
import { SimplePool } from 'nostr-tools/pool';
import { ProfileDirectory } from '../../social/directory';
import { BoundedPool } from '../../social/pool';
import { clip, displayName } from '../../social/profile';
import { LOOKUP_RELAYS, relayUrl } from '../../social/relays';
import { findNip07, nip07Signer } from '../../social/signer';
import type { SlotIdentity } from '../net/protocol';
import { IdentitySession } from './identity';

/** Storage that may be missing or throw (private windows, blocked site data). */
const safeStorage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};
const START_SEEN = 'rumble:start-seen';

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
const CONTROLS = ['F3 colliders & reach · F4 network numbers · H help', 'the next match starts by itself'];
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
  /** The server's WebSocket address (the room goes in its query); identity proofs name it. */
  const url = resolveServerUrl(location, location.search, { dev: import.meta.env.DEV, configured: import.meta.env.VITE_RUMBLE_SERVER as string | undefined });
  // Which room: from the page's address; after a create, the room it made.
  let target: RoomIntent = roomIntent(location);
  let room: RoomInfo | null = null;
  let serverInfo: ServerInfo | null = null;
  let trust: ServerTrust | null = null;
  let spectators = 0;
  let inviteStatus: InviteStatus | null = null;
  let inviteBusy = false;
  // M8C-B: the connected identity's invite inbox (decrypts after "Check invites", or by itself once the player enabled
  // automatic checking for this identity on this origin, M8C-B.2; restarted, emptied, on any identity change; untouched
  // by game reconnects and room switches, which keep the same signer).
  let inbox: InviteInbox | null = null;
  let inboxSigner: unknown = null;
  let inboxExpiredAt = 0;
  const sessionStore = (): Storage | null => {
    try {
      return window.sessionStorage;
    } catch {
      return null;
    }
  };
  let setup: InboxSetup | null = null;
  // M8C-C: whom to invite (follows, search, a selection) for the connected identity; it never sends anything itself.
  let people: PeopleFinder | null = null;
  const syncInbox = () => {
    const signer = identity.connectedSigner;
    if (signer === inboxSigner) return;
    inbox?.stop();
    setup?.stop();
    setup = null;
    people?.stop();
    inboxSigner = signer;
    const me = identity.state.pubkey;
    people =
      signer && me
        ? new PeopleFinder({
            me,
            lookup: (profiles(), relayPool!),
            directory: profiles(),
            lookupRelays: devRelays ?? LOOKUP_RELAYS,
            ...(devSearchRelays ? { searchRelays: devSearchRelays } : {}),
            // NIP-05 goes to the identifier's own domain over https; nothing else of the page goes with it.
            fetch: (url, init) => fetch(url, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer' }),
          })
        : null;
    inbox =
      signer && me
        ? new InviteInbox({
            signer,
            me,
            lookup: (profiles(), relayPool!),
            subscribePool: () => new SimplePool({ enablePing: false, enableReconnect: false }),
            lookupRelays: devRelays ?? LOOKUP_RELAYS,
            storage: sessionStore(),
            prefs: storage,
            onChange: () => {
              const pks = inbox?.state.invites.map((i) => i.from) ?? [];
              if (pks.length) profiles().ask(pks);
            },
            onLiveInvite: (i) => shell.toast(`${clip(displayName(profileOf(i.from), i.from), 20)} invited you to room ${i.room} (open the session panel)`, 6000),
            onPaused: () => shell.toast('Automatic invites paused: your extension did not allow decrypting (session panel → Invites)', 6000),
          })
        : null;
  };
  const inviteCards = () =>
    (inbox?.state.invites ?? []).map((invite) => ({
      invite,
      trust: classifyServer(`${invite.origin.replace(/^http/, 'ws')}/ws`, null),
      sameOrigin: invite.origin === location.origin,
    }));
  const inboxView = () => (inbox ? { state: inbox.state, cards: inviteCards(), setup: setup?.state ?? null, offer: inbox.offersAuto } : null);
  const inviteMode = (): InviteMode => (!identity.provenSigner ? 'guest' : identity.provenSigner.nip44 ? 'ready' : 'no-nip44');
  const useInterp = q.get('interp') !== '0';
  const usePredict = q.get('predict') !== '0';
  const keyboard = new Keyboard([NET_BINDINGS]);
  const input = new PlayerInput(keyboard, NET_BINDINGS);
  // Dev: ?delay=ms overrides the interpolation delay, to measure it.
  const delay = q.has('delay') ? Number(q.get('delay')) / 1000 : NET_VIEW.delay;
  const newBuffer = () => new SnapshotBuffer({ ...NET_VIEW, delay });
  let buffer = newBuffer();
  const predictor = new LocalPredictor();
  let ws: WebSocket | null = null;
  const targetRoom = (t: RoomIntent) => (t.kind === 'join' ? t.id : t.kind === 'invalid' ? t.raw : null);
  let conn = initialConnection(url, targetRoom(target));
  let connectingSince = 0;
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
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(m));
    return true;
  };

  // Identity: optional, separate from the game connection; relays only when there is a pubkey to look up.
  const storage = safeStorage();
  let roster: Record<string, SlotIdentity> | null = null;
  let relayPool: BoundedPool | null = null;
  let directory: ProfileDirectory | null = null;
  // Dev only: ?relays=ws://a,ws://b replaces the lookup relays (tests run a local relay).
  // Dev only: ?search-relays=ws://a,ws://b replaces the NIP-50 search relays (tests use local relays).
  const devSearchRelays = import.meta.env.DEV && q.get('search-relays') ? q.get('search-relays')!.split(',').map(relayUrl).filter((u): u is string => !!u).slice(0, 3) : null;
  // Dev only: ?inbox-suggest=wss://a,wss://b replaces the suggested inbox relays (tests use local relays).
  const devInboxSuggestions = import.meta.env.DEV && q.get('inbox-suggest') ? q.get('inbox-suggest')!.split(',').slice(0, 3) : null;
  const devRelays = import.meta.env.DEV && q.get('relays') ? q.get('relays')!.split(',').map(relayUrl).filter((u): u is string => !!u).slice(0, 3) : null;
  const profiles = () => {
    if (!directory) {
      relayPool = new BoundedPool(new SimplePool({ enablePing: false, enableReconnect: false }));
      directory = new ProfileDirectory(relayPool, { lookupRelays: devRelays ?? LOOKUP_RELAYS, storage, storageKey: 'rumble:profiles:v1' });
    }
    return directory;
  };
  const profileOf = (pubkey: string) => directory?.get(pubkey);
  const wantProfiles = () => {
    const pks = Object.values(roster ?? {}).flatMap((x) => (x.who === 'nostr' ? [x.pubkey] : []));
    if (identity.state.pubkey) pks.push(identity.state.pubkey);
    if (pks.length) profiles().ask(pks);
  };
  // The start card: once, on a first visit that lands in the open room (a share link goes straight in).
  let startSeen = target.kind !== 'open' || (() => {
    try {
      return storage?.getItem(START_SEEN) === '1';
    } catch {
      return false;
    }
  })();
  const seeStart = () => {
    startSeen = true;
    try {
      storage?.setItem(START_SEEN, '1');
    } catch {
      // Not remembered: shown again next visit.
    }
  };
  const identity = new IdentitySession({
    url,
    send,
    findSigner: async () => {
      const ext = await findNip07(window);
      return ext ? nip07Signer(ext) : null;
    },
    storage,
    onChange: () => wantProfiles(),
  });
  /** Go to another room in place: a new connection, the same page (and the same Nostr signer, which proves itself again). */
  const switchTo = (next: RoomIntent) => {
    target = next;
    inviteStatus = null;
    const old = ws;
    ws = null;
    old?.close(1000, 'switching room');
    you = null;
    roster = null;
    room = null;
    predictor.reset();
    keyboard.held.clear();
    identity.onClose();
    conn = initialConnection(url, targetRoom(next));
    if (next.kind === 'open') history.replaceState(null, '', pageAddress(null, location.search));
    connect();
  };
  /** M8C-A: a private Nostr invite to an npub / nprofile, from this page straight to the recipient's NIP-17 inbox (never via the game server). */
  const doSendInvite = (input: string) => {
    const signer = identity.provenSigner;
    const me = identity.verified;
    if (!signer || !me || !room || room.kind !== 'private' || inviteBusy) return;
    inviteBusy = true;
    const forRoom = room.id;
    void sendInvite(input, {
      signer,
      sender: me,
      lookup: (profiles(), relayPool!),
      publishPool: () => new SimplePool({ enablePing: false, enableReconnect: false }),
      lookupRelays: devRelays ?? LOOKUP_RELAYS,
      link: shareLink(room.id, location.origin, room.url),
      inviterName: clip(displayName(profileOf(me), me), 40),
      onStatus: (st) => {
        if (room?.id !== forRoom) return;
        inviteStatus = st;
        if ('pubkey' in st) profiles().ask([st.pubkey]);
      },
    }).finally(() => (inviteBusy = false));
  };
  const shell = createShell({
    retry: () => {
      if (conn.phase !== 'connecting' && conn.phase !== 'playing' && conn.phase !== 'watching') connect();
    },
    openRoom: () => switchTo({ kind: 'open' }),
    hostGame: () => switchTo({ kind: 'create' }),
    joinGame: (id) => switchTo({ kind: 'join', id }),
    connectNostr: () => {
      seeStart();
      void identity.connect();
    },
    disconnectNostr: () => identity.disconnect(),
    dismissIdentityError: () => identity.dismissError(),
    releaseKeys: () => keyboard.held.clear(),
    startSeen: seeStart,
    // M8C-A: a private Nostr invite to a pasted npub / nprofile.
    sendInvite: (input) => doSendInvite(input),
    // M8C-C: the chosen person, through the same sender; nothing is sent without this click.
    sendSelectedInvite: () => {
      const to = people?.recipient;
      if (to) doSendInvite(to);
    },
    setPeopleQuery: (text) => people?.setQuery(text),
    selectPerson: (pk) => people?.select(pk),
    clearPerson: () => people?.clearSelection(),
    morePeople: () => people?.showMore(),
    checkInvites: () => void inbox?.check(),
    // M8C-B.2: the automatic-checking consent, one preference per identity and origin; nothing is decrypted before "Enable".
    enableAutoInvites: () => inbox?.enableAuto(),
    declineAutoInvites: () => inbox?.declineAuto(),
    disableAutoInvites: () => inbox?.disableAuto(),
    // M8C-B.1: only for this identity, only when it has no kind-10050 list, only on clicks.
    openInboxSetup: () => {
      const signer = identity.connectedSigner;
      const me = identity.state.pubkey;
      if (!signer || !me || !inbox || inbox.state.phase !== 'no-inbox' || setup) return;
      const s = new InboxSetup({
        signer,
        me,
        lookup: (profiles(), relayPool!),
        pools: () => new SimplePool({ enablePing: false, enableReconnect: false }),
        lookupRelays: devRelays ?? LOOKUP_RELAYS,
        ...(devInboxSuggestions ? { suggestions: devInboxSuggestions } : {}),
        onInbox: (list) => {
          if (setup !== s) return;
          inbox?.adopt(list);
          const st = s.state;
          shell.toast(st.phase === 'exists' ? 'You already had private-message relays: Rumble uses them' : st.phase === 'partial' ? `Private invites set up (${st.inboxOk.length} of ${st.inboxOk.length + st.inboxFailed.length} inbox relays accepted)` : 'Private invites are set up', 6000);
          setup = null;
        },
      });
      setup = s;
      void s.open();
    },
    toggleInboxRelay: (url) => setup?.toggle(url),
    confirmInboxSetup: () => void setup?.confirm(),
    closeInboxSetup: () => {
      setup?.stop();
      setup = null;
    },
    dismissInvite: (id) => inbox?.dismiss(id),
    // Join only on a click, only to the validated destination: this server's room in place, or that server's page.
    joinInvite: (id) => {
      const i = inbox?.state.invites.find((x) => x.id === id);
      if (!i) return;
      inbox!.dismiss(id);
      if (i.origin === location.origin) switchTo({ kind: 'join', id: i.room });
      else location.assign(i.url);
    },
  });
  // Idle relays close; nothing stays open for long.
  setInterval(() => relayPool?.sweep(), 10_000);
  /** What a slot is called: a proven person's name, or null (its slot label). */
  const nameFor = (slot: string): string | null => {
    const r = roster?.[slot];
    return r?.who === 'nostr' ? displayName(profileOf(r.pubkey), r.pubkey) : null;
  };
  const sendInput = (move: Pick<MoveIntent, 'x' | 'z' | 'run'>) => {
    seq += 1;
    send(inputMessage(seq, move, actions));
    actions.jump = actions.punch = actions.grab = false;
    sentMove = JSON.stringify(move);
    sentAt = performance.now();
  };

  const connect = () => {
    if (target.kind === 'invalid') {
      // A share link with a malformed code: nothing to connect to; the banner offers the open room or a new game.
      conn = { ...initialConnection(url, target.raw || '?'), phase: 'missing' };
      return;
    }
    status = `connecting to ${url}`;
    conn = onRetry(conn);
    connectingSince = performance.now() / 1000;
    you = null;
    newest = null;
    seq = 0;
    predictor.reset();
    let socket: WebSocket;
    try {
      socket = new WebSocket(socketUrl(url, target));
    } catch {
      // A malformed address: treated as an unreachable server (the retry shows it).
      conn = onClose(conn, 1006, '', performance.now() / 1000);
      return;
    }
    ws = socket;
    socket.onmessage = (e) => {
      if (ws !== socket) return;
      const text = String(e.data);
      stats.bytes += text.length;
      const now = performance.now() / 1000;
      let m: ServerMessage;
      try {
        m = JSON.parse(text) as ServerMessage;
      } catch {
        return;
      }
      if (m.t === 'welcome') {
        you = m.you;
        players = m.players;
        tickHz = m.tickHz;
        predictor.reset();
        // A new connection: a new view of the match (the server may even have restarted, ticks from zero).
        buffer = newBuffer();
        stats.lastArrival = now;
        conn = onWelcome(conn, m.you, now);
        status = `connected · ${m.tickHz} Hz match, ${m.snapshotHz} Hz state`;
        roster = null;
        // The room (an older server has one match: the open room).
        const created = target.kind === 'create';
        room = m.room ?? { id: 'OPEN', kind: 'open', mode: 'casual' };
        serverInfo = m.server ?? null;
        trust = classifyServer(url, serverInfo);
        if (serverInfo?.operator) profiles().ask([serverInfo.operator]);
        // From now on (reconnects, reloads) this page means this room, not "a new one".
        target = room.kind === 'private' ? { kind: 'join', id: room.id } : { kind: 'open' };
        conn = { ...conn, room: room.kind === 'private' ? room.id : null };
        history.replaceState(null, '', pageAddress(room.kind === 'private' ? room.id : null, location.search));
        if (created) {
          shell.toast(`Room ${room.id} is ready: share the link or the code`, 6000);
          shell.openSession();
        } else if (room.kind === 'private' && !conn.note) shell.toast(`Joined room ${room.id}`);
        identity.onWelcome(m.features);
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
      } else if (m.t === 'roster') {
        // Who came and went (not you), briefly.
        if (roster)
          for (const [slot, now] of Object.entries(m.slots)) {
            const before = roster[slot];
            if (slot === you || !before) continue;
            if (before.who === 'bot' && now.who !== 'bot') shell.toast(`${now.who === 'nostr' ? clip(displayName(profileOf(now.pubkey), now.pubkey), 20) : 'A guest'} joined as ${slot}`);
            else if (before.who !== 'bot' && now.who === 'bot') shell.toast(`${slot} left (a bot plays it)`);
          }
        roster = m.slots;
        spectators = m.spectators ?? 0;
        wantProfiles();
      } else if (m.t === 'challenge') {
        void identity.onChallenge(m.challenge);
      } else if (m.t === 'auth') {
        identity.onAuth(m);
      }
    };
    socket.onclose = (e) => {
      if (ws !== socket) return;
      ws = null;
      // Offline: nothing is predicted from a state that will not be answered, nothing is sent, nothing held.
      conn = onClose(conn, e.code, e.reason, performance.now() / 1000);
      status = conn.phase;
      you = null;
      predictor.reset();
      keyboard.held.clear();
      reconnects += conn.phase === 'lost' ? 1 : 0;
      roster = null;
      identity.onClose();
    };
  };
  let reconnects = 0;
  /** Once a frame: retry when it is time, give up on a connection attempt that hangs, and notice a server gone silent. */
  const watchConnection = (now: number) => {
    if ((conn.phase === 'lost' || conn.phase === 'failed' || conn.phase === 'full') && now >= conn.retryAt) connect();
    else if (conn.phase === 'connecting' && ws && ws.readyState === WebSocket.CONNECTING && now - connectingSince > CONNECTION.silence * 2) ws.close();
    else if ((conn.phase === 'playing' || conn.phase === 'watching') && ws && now - stats.lastArrival > CONNECTION.silence) ws.close(4000, 'no data');
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
    watchConnection(now);
    syncInbox();
    // The follow list is read the first time the invite section is on screen, not before.
    if (people && shell.panelOpen && room?.kind === 'private' && identity.provenSigner) people.ensureFollows();
    if (inbox && nowMs - inboxExpiredAt > 1000) {
      inboxExpiredAt = nowMs;
      inbox.expire();
    }
    shell.show({
      conn,
      now,
      room,
      share: room && room.kind === 'private' ? shareLink(room.id, location.origin, room.url) : null,
      trust,
      server: serverInfo,
      identity: identity.state,
      profile: (pk) => profileOf(pk),
      roster,
      spectators,
      you,
      snapshot: buffer.newest ?? null,
      message: presenter?.currentMessage ?? '',
      nameOf: nameFor,
      startCard: !startSeen && room?.kind === 'open',
      invite: { mode: inviteMode(), status: inviteStatus, busy: inviteBusy },
      people: people && room?.kind === 'private' ? people.state : null,
      inbox: inboxView(),
    });
    if (you && conn.phase === 'playing' && (JSON.stringify(move) !== sentMove || actions.jump || actions.punch || actions.grab || nowMs - sentAt > KEEPALIVE_MS)) sendInput(move);
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
      // Before the first state: the developer view only (the shell shows the connection).
      hud.style.display = showNet ? '' : 'none';
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
    // Name tags: a proven person's name (short), else the slot label. Redrawn only when the text changes.
    for (const id of s.players) {
      const n = nameFor(id);
      presenter.setTag(id, n === null ? null : clip(n, 14));
    }
    const ack = you ? state.acks[you] : undefined;
    const m = predictor.metrics;
    presenter.present(
      s,
      dt,
      {
        status: [`NETWORK · ${statusLine(conn, rtt)}`, ''],
        driver: (i) => {
          const n = nameFor(s.players[i]);
          const who = n === null ? (control[s.players[i]] === 'human' ? 'human' : 'bot') : clip(n, 16);
          return s.players[i] === you ? `YOU · ${who}` : who;
        },
        matchOverHint: 'the next match starts soon',
        // The text HUD is a developer view now: F4 (or F3).
        textHud: showNet,
        controls: CONTROLS,
        strugglers: meIndex >= 0 ? [{ index: meIndex, keys: '← ↔ → (A ↔ D)' }] : [],
        footer: showNet
          ? [
              `NET  ${status} · ${url} · ${conn.attempts ? `attempt ${conn.attempts}` : 'up'} · reconnects ${reconnects} · rtt ${Number.isNaN(rtt) ? '…' : `${rtt.toFixed(0)} ms`} · ${stats.statesPerSec.toFixed(1)} states/s · ${(stats.bytesPerSec / 1024).toFixed(1)} KB/s`,
              `     view ${useInterp ? `interpolated, ${(delay * 1000).toFixed(0)} ms behind` : 'newest state (no interpolation)'} · states ahead ${sample?.ahead ?? '-'} (mean ${aheadW.mean.toFixed(1)})${sample?.extrapolated ? ` · EXTRAPOLATING ${(sample.late * 1000).toFixed(0)} ms` : ''}`,
              `     state gaps ${gaps.mean.toFixed(0)} ± ${gaps.sd.toFixed(0)} ms (max ${gaps.max.toFixed(0)}) · extrapolated ${stats.extrapolatedFrames} / frozen ${stats.frozenFrames} of ${stats.frames} frames · tick ${state.tick}`,
              `ROOM  ${room ? `${room.id} (${room.kind}, ${room.mode})` : '-'} · ${trust ? `${trust.label} ${trust.host}` : '-'}${serverInfo?.name ? ` · "${serverInfo.name}"` : ''}${serverInfo?.operator ? ` · operator ${serverInfo.operator.slice(0, 8)}… (claimed)` : ''} · ${spectators} watching`,
              `NOSTR ${identity.state.phase}${identity.verified ? ` ${identity.verified.slice(0, 8)}…` : ''} · server ${identity.state.serverSupports === null ? '?' : identity.state.serverSupports ? 'offers identity' : 'no identity'} · relays ${relayPool ? `${relayPool.openRelays.length} open (peak ${relayPool.peak}/${relayPool.maxOpen}), ${relayPool.queries} queries` : 'none opened'} · roster ${Object.entries(roster ?? {}).map(([k, v]) => `${k}:${v.who}`).join(' ') || '-'}`,
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
      get connection() {
        return conn;
      },
      /** The connection's socket, for scripted checks of a lost connection. */
      dropConnection() {
        ws?.close(4001, 'test');
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
      /** Rooms, for scripted checks. */
      get room() {
        return room;
      },
      get trust() {
        return trust;
      },
      get server() {
        return serverInfo;
      },
      host: () => switchTo({ kind: 'create' }),
      join: (id: string) => switchTo({ kind: 'join', id }),
      openRoom: () => switchTo({ kind: 'open' }),
      shell,
      /** M8C-B invites, for scripted checks (valid invites only; nothing else is held). */
      get inbox() {
        return inboxView();
      },
      checkInvites: () => inbox?.check(),
      /** M8C-C whom to invite, for scripted checks. */
      people: {
        get state() {
          return people?.state ?? null;
        },
        get recipient() {
          return people?.recipient ?? null;
        },
        setQuery: (t: string) => people?.setQuery(t),
        select: (pk: string) => people?.select(pk),
        clear: () => people?.clearSelection(),
        more: () => people?.showMore(),
        loadFollows: () => people?.ensureFollows(),
      },
      /** M8C-B.2 automatic checking, for scripted checks (the same consent as the panel's buttons). */
      autoInvites: { enable: () => inbox?.enableAuto(), decline: () => inbox?.declineAuto(), disable: () => inbox?.disableAuto() },
      /** Identity, for scripted checks. */
      identity: {
        get state() {
          return identity.state;
        },
        get roster() {
          return roster;
        },
        profile: (pk: string) => profileOf(pk),
        get relays() {
          return relayPool ? { open: relayPool.openRelays, peak: relayPool.peak, max: relayPool.maxOpen, queries: relayPool.queries } : null;
        },
        connect: () => identity.connect(),
        disconnect: () => identity.disconnect(),
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
