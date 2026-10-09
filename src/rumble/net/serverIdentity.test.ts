/**
 * Server identity (M8B): one canonical public address from PUBLIC_URL, an
 * optional claimed operator, the well-known document, the trust labels a
 * page shows, and the HTTP routes (share links, well-known) of the hosted
 * entrypoint.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { npubEncode } from 'nostr-tools/nip19';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterEach, describe, expect, it } from 'vitest';
import { identityFromEnv, parseOperator, parsePublicUrl, roomShareUrl, wellKnown } from './serverIdentity';
import { classifyServer, isLocalHost } from './serverTrust';
import { staticHandler } from './static';

const pk = getPublicKey(generateSecretKey());

describe('PUBLIC_URL', () => {
  it('gives one canonical origin and its WebSocket; https means wss', () => {
    expect(parsePublicUrl('https://rumble.example')).toEqual({ ok: true, value: { origin: 'https://rumble.example', websocket: 'wss://rumble.example/ws' } });
    expect(parsePublicUrl('https://Rumble.Example:8443/')).toMatchObject({ ok: true, value: { origin: 'https://rumble.example:8443', websocket: 'wss://rumble.example:8443/ws' } });
    expect(parsePublicUrl('wss://rumble.example/ws')).toMatchObject({ ok: true, value: { origin: 'https://rumble.example' } });
  });

  it('allows plain http on a LAN or this machine; warns about it on a public host', () => {
    expect(parsePublicUrl('http://192.168.1.4:8080')).toEqual({ ok: true, value: { origin: 'http://192.168.1.4:8080', websocket: 'ws://192.168.1.4:8080/ws' } });
    expect(parsePublicUrl('http://localhost:8080')).not.toHaveProperty('warning');
    expect(parsePublicUrl('http://rumble.example')).toMatchObject({ ok: true, warning: expect.stringMatching(/HTTPS/) });
  });

  it('refuses anything that is not a plain origin', () => {
    for (const bad of ['rumble.example', 'ftp://rumble.example', 'https://u:p@rumble.example', 'https://rumble.example/game', 'https://rumble.example/?x=1', 'https://rumble.example/#a', 'javascript:alert(1)', `https://${'a'.repeat(300)}.example`])
      expect(parsePublicUrl(bad).ok, bad).toBe(false);
  });
});

describe('the operator key and the environment', () => {
  it('takes npub or hex; refuses anything else', () => {
    expect(parseOperator(npubEncode(pk))).toEqual({ ok: true, value: pk });
    expect(parseOperator(pk.toUpperCase())).toEqual({ ok: true, value: pk });
    for (const bad of ['npub1nope', 'nsec1abc', pk.slice(2), 'x'.repeat(64)]) expect(parseOperator(bad).ok, bad).toBe(false);
  });

  it('builds the identity; everything is optional; a malformed setting is an error at start', () => {
    expect(identityFromEnv({})).toEqual({ identity: { name: null, operator: null, public: null }, authUrls: [], warnings: [] });
    const full = identityFromEnv({ PUBLIC_URL: 'https://rumble.example, http://192.168.1.4:8080', SERVER_NAME: '  Daniel’s‮ garden  ', OPERATOR_PUBKEY: npubEncode(pk) });
    expect(full.identity).toEqual({ name: 'Daniel’s garden', operator: pk, public: { origin: 'https://rumble.example', websocket: 'wss://rumble.example/ws' } });
    expect(full.authUrls).toEqual(['wss://rumble.example/ws', 'ws://192.168.1.4:8080/ws']);
    expect(() => identityFromEnv({ PUBLIC_URL: 'rumble.example' })).toThrow(/PUBLIC_URL/);
    expect(() => identityFromEnv({ OPERATOR_PUBKEY: 'npub1bad' })).toThrow(/OPERATOR_PUBKEY/);
  });

  it('the well-known document says only what is configured, and the share links follow the canonical origin', () => {
    expect(wellKnown({ name: null, operator: null, public: null })).toEqual({ protocol: 'blobbi-rumble', version: 1, websocket: '/ws', capabilities: ['rooms', 'nostr-auth'] });
    expect(wellKnown(identityFromEnv({ PUBLIC_URL: 'https://rumble.example', SERVER_NAME: 'Garden', OPERATOR_PUBKEY: pk }).identity)).toEqual({ protocol: 'blobbi-rumble', version: 1, websocket: 'wss://rumble.example/ws', capabilities: ['rooms', 'nostr-auth'], name: 'Garden', operator: pk, url: 'https://rumble.example' });
    expect(roomShareUrl('https://rumble.example', 'A7F2')).toBe('https://rumble.example/play/A7F2');
    expect(roomShareUrl('https://rumble.example', 'OPEN')).toBe('https://rumble.example/');
  });
});

describe('trust labels', () => {
  it('local, official, community and unknown, and nothing more is claimed', () => {
    for (const h of ['localhost', '127.0.0.1', '192.168.1.4', '10.0.0.7', '172.20.1.1', '100.122.255.7', 'blobbi.local', '[::1]', 'fd12:3456::1']) expect(isLocalHost(h), h).toBe(true);
    for (const h of ['rumble.example', '8.8.8.8', '172.32.0.1', '100.128.0.1', 'localhost.example.com']) expect(isLocalHost(h), h).toBe(false);
    expect(classifyServer('ws://192.168.1.4:8080/ws', null)).toMatchObject({ kind: 'local', label: 'Local server', host: '192.168.1.4:8080' });
    expect(classifyServer('wss://rumble.blobbi.pet/ws', null)).toMatchObject({ kind: 'official', label: 'Official server' });
    // An official name without TLS proves nothing.
    expect(classifyServer('ws://rumble.blobbi.pet/ws', null).kind).toBe('unknown');
    expect(classifyServer('wss://friend.example/ws', { operator: pk })).toMatchObject({ kind: 'community', detail: expect.stringMatching(/as the server states/) });
    expect(classifyServer('wss://friend.example/ws', {})).toMatchObject({ kind: 'unknown', label: 'Unknown server' });
    expect(classifyServer('not a url', null).kind).toBe('unknown');
  });
});

describe('the hosted entrypoint’s routes', () => {
  let http: Server | null = null;
  afterEach(() => new Promise<void>((r) => (http ? http.close(() => r()) : r())));
  it('serves the game page for share links and the well-known document to any origin', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rumble-dist-'));
    writeFileSync(join(root, 'rumble.html'), '<!doctype html><title>Blobbi Rumble</title>');
    http = createServer(staticHandler(root, undefined, { wellKnown: () => wellKnown(identityFromEnv({ PUBLIC_URL: 'https://rumble.example' }).identity) }));
    await new Promise<void>((r) => http!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    for (const path of ['/play/A7F2', '/play/a7f2?server=x', '/play/bad!code', '/play/']) {
      const r = await fetch(base + path);
      expect(r.status, path).toBe(200);
      expect(await r.text()).toContain('Blobbi Rumble');
      expect(r.headers.get('cache-control')).toBe('no-cache');
    }
    expect((await fetch(`${base}/play/A7F2/../../etc/passwd`)).status).toBe(404);
    // The landing redirect keeps the query (a room, a server override).
    const landing = await fetch(`${base}/?room=A7F2`, { redirect: 'manual' });
    expect(landing.headers.get('location')).toBe('/rumble.html?network=1&room=A7F2');
    expect((await fetch(base, { redirect: 'manual' })).headers.get('location')).toBe('/rumble.html?network=1');
    expect((await fetch(`${base}/play/x/y`)).status).toBe(404);
    const wk = await fetch(`${base}/.well-known/rumble.json`);
    expect(wk.headers.get('access-control-allow-origin')).toBe('*');
    expect(await wk.json()).toMatchObject({ protocol: 'blobbi-rumble', version: 1, websocket: 'wss://rumble.example/ws', url: 'https://rumble.example' });
  });
});
