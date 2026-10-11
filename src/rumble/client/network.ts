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
import { Keyboard, NET_BINDINGS, PlayerInput, type MoveIntent } from '../control/input';
import { addCommunityServer, chooseServer, loadChosenServer, loadCommunityServers, officialServers, ownServers, removeCommunityServer, saveChosenServer, saveCommunityServers, type GameServer } from './servers';
import { PROTOCOL, type RoomListing } from '../net/protocol';
import { onProtocol } from './connection';
import { CONNECTION, initialConnection, onClose, onRetry, onSeat, onWelcome, statusLine } from './connection';
import { lifecyclePlays, lobbyLine, refusalWords } from './lobby';
import { isTyping } from './dom';
import { createShell, type InviteMode } from './shell';
import { sendInvite, type InviteStatus } from './inviteSender';
import { InviteInbox } from './inviteInbox';
import { InboxSetup } from './inboxSetup';
import { PeopleFinder } from './people';
import { BlobbiPicker } from './blobbis';
import { blobbiPreview } from './blobbiPreview';
import { declarationOf, lookFromSlotForm, planLooks, rumbleFormOf, type RumbleForm, type Wanted } from './rumbleForm';
import { pageAddress, roomIntent, shareLink, socketUrl, type RoomIntent } from './room';
import { classifyServer, type ServerTrust } from '../net/serverTrust';
import type { RoomInfo, ServerInfo } from '../net/protocol';
import { inputMessage, isNewer, type ClientMessage, type Control, type LobbyMessage, type ServerMessage, type StateMessage } from '../net/protocol';
import { moveAim, wantsThrow } from '../control/aim';
import { ROSTER } from '../roster';
import { combatOf } from '../sim/read';
import type { FighterSnapshot, MatchSnapshot } from '../sim/snapshot';
import { COMBAT } from '../tuning';
import { NET_VIEW, SnapshotBuffer, type Sample } from './interp';
import { LocalPredictor, predictable, supported, type Body } from './predict';
import { attachCarried } from './carryView';
import { carrierIntent } from '../control/mover';
import { RumblePresenter } from './presenter';
import { SimplePool } from 'nostr-tools/pool';
import { ProfileDirectory } from '../../social/directory';
import { BoundedPool } from '../../social/pool';
import { clip, displayName } from '../../social/profile';
import { LOOKUP_RELAYS, relayUrl } from '../../social/relays';
import { findNip07, nip07From, nip07Signer } from '../../social/signer';
import type { SlotIdentity } from '../net/protocol';
import { IdentitySession } from './identity';
import { TouchControls, needsRotate, prefersTouch, watchFirstTouch } from './touchControls';
import { touchContext } from '../control/touch';
import { parseQuality, type DeviceHints, type QualityChoice } from '../view/quality';
import { BANANAS } from '../tuning';
import { graphicsFailure, graphicsOptions, perfOverlayAsked, probeWebGL, type GraphicsFailure } from './graphics';
import { showGraphicsError } from './graphicsScreen';

