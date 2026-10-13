/**
 * L4.5B over real sockets: whose word the server takes for a player's
 * address (a forwarded header only from a trusted proxy, and only as one
 * real IP), how many places one network may hold as the server fills,
 * and why PUBLIC_URL is required in production: without it, a server a
 * player was lured to can relay this server's challenge and replay the
 * player's answer here; with it, that proof is refused. Replays and
 * nonsense are refused as before.
 */
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { makeAuthEvent } from 'nostr-tools/nip42';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadHavokNode } from '../sim/havokNode';
import type { HavokInstance } from '../sim/physics';
import type { ServerMessage, WelcomeMessage } from './protocol';
import { startRumbleServer, type RumbleServer, type ServerConfig } from './server';

let havok: HavokInstance;
beforeAll(async () => {
  havok = await loadHavokNode();
});
let server: RumbleServer | null = null;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await server?.close();
  server = null;
});

interface Conn {
  ws: WebSocket;
  welcome?: WelcomeMessage;
  closed?: { code: number; reason: string };
  messages: ServerMessage[];
  send: (m: unknown) => void;
}
function open(url: string, headers: Record<string, string> = {}): Promise<Conn> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    sockets.push(ws);
    const c: Conn = { ws, messages: [], send: (m) => ws.send(JSON.stringify(m)) };
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as ServerMessage;
      c.messages.push(m);
      if (m.t === 'welcome') {
        c.welcome = m;
        resolve(c);
      }
    });
    ws.on('close', (code, reason) => {
      c.closed = { code, reason: reason.toString() };
      resolve(c);
    });
    ws.on('error', () => {});
  });
}
const waitFor = async (cond: () => boolean, ms = 3000) => {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const lines: string[] = [];
const start = async (extra: Partial<ServerConfig> = {}) => {
  lines.length = 0;
  server = await startRumbleServer({ havok, port: 0, manual: true, challengeEveryMs: 0, log: (l) => lines.push(l), ...extra });
  return `ws://127.0.0.1:${server.port}`;
};
/** Open `n` connections that all claim `ip` in the header; how many got in. */
const claim = async (base: string, ip: string, n: number, spread = false) => {
  let inside = 0;
  // `spread`: alternate between the open room and the plaza (16 places), so only the connection limits are measured.
  for (let i = 0; i < n; i++) if ((await open(spread && i % 2 ? `${base}/ws?room=PLAZA&caps=plaza` : base, { 'x-client-ip': ip })).welcome) inside += 1;
  return inside;
};
const challengeOf = async (c: Conn) => {
  const at = c.messages.length;
  c.send({ t: 'challenge' });
  await waitFor(() => c.messages.slice(at).some((m) => m.t === 'challenge'));
  return (c.messages.slice(at).find((m) => m.t === 'challenge') as { challenge: string }).challenge;
};
const authReply = async (c: Conn, event: unknown) => {
  const at = c.messages.length;
  c.send({ t: 'auth', event });
  await waitFor(() => c.messages.slice(at).some((m) => m.t === 'auth'));
  return c.messages.slice(at).find((m) => m.t === 'auth') as { ok: boolean; reason?: string; pubkey?: string };
};

describe('a forwarded client address (L4.5B)', () => {
  it('without TRUSTED_PROXIES the header is taken from any peer (as documented: only safe when nothing but the proxy reaches the port)', async () => {
    const base = await start({ clientIpHeader: 'x-client-ip', maxPerAddress: 3 });
    expect(await claim(base, '203.0.113.7', 5)).toBe(3);
  });

  it('with TRUSTED_PROXIES, a header from any other peer is ignored: forged addresses do not make new networks', async () => {
    // The test connects from 127.0.0.1, which this list does not trust: the header is not believed.
    const base = await start({ clientIpHeader: 'x-client-ip', trustedProxies: '192.0.2.1', maxPerAddress: 3 });
    for (let i = 0; i < 6; i++) await open(base, { 'x-client-ip': `198.51.100.${i}` });
    // Every one counted as the socket's own address (loopback, the operator: not limited); none as a forged network.
    expect(lines.some((l) => l.includes('ignoring x-client-ip from 127.0.0.1: not a trusted proxy'))).toBe(true);
    expect(lines.filter((l) => /conn \d+ from net local/.test(l))).toHaveLength(6);
    expect(lines.filter((l) => l.includes('ignoring x-client-ip')).length).toBe(1);
  });

  it('from a trusted proxy the header is believed: the player’s network is limited, another network is not', async () => {
    const base = await start({ clientIpHeader: 'x-client-ip', trustedProxies: 'loopback', maxPerAddress: 3 });
    expect(await claim(base, '203.0.113.7', 5)).toBe(3);
    expect(await claim(base, '198.51.100.2', 2)).toBe(2);
  });

  it('a header that is not one real IP is not believed (a forger cannot invent networks with junk), the socket’s address counts', async () => {
    const base = await start({ clientIpHeader: 'x-client-ip', trustedProxies: 'loopback', maxPerAddress: 2 });
    for (const junk of ['1.2', '::::', '999.1.1.1', 'abc', 'x'.repeat(60)]) await open(base, { 'x-client-ip': junk });
    expect(lines.filter((l) => /conn \d+ from net local/.test(l))).toHaveLength(5);
    // A list from a proxy chain: its first address is the player's.
    expect(await claim(base, '203.0.113.9, 10.0.0.1', 3)).toBe(2);
  });

  it('IPv6: every address of one /64 is one network; an IPv4-mapped address is its IPv4', async () => {
    const base = await start({ clientIpHeader: 'x-client-ip', trustedProxies: 'loopback', maxPerAddress: 2 });
    let inside = 0;
    for (const a of ['2001:db8:1:2::1', '2001:db8:1:2::ffff', '2001:db8:1:2:abcd::9']) if ((await open(base, { 'x-client-ip': a })).welcome) inside += 1;
    expect(inside).toBe(2);
    expect((await open(base, { 'x-client-ip': '2001:db8:1:3::1' })).welcome).toBeDefined();
    let v4 = 0;
    for (const a of ['198.51.100.20', '::ffff:198.51.100.20', '198.51.100.20']) if ((await open(base, { 'x-client-ip': a })).welcome) v4 += 1;
    expect(v4).toBe(2);
  });

  it('with no header configured, a client sending one changes nothing (its socket’s address counts)', async () => {
    const base = await start({ maxPerAddress: 1 });
    for (let i = 0; i < 3; i++) await open(base, { 'x-client-ip': `203.0.113.${i}`, 'cf-connecting-ip': `203.0.113.${i}` });
    expect(lines.filter((l) => /conn \d+ from net local/.test(l))).toHaveLength(3);
  });
});

describe('connection places as the server fills (L4.5B)', () => {
  it('near full, one network may hold fewer: the last places go to other networks', async () => {
    // 12 places; the last 8 are "near full": a network holds at most 4 then (8 otherwise).
    const base = await start({ clientIpHeader: 'x-client-ip', trustedProxies: 'loopback', maxConnections: 12, reservedConnections: 8, maxPerAddress: 8, maxPerAddressWhenBusy: 4, maxPerAddressPerRoom: 64 });
    expect(await claim(base, '203.0.113.1', 8, true)).toBe(4);
    expect(lines.some((l) => l.includes('refused 203.0.113.1') && l.includes('4 connections from this address already'))).toBe(true);
    expect(await claim(base, '203.0.113.2', 8, true)).toBe(4);
    expect(await claim(base, '203.0.113.3', 8, true)).toBe(4);
    // Full: anyone else is refused cleanly ("server full"), before taking anything.
    const late = await open(base, { 'x-client-ip': '203.0.113.4' });
    expect(late.closed).toEqual({ code: 1013, reason: 'server full' });
  });

  it('with room to spare, a household still gets its eight places', async () => {
    const base = await start({ clientIpHeader: 'x-client-ip', trustedProxies: 'loopback', maxConnections: 64, maxPerAddressPerRoom: 64 });
    expect(await claim(base, '198.51.100.40', 9, true)).toBe(8);
  });
});

describe('identity proofs and where they may be replayed (L4.5B)', () => {
  /** A lured player's answer to a challenge an attacker relayed from this server: it names the attacker's server. */
  const lured = (sk: Uint8Array, challenge: string) => finalizeEvent(makeAuthEvent('wss://evil.example/ws', challenge), sk);

  it('WITHOUT PUBLIC_URL (authUrls), a relayed proof is accepted when the relayer claims the lure’s Host: PUBLIC_URL is required in production', async () => {
    const base = await start();
    // The relayer asks for the same path its lure serves, and claims the lure's host.
    const relayer = await open(`${base}/ws`, { host: 'evil.example' });
    const sk = generateSecretKey();
    const r = await authReply(relayer, lured(sk, await challengeOf(relayer)));
    expect(r).toMatchObject({ ok: true, pubkey: getPublicKey(sk) });
  });

  it('WITH PUBLIC_URL, the same relayed proof is refused (it names another server), whatever Host the relayer claims', async () => {
    const base = await start({ authUrls: ['wss://rumble.example/ws'] });
    const relayer = await open(`${base}/ws`, { host: 'evil.example' });
    const sk = generateSecretKey();
    const r = await authReply(relayer, lured(sk, await challengeOf(relayer)));
    expect(r).toMatchObject({ ok: false, reason: 'server' });
    // A genuine proof for this server's public address is accepted.
    const real = await open(base);
    const ok = await authReply(real, finalizeEvent(makeAuthEvent('wss://rumble.example/ws', await challengeOf(real)), sk));
    expect(ok).toMatchObject({ ok: true, pubkey: getPublicKey(sk) });
  });

  it('a proof works once, on its own connection: replayed there or on another connection it is refused; an identity cannot be claimed without its key', async () => {
    const base = await start({ authUrls: ['wss://rumble.example/ws'] });
    const sk = generateSecretKey();
    const a = await open(base);
    const proof = finalizeEvent(makeAuthEvent('wss://rumble.example/ws', await challengeOf(a)), sk);
    expect(await authReply(a, proof)).toMatchObject({ ok: true });
    expect(await authReply(a, proof)).toMatchObject({ ok: false, reason: 'no-challenge' });
    const b = await open(base);
    await challengeOf(b);
    expect((await authReply(b, proof)).ok).toBe(false);
    // Someone else's pubkey with this key's signature: refused (the signature is the pubkey's or nothing).
    const c = await open(base);
    const forged = { ...finalizeEvent(makeAuthEvent('wss://rumble.example/ws', await challengeOf(c)), generateSecretKey()), pubkey: getPublicKey(sk) };
    expect(await authReply(c, forged)).toMatchObject({ ok: false, reason: 'signature' });
  });

  it('nonsense never reaches a room: malformed, oversized and unknown messages are counted and ignored, play goes on', async () => {
    const base = await start();
    const c = await open(base);
    for (const bad of ['{', 'null', '[]', JSON.stringify({ t: 'nope' }), JSON.stringify({ t: 'input', seq: -1, intent: {} }), JSON.stringify({ t: 'auth', event: 'x' }), 'x'.repeat(3000)]) c.ws.send(bad);
    c.send({ t: 'ping', id: 1, ct: 1 });
    await waitFor(() => c.messages.some((m) => m.t === 'pong'));
    expect(server!.stats.malformed).toBeGreaterThanOrEqual(5);
    expect(c.closed).toBeUndefined();
  });
});
