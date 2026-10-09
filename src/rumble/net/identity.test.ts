/**
 * Identity on the server (M8A), host and sockets:
 *  - the roster says bot / guest / a proven pubkey per slot, nothing more;
 *  - identity belongs to the connection: it goes with it, and a slot's next
 *    holder (or the same person back on a new connection) starts as a guest;
 *  - the handshake over a real socket: challenge → kind-22242 proof →
 *    verdict, refusing replays, other servers' proofs, forgeries and junk;
 *  - guests play exactly as before (inputs acknowledged, states flowing);
 *  - the server code never touches a relay.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { finalizeEvent, generateSecretKey, getPublicKey, type VerifiedEvent } from 'nostr-tools/pure';
import { makeAuthEvent } from 'nostr-tools/nip42';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadHavokNode } from '../sim/havokNode';
import type { HavokInstance } from '../sim/physics';
import { RumbleHost } from './host';
import { inputMessage, type RosterMessage, type ServerMessage, type StateMessage, type WelcomeMessage } from './protocol';
import { startRumbleServer, type RumbleServer } from './server';

let havok: HavokInstance;
beforeAll(async () => {
  havok = await loadHavokNode();
});

describe('the roster (host)', () => {
  it('bots, guests and proven people; identity is the connection’s, not the slot’s', () => {
    const host = new RumbleHost({ havok });
    const pk = getPublicKey(generateSecretKey());
    expect(Object.values(host.roster().slots)).toEqual([{ who: 'bot' }, { who: 'bot' }, { who: 'bot' }, { who: 'bot' }]);
    host.connect(1);
    host.connect(2);
    expect(host.roster().slots).toMatchObject({ P1: { who: 'guest' }, P2: { who: 'guest' }, P3: { who: 'bot' } });
    expect(host.setIdentity(1, pk)).toBe(true);
    expect(host.setIdentity(1, pk)).toBe(false);
    expect(host.roster().slots.P1).toEqual({ who: 'nostr', pubkey: pk });
    expect(host.roster().slots.P2).toEqual({ who: 'guest' });
    // Leaves: P1 goes back to its bot with no identity left behind.
    host.disconnect(1);
    expect(host.roster().slots.P1).toEqual({ who: 'bot' });
    // The same person back on a new connection takes a free slot as a guest: nothing is restored.
    host.connect(3);
    expect(host.slot(3)).toBe('P1');
    expect(host.roster().slots.P1).toEqual({ who: 'guest' });
    expect(host.identityOf(3)).toBeNull();
    // Logging out: a guest again.
    host.setIdentity(2, pk);
    expect(host.setIdentity(2, null)).toBe(true);
    expect(host.roster().slots.P2).toEqual({ who: 'guest' });
    // Unknown connections and spectators change nothing in the roster.
    expect(host.setIdentity(99, pk)).toBe(false);
    host.connect(4);
    host.connect(5);
    host.connect(6);
    expect(host.slot(6)).toBeNull();
    expect(host.setIdentity(6, pk)).toBe(false);
    expect(host.identityOf(6)).toBe(pk);
    host.dispose();
  });

  it('the state message carries no identity at all (it stays the same size)', () => {
    const host = new RumbleHost({ havok });
    host.connect(1);
    const before = JSON.stringify(host.state()).length;
    host.setIdentity(1, getPublicKey(generateSecretKey()));
    expect(JSON.stringify(host.state()).length).toBe(before);
    expect(JSON.stringify(host.state())).not.toMatch(/pubkey|nostr/);
    host.dispose();
  });
});

describe('the identity handshake over the socket', () => {
  let server: RumbleServer | null = null;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate();
    await server?.close();
    server = null;
  });

  interface Client {
    ws: WebSocket;
    url: string;
    welcome: WelcomeMessage;
    messages: ServerMessage[];
    send: (m: unknown) => void;
    next: <T extends ServerMessage['t']>(t: T, after?: number) => Promise<Extract<ServerMessage, { t: T }>>;
  }
  async function client(url: string): Promise<Client> {
    const ws = new WebSocket(url);
    sockets.push(ws);
    const messages: ServerMessage[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(d.toString()) as ServerMessage));
    await new Promise((r) => ws.once('open', r));
    const next = async <T extends ServerMessage['t']>(t: T, after = 0) => {
      const until = Date.now() + 3000;
      for (;;) {
        const m = messages.slice(after).find((x) => x.t === t);
        if (m) return m as Extract<ServerMessage, { t: T }>;
        if (Date.now() > until) throw new Error(`no ${t}`);
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    const welcome = (await next('welcome')) as WelcomeMessage;
    return { ws, url, welcome, messages, send: (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m)), next };
  }
  const lastRoster = (c: Client) => [...c.messages].reverse().find((m): m is RosterMessage => m.t === 'roster');
  const waitFor = async (cond: () => boolean) => {
    const until = Date.now() + 3000;
    while (!cond()) {
      if (Date.now() > until) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  /** Ask for a challenge and answer it with `sign` (default: a correct proof by `sk` for the client's own URL). */
  async function prove(c: Client, sk: Uint8Array, sign?: (challenge: string) => VerifiedEvent | unknown) {
    const at = c.messages.length;
    c.send({ t: 'challenge' });
    const ch = await c.next('challenge', at);
    const event = sign ? sign(ch.challenge) : finalizeEvent(makeAuthEvent(c.url, ch.challenge), sk);
    const at2 = c.messages.length;
    c.send({ t: 'auth', event });
    return { reply: await c.next('auth', at2), challenge: ch.challenge, event };
  }

  it('offers the handshake, verifies a proof, labels the slot for everyone; a guest beside it plays as before', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true });
    const url = `ws://127.0.0.1:${server.port}`;
    const alice = await client(url);
    const guest = await client(url);
    expect(alice.welcome.features).toContain('nostr-auth');
    const sk = generateSecretKey();
    const { reply } = await prove(alice, sk);
    expect(reply).toEqual({ t: 'auth', ok: true, pubkey: getPublicKey(sk) });
    await waitFor(() => lastRoster(guest)?.slots.P1.who === 'nostr');
    expect(lastRoster(guest)!.slots).toEqual({ P1: { who: 'nostr', pubkey: getPublicKey(sk) }, P2: { who: 'guest' }, P3: { who: 'bot' }, P4: { who: 'bot' } });
    expect(server.stats.authOk).toBe(1);
    // The guest's inputs are applied and acknowledged as always.
    guest.send(inputMessage(1, { x: 1, z: 0, run: false }, { jump: false, punch: false, grab: false }));
    await new Promise((r) => setTimeout(r, 30));
    server.host.tick();
    server.broadcast();
    await waitFor(() => guest.messages.some((m) => m.t === 'state' && (m as StateMessage).acks.P2 === 1));
  });

  it('a proof works once, on its own connection: replays, other servers’ proofs, forgeries and junk are refused', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true, challengeEveryMs: 0 });
    const url = `ws://127.0.0.1:${server.port}`;
    const a = await client(url);
    const b = await client(url);
    const sk = generateSecretKey();
    const first = await prove(a, sk);
    expect(first.reply.ok).toBe(true);
    // The same proof again: its challenge is used up.
    let at = a.messages.length;
    a.send({ t: 'auth', event: first.event });
    expect(await a.next('auth', at)).toMatchObject({ ok: false, reason: 'no-challenge' });
    // Captured and replayed on another connection: that connection's challenge is different.
    expect((await prove(b, sk, () => first.event)).reply).toMatchObject({ ok: false, reason: 'challenge' });
    // A proof made for another server (a malicious one relaying our challenge to its victim).
    expect((await prove(b, sk, (c) => finalizeEvent(makeAuthEvent('wss://evil.example/ws', c), sk))).reply).toMatchObject({ ok: false, reason: 'server' });
    // A forged signature, a tampered tag, junk, the wrong kind.
    expect((await prove(b, sk, (c) => ({ ...finalizeEvent(makeAuthEvent(url, c), sk), sig: 'f'.repeat(128) }))).reply).toMatchObject({ ok: false, reason: 'signature' });
    expect((await prove(b, sk, (c) => ({ ...finalizeEvent(makeAuthEvent(url, 'x'), sk), tags: [['relay', url], ['challenge', c]] }))).reply).toMatchObject({ ok: false, reason: 'signature' });
    expect((await prove(b, sk, () => ({ pubkey: 'x' }))).reply).toMatchObject({ ok: false, reason: 'malformed' });
    expect((await prove(b, sk, (c) => finalizeEvent({ ...makeAuthEvent(url, c), kind: 1 }, sk))).reply).toMatchObject({ ok: false, reason: 'kind' });
    // A proof with no challenge asked for.
    at = b.messages.length;
    b.send({ t: 'auth', event: finalizeEvent(makeAuthEvent(url, 'whatever'), sk) });
    expect(await b.next('auth', at)).toMatchObject({ ok: false, reason: 'no-challenge' });
    // Not an object at all: dropped as malformed, no reply.
    b.send({ t: 'auth', event: 'nope' });
    b.send('{"t":"auth","event":' + JSON.stringify({ pad: 'x'.repeat(3000) }) + '}');
    await new Promise((r) => setTimeout(r, 30));
    expect(lastRoster(b)!.slots.P2).toEqual({ who: 'guest' });
    expect(server.stats.authFailed).toBeGreaterThanOrEqual(7);
  });

  it('challenges are rate-limited per connection and gone with it', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true });
    const c = await client(`ws://127.0.0.1:${server.port}`);
    const at = c.messages.length;
    c.send({ t: 'challenge' });
    c.send({ t: 'challenge' });
    await c.next('challenge', at);
    expect(await c.next('auth', at)).toMatchObject({ ok: false, reason: 'busy' });
  });

  it('logout and reconnect: back to guest; the identity does not come back by itself', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true, challengeEveryMs: 0 });
    const url = `ws://127.0.0.1:${server.port}`;
    const watcher = await client(url);
    const a = await client(url);
    const sk = generateSecretKey();
    await prove(a, sk);
    await waitFor(() => lastRoster(watcher)?.slots.P2.who === 'nostr');
    a.send({ t: 'logout' });
    await waitFor(() => lastRoster(watcher)?.slots.P2.who === 'guest');
    await prove(a, sk);
    await waitFor(() => lastRoster(watcher)?.slots.P2.who === 'nostr');
    a.ws.terminate();
    await waitFor(() => lastRoster(watcher)?.slots.P2.who === 'bot');
    const again = await client(url);
    expect(again.welcome.you).toBe('P2');
    await waitFor(() => lastRoster(watcher)?.slots.P2.who === 'guest');
    expect(server.host.identityOf(4)).toBeNull();
  });

  it('with a configured public address, proofs must name it (not whatever Host the client sent)', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true, authUrls: ['wss://rumble.example/ws'], challengeEveryMs: 0 });
    const url = `ws://127.0.0.1:${server.port}`;
    const c = await client(url);
    const sk = generateSecretKey();
    expect((await prove(c, sk)).reply).toMatchObject({ ok: false, reason: 'server' });
    expect((await prove(c, sk, (ch) => finalizeEvent(makeAuthEvent('wss://rumble.example/ws', ch), sk))).reply).toMatchObject({ ok: true });
  });
});

describe('the server never needs relays', () => {
  it('no server-side module imports a relay pool or relay connection', () => {
    const dir = join(__dirname);
    const serverFiles = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const social = join(__dirname, '../../social');
    const shared = ['auth.ts', 'keys.ts'];
    for (const f of [...serverFiles.map((x) => join(dir, x)), ...shared.map((x) => join(social, x))]) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/nostr-tools\/(pool|relay|abstract-pool|abstract-relay)|social\/(pool|directory)/);
    }
  });
});
