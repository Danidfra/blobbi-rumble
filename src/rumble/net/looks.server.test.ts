/**
 * Looks over the socket (M9C, M9F): two proven players with different
 * Blobbis, a guest and spectators all see every fighter's form in the
 * roster; a late joiner gets it at once; a change, the default, a logout,
 * a disconnect and a room switch update everyone; nobody can wear another
 * player's Blobbi or set another slot; malformed and oversized looks are
 * dropped. Throwaway TEST keys.
 */
import { deriveBlobbiV3Seed, getCanonicalBlobbiD } from '@blobbi-kit/core';
import { makeAuthEvent } from 'nostr-tools/nip42';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadHavokNode } from '../sim/havokNode';
import type { HavokInstance } from '../sim/physics';
import type { RosterMessage, ServerMessage, WelcomeMessage } from './protocol';
import { startRumbleServer, type RumbleServer } from './server';

let havok: HavokInstance;
beforeAll(async () => {
  havok = await loadHavokNode();
});

describe('looks over the socket', () => {
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
  async function prove(c: Client, sk: Uint8Array) {
    const at = c.messages.length;
    c.send({ t: 'challenge' });
    const ch = await c.next('challenge', at);
    const at2 = c.messages.length;
    c.send({ t: 'auth', event: finalizeEvent(makeAuthEvent(c.url, ch.challenge), sk) });
    return c.next('auth', at2);
  }
  async function look(c: Client, form: unknown) {
    const at = c.messages.length;
    c.send({ t: 'look', form });
    return c.next('look', at);
  }
  const formOf = (slots: RosterMessage['slots'], slot: string) => (slots[slot].who === 'nostr' ? (slots[slot] as { form?: unknown }).form ?? null : null);

  const skA = generateSecretKey();
  const skB = generateSecretKey();
  const A = getPublicKey(skA);
  const B = getPublicKey(skB);
  const dA = getCanonicalBlobbiD(A, '0123456789');
  const dA2 = getCanonicalBlobbiD(A, 'abcdefabcd');
  const dB = getCanonicalBlobbiD(B, '0123456789');

  it('two proven players, a guest and spectators: every page sees every form; a late joiner gets them at once; the server offers looks', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true, challengeEveryMs: 0, lookEveryMs: 0 });
    const url = `ws://127.0.0.1:${server.port}`;
    const a = await client(url);
    const b = await client(url);
    const guest = await client(url);
    expect(a.welcome.features).toContain('looks');
    await prove(a, skA);
    await prove(b, skB);
    expect(await look(a, { v: 1, d: dA, gen: 'v3', name: 'Puck' })).toEqual({ t: 'look', ok: true });
    expect(await look(b, { v: 1, d: dB, gen: 'v2', colors: { base: '#aabbcc', secondary: '#000000', eye: '#ffffff' }, name: 'Mara' })).toEqual({ t: 'look', ok: true });
    await waitFor(() => !!formOf(lastRoster(guest)!.slots, 'P2'));
    for (const c of [a, b, guest]) {
      const slots = lastRoster(c)!.slots;
      expect(formOf(slots, 'P1')).toEqual({ v: 1, d: dA, gen: 'v3', name: 'Puck', seed: deriveBlobbiV3Seed(A, dA) });
      expect(formOf(slots, 'P2')).toEqual({ v: 1, d: dB, gen: 'v2', colors: { base: '#aabbcc', secondary: '#000000', eye: '#ffffff' }, name: 'Mara', seed: deriveBlobbiV3Seed(B, dB) });
      expect(slots.P3).toEqual({ who: 'guest' });
    }
    // Late: a fourth player and two spectators get the forms in their first roster.
    const late = await client(url);
    const s1 = await client(url);
    const s2 = await client(url);
    for (const c of [late, s1, s2]) {
      const r = await c.next('roster');
      expect(formOf(r.slots, 'P1')).toMatchObject({ d: dA });
      expect(formOf(r.slots, 'P2')).toMatchObject({ d: dB });
    }
    expect(s1.welcome.you).toBeNull();
    expect(lastRoster(s2)!.spectators).toBe(2);
  });

  it('a change, the default, a logout and a disconnect update everyone; the same look again sends no roster; stale and same-time updates are per connection', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true, challengeEveryMs: 0, lookEveryMs: 0 });
    const url = `ws://127.0.0.1:${server.port}`;
    const a = await client(url);
    const watcher = await client(url);
    await prove(a, skA);
    await look(a, { v: 1, d: dA, gen: 'v3' });
    await waitFor(() => !!formOf(lastRoster(watcher)!.slots, 'P1'));
    const rosters = () => watcher.messages.filter((m) => m.t === 'roster').length;
    const n0 = rosters();
    expect(await look(a, { v: 1, d: dA, gen: 'v3' })).toEqual({ t: 'look', ok: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(rosters()).toBe(n0);
    // Another of A's Blobbis mid-match: a new form, one roster.
    await look(a, { v: 1, d: dA2, gen: 'v3', name: 'Two' });
    await waitFor(() => (formOf(lastRoster(watcher)!.slots, 'P1') as { d?: string } | null)?.d === dA2);
    expect(rosters()).toBe(n0 + 1);
    // The default.
    await look(a, null);
    await waitFor(() => formOf(lastRoster(watcher)!.slots, 'P1') === null);
    expect(lastRoster(watcher)!.slots.P1).toEqual({ who: 'nostr', pubkey: A });
    // Wearing again, then logout: the identity goes and the form with it.
    await look(a, { v: 1, d: dA, gen: 'v3' });
    await waitFor(() => !!formOf(lastRoster(watcher)!.slots, 'P1'));
    a.send({ t: 'logout' });
    await waitFor(() => lastRoster(watcher)!.slots.P1.who === 'guest');
    expect(formOf(lastRoster(watcher)!.slots, 'P1')).toBeNull();
    // Proven again on the same connection: the default until declared again.
    await prove(a, skA);
    await waitFor(() => lastRoster(watcher)!.slots.P1.who === 'nostr');
    expect(formOf(lastRoster(watcher)!.slots, 'P1')).toBeNull();
    await look(a, { v: 1, d: dA, gen: 'v3' });
    await waitFor(() => !!formOf(lastRoster(watcher)!.slots, 'P1'));
    // Gone with the connection: the bot, with nothing left behind; the next holder starts plain.
    a.ws.terminate();
    await waitFor(() => lastRoster(watcher)!.slots.P1.who === 'bot');
    const again = await client(url);
    expect(again.welcome.you).toBe('P1');
    await prove(again, skA);
    await waitFor(() => lastRoster(watcher)!.slots.P1.who === 'nostr');
    expect(formOf(lastRoster(watcher)!.slots, 'P1')).toBeNull();
  });

  it('nobody wears another player’s Blobbi, sets another slot, or declares as a guest or a spectator; malformed and oversized looks are dropped', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true, challengeEveryMs: 0, lookEveryMs: 0 });
    const url = `ws://127.0.0.1:${server.port}`;
    const a = await client(url);
    const b = await client(url);
    const guest = await client(url);
    for (const c of [1, 2]) await client(url);
    const spectator = await client(url);
    expect(spectator.welcome.you).toBeNull();
    await prove(a, skA);
    await prove(b, skB);
    expect(await look(b, { v: 1, d: dA, gen: 'v3' })).toEqual({ t: 'look', ok: false, reason: 'not-yours' });
    expect(await look(guest, { v: 1, d: dA, gen: 'v3' })).toEqual({ t: 'look', ok: false, reason: 'no-identity' });
    await prove(spectator, skB);
    expect(await look(spectator, { v: 1, d: dB, gen: 'v3' })).toEqual({ t: 'look', ok: false, reason: 'spectator' });
    // A declaration that names a pubkey, a seed, another version, or is oversized is not a look at all (dropped unread, no reply);
    // a "slot" beside the form is ignored: a look only ever binds to the sender's own connection.
    const at = b.messages.length;
    b.send({ t: 'look', form: { v: 1, d: dB, gen: 'v3', pubkey: A } });
    b.send({ t: 'look', form: { v: 1, d: dB, gen: 'v3', seed: 'f'.repeat(64) } });
    b.send({ t: 'look', form: { v: 2, d: dB, gen: 'v3' } });
    b.send(`{"t":"look","form":{"v":1,"d":"${dB}","gen":"v3","name":"${'n'.repeat(1000)}"}}`);
    b.send({ t: 'look', slot: 'P1', form: { v: 1, d: dB, gen: 'v3' } });
    const reply = await b.next('look', at);
    expect(reply).toEqual({ t: 'look', ok: true });
    expect(b.messages.slice(at).filter((m) => m.t === 'look')).toHaveLength(1);
    const slots = lastRoster(a)!.slots;
    await waitFor(() => !!formOf(lastRoster(a)!.slots, 'P2'));
    expect(formOf(lastRoster(a)!.slots, 'P1')).toBeNull();
    expect(formOf(lastRoster(a)!.slots, 'P2')).toMatchObject({ d: dB, seed: deriveBlobbiV3Seed(B, dB) });
    expect(slots.P3).toEqual({ who: 'guest' });
    expect(server.stats.malformed).toBeGreaterThanOrEqual(4);
  });

  it('a room switch is a new connection: the old room forgets the form, the new one learns it when declared again; states never carry a form', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true, challengeEveryMs: 0, lookEveryMs: 0 });
    const url = `ws://127.0.0.1:${server.port}`;
    const a = await client(url);
    const watcher = await client(url);
    await prove(a, skA);
    await look(a, { v: 1, d: dA, gen: 'v3' });
    await waitFor(() => !!formOf(lastRoster(watcher)!.slots, 'P1'));
    const inRoom = await client(`${url}/?create=1`);
    expect(inRoom.welcome.room?.kind).toBe('private');
    a.ws.terminate();
    await waitFor(() => lastRoster(watcher)!.slots.P1.who === 'bot');
    const moved = await client(`${url}/?room=${inRoom.welcome.room!.id}`);
    expect(moved.welcome.you).toBe('P2');
    expect(formOf((await moved.next('roster')).slots, 'P2')).toBeNull();
    await prove(moved, skA);
    await look(moved, { v: 1, d: dA, gen: 'v3' });
    await waitFor(() => !!formOf(lastRoster(inRoom)!.slots, 'P2'));
    expect(formOf(lastRoster(watcher)!.slots, 'P2')).toBeNull();
    server.broadcast();
    const state = await inRoom.next('state');
    expect(JSON.stringify(state)).not.toMatch(/seed|form|blobbi-/);
  });
});