/** Storage that may be missing or throw (private windows, blocked site data). */
const safeStorage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};
const START_SEEN = 'rumble:start-seen';
/** M12: no signer on a touch device. Rumble never asks for a private key, so it only works with a signer the browser provides. */
const MOBILE_NO_SIGNER = 'This browser has no Nostr signer (NIP-07). On a phone that takes a browser with a signer extension, or a Nostr app’s built-in browser. Rumble never asks for your private key. You can keep playing as a guest.';
/** How many times this page started the network client (diagnostics: more than once means a duplicate initialisation). */
let startups = 0;

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
  // Graphics first: a page that cannot draw never connects, so it never takes a fighter from the match.
  const gfx = graphicsOptions(location.search, { dev: import.meta.env.DEV, hostname: location.hostname });
  // Read now: the page tidies its own address later (the room goes into it), dropping other parameters.
  const perfAsked = perfOverlayAsked(location.search);
  const probe = probeWebGL(() => document.createElement('canvas'), { forceWebGL1: gfx.forceWebGL1, simulateNone: gfx.simulateNone });
  if (probe.version === null) {
    showGraphicsError(graphicsFailure(probe), { online: true });
    return;
  }
  const q = new URLSearchParams(location.search);
  /** The server's WebSocket address (the room goes in its query); identity proofs name it. */
  // M10A: which game server. Built-in official servers (none unless configured), this page's own (or the dev server),
  // the player's community servers (localStorage), and this page's ?server= for a link; never a server from untrusted metadata.
  const rules = { secure: location.protocol === 'https:', dev: import.meta.env.DEV };
  const prefs = safeStorage();
  let community: GameServer[] = loadCommunityServers(prefs, rules);
  const knownServers = (): GameServer[] => [...officialServers({ VITE_RUMBLE_SERVERS: import.meta.env.VITE_RUMBLE_SERVERS as string | undefined, VITE_RUMBLE_SERVER: import.meta.env.VITE_RUMBLE_SERVER as string | undefined }, rules), ...ownServers(location, import.meta.env.DEV), ...community];
  const picked = chooseServer(knownServers(), loadChosenServer(prefs), location.search, rules);
  const server: GameServer = picked.server;
  const url = server.url;
  /** M10B: the server's public rooms, as last listed, and when. */
  let rooms: RoomListing[] | null = null;
  let roomsAskedAt = 0;
  let roomsSupported = false;
  const askRooms = (force = false) => {
    const nowMs = performance.now();
    if (!ws || conn.phase === 'connecting' || !roomsSupported) return;
    if (!force && nowMs - roomsAskedAt < 10_000) return;
    if (nowMs - roomsAskedAt < PROTOCOL.roomsEveryMs) return;
    roomsAskedAt = nowMs;
    send({ t: 'rooms' });
  };
  /** M10A: go to another server: this page reloads at that server's open room (one socket at a time, nothing carried over by accident). */
  const useServer = (id: string) => {
    const s = knownServers().find((x) => x.id === id);
    if (!s) return;
    saveChosenServer(prefs, s.source === 'community' || s.source === 'official' ? s.id : null);
    const q = new URLSearchParams(location.search);
    q.delete('room');
    q.delete('create');
    q.delete('public');
    q.set('network', '1');
    // The chosen server is remembered; a built-in or own server needs no ?server= in the address.
    if (s.source === 'community' || s.source === 'link') q.set('server', s.url);
    else q.delete('server');
    location.assign(`/rumble.html?${q.toString()}`);
  };
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
  // M9A: the connected identity's Blobbis (read only) and a local choice among them; nothing published.
  let blobbis: BlobbiPicker | null = null;
  // M9B / M9C: what every fighter wears. The player's own form is declared to the server once proven; the server binds it to
  // the proven pubkey and the roster carries every slot's form, so every page (players and spectators) draws the same looks.
  // On a server without looks, only this page wears its own form.
  const worn = new Map<string, string>();
  let lookNote: 'worn' | 'default' | 'refused' = 'default';
  /** The form the server last accepted from this page (by its declaration), to send a change once, not per frame. */
  let declared: string | null = null;
  let declaredOn: string | null = null;
  const currentForm = (): RumbleForm | null => {
    const me = identity.verified;
    const chosen = blobbis?.chosen ?? null;
    return me && chosen ? rumbleFormOf(chosen, me) : null;
  };
  const serverLooks = () => !!serverFeatures?.includes('looks');
  /** Tell the server which form this fighter wears, when that changed or the connection is new. Only once proven; nothing else rides along. */
  const declareLook = () => {
    const me = identity.verified;
    if (!ws || !me || !serverLooks() || conn.phase !== 'playing') return;
    const form = currentForm();
    const text = JSON.stringify(form ? declarationOf(form) : null);
    const on = `${me}:${room?.id ?? ''}`;
    if (text === declared && on === declaredOn) return;
    if (send({ t: 'look', form: form ? declarationOf(form) : null })) {
      declared = text;
      declaredOn = on;
    }
  };
  /** Every slot's look from the roster (the server's word), or, without server looks, this page's own form on its slot. */
  const syncLooks = () => {
    if (!presenter) return;
    const want = new Map<string, Wanted>();
    if (serverLooks()) {
      for (const [slot, id] of Object.entries(roster ?? {})) {
        if (id.who !== 'nostr' || !id.form) continue;
        const r = lookFromSlotForm(id.form);
        if (r) want.set(slot, { key: r.key, look: r.look });
      }
    } else {
      const form = currentForm();
      if (you && form) want.set(you, { key: form.key, look: form.look });
    }
    const plan = planLooks(worn, want);
    worn.clear();
    for (const [k, v] of plan.next) worn.set(k, v);
    for (const c of plan.changes) {
      const r = presenter.setLook(c.slot, c.look, c.key);
      if (c.slot !== you) continue;
      if (c.look) {
        if (r === 'default') {
          // The kit could not build it: the default stays, and the record must not say the form is worn.
          worn.delete(c.slot);
          lookNote = 'refused';
        } else lookNote = 'worn';
      } else lookNote = 'default';
    }
    if (you && !want.has(you) && !currentForm()) lookNote = 'default';
  };
  const syncInbox = () => {
    const signer = identity.connectedSigner;
    if (signer === inboxSigner) return;
    inbox?.stop();
    setup?.stop();
    setup = null;
    people?.stop();
    blobbis?.stop();
    inboxSigner = signer;
    const me = identity.state.pubkey;
    blobbis =
      signer && me
        ? new BlobbiPicker({
            me,
            lookup: (profiles(), relayPool!),
            ...(devBlobbiRelays ? { relays: devBlobbiRelays } : {}),
            storage,
            preview: blobbiPreview,
          })
        : null;
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
  // M12: touch controls, for a finger as the main pointer (or ?touch=1), or from the first touch on the page.
  let touchOn = prefersTouch(location.search, matchMedia('(pointer: coarse)').matches);
  let touchControls: TouchControls | null = null;
  let rotateDismissed = false;
  const ensureTouch = () => {
    if (!touchOn || touchControls) return;
    touchControls = new TouchControls(undefined, () => presenter?.recenterView());
    input.touch = touchControls.pad;
    shell.setTouch(true);
    presenter?.setTouchLayout(true);
  };
  watchFirstTouch(location.search, () => {
    touchOn = true;
    ensureTouch();
  });
  // M12: graphics quality, remembered on this device; auto unless chosen.
  const QUALITY_KEY = 'rumble:graphics';
  let quality: QualityChoice = parseQuality((() => {
    try {
      return safeStorage()?.getItem(QUALITY_KEY);
    } catch {
      return null;
    }
  })());
  // M12.1: the FPS counter, remembered on this device (off unless chosen).
  const FPS_KEY = 'rumble:fps';
  let showFps = (() => {
    try {
      return safeStorage()?.getItem(FPS_KEY) === '1';
    } catch {
      return false;
    }
  })();
  const deviceHints = (): DeviceHints => {
    const nav = navigator as Navigator & { deviceMemory?: number };
    return { coarse: matchMedia('(pointer: coarse)').matches, cores: nav.hardwareConcurrency || undefined, memory: nav.deviceMemory };
  };
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
  /** L1: a lobby room's lifecycle as the server last said it (null: a continuous room). */
  let lobby: LobbyMessage | null = null;
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
  /** What the current server offers (from its welcome). */
  let serverFeatures: readonly string[] | null = null;
  let relayPool: BoundedPool | null = null;
  let directory: ProfileDirectory | null = null;
  // Dev only: ?relays=ws://a,ws://b replaces the lookup relays (tests run a local relay).
  // Dev only: ?blobbi-relays=ws://a,ws://b replaces the Blobbi state relays (tests use local relays).
  const devBlobbiRelays = import.meta.env.DEV && q.get('blobbi-relays') ? q.get('blobbi-relays')!.split(',').map(relayUrl).filter((u): u is string => !!u).slice(0, 3) : null;
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
  // Development-only diagnostics of the Nostr connection lifecycle (dev builds; `?nostr-diag=1` too): stages and timings,
  // never a key, a signature, a challenge or a message. Shown in the session panel with a Copy button, and on the console.
  const diagOn = import.meta.env.DEV || q.get('nostr-diag') === '1';
  const diagLines: string[] = [];
  const pageT0 = performance.now();
  const diag = (stage: string, detail?: string) => {
    if (!diagOn) return;
    const line = `${(performance.now() - pageT0).toFixed(0).padStart(6)} ms  ${stage}${detail ? `  ${detail}` : ''}`;
    diagLines.push(line);
    if (diagLines.length > 80) diagLines.shift();
    console.info(`[rumble:nostr] ${line}`);
  };
  diag('page', `startNetwork #${++startups}${startups > 1 ? ' (DUPLICATE start-up in this page)' : ''}; document ${document.readyState}; window.nostr ${nip07From(window) ? 'PRESENT' : 'absent'} at start`);
  window.addEventListener('load', () => diag('page', `window load; window.nostr ${nip07From(window) ? 'present' : 'absent'}`), { once: true });
  let findCalls = 0;
  const identity = new IdentitySession({
    url,
    send,
    // M12: a phone rarely has a NIP-07 signer; say so plainly, and that the game needs none.
    ...(matchMedia('(pointer: coarse)').matches ? { unavailable: MOBILE_NO_SIGNER } : {}),
    findSigner: async () => {
      const n = ++findCalls;
      const t0 = performance.now();
      const before = nip07From(window);
      const ext = await findNip07(window);
      diag('provider', `findSigner #${n}: window.nostr ${before ? 'already there' : ext ? `appeared after ${(performance.now() - t0).toFixed(0)} ms` : `absent for the whole ${(performance.now() - t0).toFixed(0)} ms detection window`}`);
      if (!ext && diagOn) {
        // Keep watching (diagnostics only): if a provider turns up later, the detection window, not the extension, is the limit.
        const watchT0 = performance.now();
        const watch = setInterval(() => {
          const late = nip07From(window);
          if (late) diag('provider', `window.nostr appeared LATE, ${(performance.now() - watchT0).toFixed(0)} ms after the window closed (getPublicKey ${typeof late.getPublicKey}, nip44 ${late.nip44 ? 'yes' : 'no'})`);
          if (late || performance.now() - watchT0 > 20_000) clearInterval(watch);
        }, 100);
      }
      return ext ? nip07Signer(ext) : null;
    },
    storage,
    onChange: () => wantProfiles(),
    diag,
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
      link: shareLink(room.id, location.origin, room.url, url),
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
    hostGame: (listed, arena, rotate) => switchTo({ kind: 'create', listed, ...(arena ? { arena } : {}), rotate }),
    // M10A / M10B: servers and public rooms.
    useServer,
    addServer: (input) => {
      const r = addCommunityServer(community, input, rules);
      if ('error' in r) return r.error;
      community = r.servers;
      saveCommunityServers(prefs, community);
      return null;
    },
    removeServer: (id) => {
      community = removeCommunityServer(community, id);
      saveCommunityServers(prefs, community);
      if (loadChosenServer(prefs) === id) saveChosenServer(prefs, null);
    },
    refreshRooms: () => askRooms(true),
    joinGame: (id) => switchTo({ kind: 'join', id }),
    connectNostr: () => {
      seeStart();
      void identity.connect();
    },
    disconnectNostr: () => identity.disconnect(),
    dismissIdentityError: () => identity.dismissError(),
    // M9B.1: the extension holds another identity than the remembered one: only a click connects it.
    connectOtherNostr: () => identity.connectOther(),
    dismissOtherNostr: () => identity.dismissChanged(),
    releaseKeys: () => input.release(),
    setQuality: (choice) => {
      quality = choice;
      try {
        safeStorage()?.setItem(QUALITY_KEY, choice);
      } catch {
        // Not remembered: this visit only.
      }
      presenter?.setQuality(choice, deviceHints());
    },
    dismissRotate: () => {
      rotateDismissed = true;
    },
    setFps: (on) => {
      showFps = on;
      try {
        safeStorage()?.setItem(FPS_KEY, on ? '1' : '0');
      } catch {
        // Not remembered: this visit only.
      }
    },
    recenterCamera: () => presenter?.recenterView(),
    startSeen: seeStart,
    // M8C-A: a private Nostr invite to a pasted npub / nprofile.
    sendInvite: (input) => doSendInvite(input),
    // M8C-C: the chosen person, through the same sender; nothing is sent without this click.
    sendSelectedInvite: () => {
      const to = people?.recipient;
      if (to) doSendInvite(to);
    },
    setPeopleQuery: (text) => people?.setQuery(text),
    // M9A: a local choice only; no event is published and nothing in play changes yet.
    selectBlobbi: (d) => blobbis?.select(d),
    defaultBlobbi: () => blobbis?.useDefault(),
    reloadBlobbis: () => blobbis?.load(true),
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
  ensureTouch();
  // Idle relays close; nothing stays open for long.
  setInterval(() => relayPool?.sweep(), 10_000);
  // M9B.1: a remembered, explicit connection is restored by itself (the same signer, the same pubkey, or nothing); once per page.
  void identity.restore();
  /** What a slot is called: a proven person's name, or null (its slot label). */
  const nameFor = (slot: string): string | null => {
    const r = roster?.[slot];
    return r?.who === 'nostr' ? displayName(profileOf(r.pubkey), r.pubkey) : null;
  };
  /** M9D: the Blobbi a slot's fighter wears, by name (the owner's declaration, text only), or null. */
  const blobbiNameFor = (slot: string): string | null => {
    const r = roster?.[slot];
    if (r?.who !== 'nostr' || !r.form) return null;
    return lookFromSlotForm(r.form)?.name ?? null;
  };
  const sendInput = (move: Pick<MoveIntent, 'x' | 'z' | 'run'>) => {
    seq += 1;
    send(inputMessage(seq, move, actions));
    actions.jump = actions.punch = actions.grab = false;
    sentMove = JSON.stringify(move);
    sentAt = performance.now();
  };

  /**
   * The graphics failed after the page joined (the engine would not start, or the context was lost for good): give the
   * fighter back at once (close the socket: the server hands the slot to its bot), never reconnect, stop drawing, and
   * explain. Once per page.
   */
  let graphicsDown = false;
  const failGraphics = (f: GraphicsFailure) => {
    if (graphicsDown) return;
    graphicsDown = true;
    const socket = ws;
    ws = null;
    socket?.close(1000, 'graphics failed');
    try {
      presenter?.dispose();
    } catch {
      // Already gone with the context.
    }
    presenter = null;
    showGraphicsError(f, { online: true });
  };
  const connect = () => {
    if (graphicsDown) return;
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
        lobby = null;
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
        serverFeatures = m.features ?? [];
        declared = null;
        declaredOn = null;
        // M10A: a server speaking a newer protocol than this build is not played with (no pretending, no retry loop).
        conn = onProtocol(conn, m.protocol, PROTOCOL.version);
        if (conn.phase === 'incompatible') {
          socket.close(1000, 'incompatible');
          return;
        }
        roomsSupported = serverFeatures.includes('rooms-list');
        rooms = null;
        roomsAskedAt = 0;
        identity.onWelcome(m.features);
      } else if (m.t === 'state') {
        // Late or repeated states are dropped: the newest tick wins.
        if (!isNewer(m.tick, newest)) {
          stats.stale += 1;
          return;
        }
        newest = m.tick;
        // L2: a new lineup (a lobby room's match without bots): a new view of the match, nothing interpolated across it.
        if (buffer.newest && buffer.newest.players.join() !== m.snapshot.players.join()) {
          buffer = newBuffer();
          predictor.reset();
          players = m.snapshot.players;
        }
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
          const allowed = usePredict && predictable(f, m.snapshot.phase === 'playing') && lifecyclePlays(lobby);
          const r = predictor.reconcile(f, m.tick, 1 / tickHz, m.acks[you!] ?? -1, m.ackTicks?.[you!] ?? m.tick, allowed);
          if (r.kind === 'kept' || r.kind === 'smoothed' || r.kind === 'snapped') errors.add(r.error);
        }
      } else if (m.t === 'lobby') {
        // L1: the room's stage, and this connection's seat in it (which changes only between matches).
        lobby = m;
        if (m.you !== you) {
          you = m.you;
          conn = onSeat(conn, you);
          predictor.reset();
          keyboard.held.clear();
        }
      } else if (m.t === 'refused') {
        // L2: a lobby request the server would not do.
        shell.toast(refusalWords(m.of, m.reason));
      } else if (m.t === 'pong') {
        rtt = performance.now() - m.ct;
      } else if (m.t === 'rooms') {
        rooms = Array.isArray(m.rooms) ? m.rooms.slice(0, PROTOCOL.maxListedRooms) : [];
      } else if (m.t === 'roster') {
        // Who came and went (not you), briefly.
        if (roster)
          for (const [slot, now] of Object.entries(m.slots)) {
            const before = roster[slot];
            if (slot === you || !before) continue;
            const nobody = (w: string) => w === 'bot' || w === 'empty';
            if (nobody(before.who) && !nobody(now.who)) shell.toast(`${now.who === 'nostr' ? clip(displayName(profileOf(now.pubkey), now.pubkey), 20) : 'A guest'} joined as ${slot}`);
            else if (!nobody(before.who) && nobody(now.who)) shell.toast(now.who === 'bot' ? `${slot} left (a bot plays it)` : `${slot} left`);
          }
        roster = m.slots;
        spectators = m.spectators ?? 0;
        wantProfiles();
        syncLooks();
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
    input.release();
    sendInput({ x: 0, z: 0, run: false });
  };
  window.addEventListener('blur', release);
  document.addEventListener('visibilitychange', () => document.hidden && release());
  window.addEventListener('keydown', (e) => {
    if (e.code === 'F4') {
      showNet = !showNet;
      e.preventDefault();
    }
    // L2: until the lobby's interface (L3), R says this seated person is (not) ready.
    if (e.code === 'KeyR' && !e.repeat && !isTyping(e) && lobby && you && (lobby.phase === 'lobby' || lobby.phase === 'countdown')) send({ t: 'ready', ready: !lobby.ready.includes(you) });
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

  /** M11F: where this player, out of the round, aims the next banana peel (null: not aiming). */
  let aim: { x: number; z: number } | null = null;
  const frame = (dt: number) => {
    const nowMs = performance.now();
    const now = nowMs / 1000;
    stats.frames += 1;
    // Input: this frame's movement, and any press since the last frame, kept until it is sent.
    const yaw = presenter?.cameraYaw() ?? 0;
    const intent = input.read(yaw);
    const latestSnap = buffer.newest;
    const meIndex = you && latestSnap ? latestSnap.players.indexOf(you) : -1;
    const me = meIndex >= 0 ? latestSnap!.fighters[meIndex] : null;
    const out = !!me && me.eliminated && latestSnap!.phase === 'playing';
    if (out && presenter) {
      // Out of the round: the keys move the aim over the floor, a punch or grab throws; nothing goes to the fighter.
      if (!aim) aim = presenter.clampAim({ x: me!.position.x, z: me!.position.z });
      aim = moveAim(aim, intent, dt, (p) => presenter!.clampAim(p));
      if (wantsThrow(intent, me!.bananas)) send({ t: 'throw', x: +aim.x.toFixed(2), z: +aim.z.toFixed(2) });
    } else {
      aim = null;
      actions.jump ||= intent.jump;
      actions.punch ||= intent.punch;
      actions.grab ||= intent.grab;
    }
    // Hotfix: while carrying (the server's newest word), Shift or the stick's rim asks for no run: the sent intent, the prediction
    // and so the local animation all walk, as the server and everyone else see it; the run is back the moment the hold ends.
    const carrying = !!me?.holding;
    const move = out ? { x: 0, z: 0, run: false } : carrierIntent({ x: intent.x, z: intent.z, run: intent.run }, carrying);
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
    // The Blobbi list is read the first time the panel shows it for a verified identity, or at once when a choice was remembered (the fighter wears it).
    if (blobbis && identity.verified && (shell.panelOpen || blobbis.state.selected)) blobbis.load();
    declareLook();
    syncLooks();
    // M10B: the public rooms, while the panel is open (every 10 s at most; nothing per frame, nothing while closed).
    if (shell.panelOpen) askRooms();
    if (inbox && nowMs - inboxExpiredAt > 1000) {
      inboxExpiredAt = nowMs;
      inbox.expire();
    }
    shell.show({
      conn,
      now,
      room,
      share: room && room.kind === 'private' ? shareLink(room.id, location.origin, room.url, url) : null,
      servers: { current: server, known: knownServers(), linkError: picked.linkError ?? null, rooms, roomsSupported },
      trust,
      server: serverInfo,
      identity: identity.state,
      diag: diagOn ? diagLines : null,
      profile: (pk) => profileOf(pk),
      roster,
      spectators,
      you,
      snapshot: buffer.newest ?? null,
      message: lobbyLine(lobby, state?.tick ?? 0, tickHz, (id) => nameFor(id) ?? id) ?? presenter?.currentMessage ?? '',
      nameOf: nameFor,
      startCard: !startSeen && room?.kind === 'open',
      invite: { mode: inviteMode(), status: inviteStatus, busy: inviteBusy },
      people: people && room?.kind === 'private' ? people.state : null,
      blobbis: blobbis && identity.verified ? { state: blobbis.state, form: currentForm(), note: lookNote, shared: serverLooks() } : null,
      blobbiNameOf: blobbiNameFor,
      graphics: { choice: quality, info: () => presenter?.renderInfo ?? null },
      rotate: needsRotate({ width: window.innerWidth, height: window.innerHeight, touch: touchOn, dismissed: rotateDismissed }),
      fps: showFps,
      inbox: inboxView(),
    });
    // M12: the touch controls: shown while this page plays a fighter and nothing is over the arena; the buttons' words follow the moment.
    if (touchControls) {
      const alive = latestSnap ? latestSnap.fighters.filter((f) => f.alive).length : 0;
      // M12.1: a finger dragged across the arena turns the camera (the stick follows, being camera-relative).
      presenter?.turnView(touchControls.look.take());
      touchControls.update({
        rotated: !!presenter?.viewTurned,
        visible: conn.phase === 'playing' && !!you && !shell.modalOpen,
        context: touchContext(me, latestSnap?.phase ?? 'roundOver'),
        peel: me ? { left: me.bananas.left, cooldown: me.bananas.cooldown, allowed: alive >= BANANAS.minAlive } : undefined,
      });
    }
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
      const interpFighters = s.fighters;
      s = { ...s, fighters: s.fighters.map((f, i) => (i === meIndex ? own : f)) };
      // M12.1: what you carry is drawn in your hands (your fighter is drawn now, the rest a moment ago).
      if (predictor.predicting) s = { ...s, fighters: attachCarried(s.fighters, interpFighters, meIndex, latestSnap.fighters[meIndex].holding) };
    }
    s.fighters.forEach((f, i) => {
      (drawn[i] ??= []).push({ x: f.position.x, z: f.position.z, t: now });
      if (drawn[i].length > 240) drawn[i].shift();
    });
    // L2: the lineup changed (a lobby room's next match without bots): the fighters drawn follow; the new ones' looks are applied afresh.
    if (presenter && presenter.fighterIds.join() !== s.players.join()) {
      const had = new Set(presenter.fighterIds);
      presenter.setFighters(s.players.map((id) => ({ id, identity: ROSTER.find((e) => e.label === id)?.identity ?? id })));
      for (const id of s.players) if (!had.has(id)) worn.delete(id);
      syncLooks();
    }
    if (!presenter) {
      try {
        presenter = new RumblePresenter(canvas, hud, s.players.map((id) => ({ id, identity: ROSTER.find((e) => e.label === id)?.identity ?? id })), s.orbs, s.arena, { forceWebGL1: gfx.forceWebGL1, simulateFailure: gfx.simulateEngineFailure });
      } catch (e) {
        failGraphics(graphicsFailure(probe, e));
        return;
      }
      presenter.onGraphicsLost(() => failGraphics(graphicsFailure(probe, 'WebGL context lost and not restored', true)));
      if (perfAsked) presenter.showPerfOverlay(() => rtt);
      presenter.setQuality(quality, deviceHints());
      if (touchControls) presenter.setTouchLayout(true);
    }
    const control: Record<string, Control> = state.control;
    // Name tags: a proven person's name (short), else the slot label. Redrawn only when the text changes.
    for (const id of s.players) {
      const n = nameFor(id);
      const b = blobbiNameFor(id);
      // The tag: the person's name, and the Blobbi's when their fighter wears one (M9D); the slot label for guests and bots.
      presenter.setTag(id, n === null ? null : b ? `${clip(n, 12)} · ${clip(b, 10)}` : clip(n, 14));
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
        touch: !!touchControls,
        strugglers: meIndex >= 0 ? [{ index: meIndex, keys: '← ↔ → (A ↔ D)' }] : [],
        aimers: meIndex >= 0 && aim ? [{ index: meIndex, aim, keys: 'WASD · throw F / G' }] : [],
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
    if (graphicsDown) return;
    const now = performance.now();
    frame(Math.min(0.05, (now - last) / 1000));
    last = now;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  Object.assign(window, {
    rumble: {
      /** M12: the renderer's settings now, and its measured cost (n frames, GPU-synchronised); `setGraphics` as the panel does. */
      get graphics() {
        return presenter?.renderInfo ?? null;
      },
      measureRender: (n = 60) => presenter?.measureRender(n) ?? null,
      setGraphics: (choice: QualityChoice) => {
        quality = choice;
        presenter?.setQuality(choice, deviceHints());
      },
      mode: 'network',
      get you() {
        return you;
      },
      /** L1: the lobby room's lifecycle as last heard (null: a continuous room); L2: its requests, for scripted checks until L3. */
      get lobby() {
        return lobby;
      },
      lobbyReady: (ready = true) => send({ t: 'ready', ready }),
      lobbyStart: () => send({ t: 'start' }),
      lobbySettings: (settings: { bots?: boolean; arena?: string; rotate?: boolean }) => send({ t: 'settings', ...settings }),
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
      host: (listed = false, arena?: string, rotate = false) => switchTo({ kind: 'create', listed, ...(arena ? { arena } : {}), rotate }),
      /** M10: servers and rooms, for scripted checks. */
      get gameServer() {
        return server;
      },
      get servers() {
        return knownServers();
      },
      get rooms() {
        return rooms;
      },
      refreshRooms: () => askRooms(true),
      join: (id: string) => switchTo({ kind: 'join', id }),
      openRoom: () => switchTo({ kind: 'open' }),
      shell,
      /** M8C-B invites, for scripted checks (valid invites only; nothing else is held). */
      get inbox() {
        return inboxView();
      },
      checkInvites: () => inbox?.check(),
      /** M9A the player's Blobbis and the local choice, for scripted checks; M9B the form worn. */
      blobbis: {
        get state() {
          return blobbis?.state ?? null;
        },
        get chosen() {
          return blobbis?.chosen ?? null;
        },
        get form() {
          return currentForm();
        },
        get worn() {
          return Object.fromEntries(worn);
        },
        get declared() {
          return declared;
        },
        get lookNote() {
          return lookNote;
        },
        load: () => blobbis?.load(true),
        select: (d: string) => blobbis?.select(d),
        useDefault: () => blobbis?.useDefault(),
      },
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
        restore: () => identity.restore(),
        get diag() {
          return [...diagLines];
        },
        connectOther: () => identity.connectOther(),
        dismissOther: () => identity.dismissChanged(),
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
