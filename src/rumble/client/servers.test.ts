/**
 * Which game servers a page knows (M10A): strict endpoints (ws(s) only,
 * wss on https, plain ws only locally in development, no credentials or
 * fragments), built-in official servers from configuration, the page's own
 * and the dev server, community servers kept and re-checked in storage,
 * and which one a page uses (a link's ?server= first, then the choice, then
 * official, then its own).
 */
import { describe, expect, it } from 'vitest';
import { SERVERS, addCommunityServer, chooseServer, loadChosenServer, loadCommunityServers, officialServers, ownServers, parseEndpoint, removeCommunityServer, saveChosenServer, saveCommunityServers } from './servers';

const dev = { secure: false, dev: true };
const prod = { secure: true, dev: false };
const lan = { secure: false, dev: false };
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), raw: m };
};

describe('server endpoints', () => {
  it('ws(s) only, canonical; http(s) means the same host’s /ws; a bare host is wss', () => {
    expect(parseEndpoint('wss://rumble.example/ws', prod)).toEqual({ url: 'wss://rumble.example/ws' });
    expect(parseEndpoint('https://rumble.example', prod)).toEqual({ url: 'wss://rumble.example/ws' });
    expect(parseEndpoint('https://rumble.example/game', prod)).toEqual({ url: 'wss://rumble.example/game' });
    expect(parseEndpoint('rumble.example', prod)).toEqual({ url: 'wss://rumble.example/' });
    expect(parseEndpoint(' WSS://Rumble.Example:8443/ws ', prod)).toEqual({ url: 'wss://rumble.example:8443/ws' });
  });
  it('an https page never uses plain ws (no downgrade, no exception); plain ws is for local addresses, and anywhere only in development', () => {
    expect(parseEndpoint('ws://rumble.example/ws', prod)).toMatchObject({ error: expect.stringMatching(/https.*wss/) });
    expect(parseEndpoint('ws://127.0.0.1:8787', prod)).toMatchObject({ error: expect.stringMatching(/wss/) });
    expect(parseEndpoint('ws://192.168.1.20:8787', lan)).toEqual({ url: 'ws://192.168.1.20:8787/' });
    expect(parseEndpoint('ws://rumble.example/ws', lan)).toMatchObject({ error: expect.stringMatching(/local/) });
    expect(parseEndpoint('ws://rumble.example/ws', dev)).toEqual({ url: 'ws://rumble.example/ws' });
  });
  it('refuses other schemes, credentials, fragments, junk and the oversized', () => {
    for (const bad of ['javascript:alert(1)', 'ftp://x.example', 'file:///etc/passwd', 'wss://user:pw@x.example/ws', 'wss://x.example/ws#frag', '', '   ', 42, null, 'wss://', `wss://${'a'.repeat(300)}.example`])
      expect(parseEndpoint(bad, prod), String(bad)).toHaveProperty('error');
  });
});

describe('where servers come from', () => {
  it('official servers come only from configuration (none by default), checked entry by entry; the older single address still works', () => {
    expect(officialServers({}, prod)).toEqual([]);
    const list = JSON.stringify([
      { name: 'Blobbi Official', url: 'https://rumble.example', region: 'South America', operator: 'Blobbi' },
      { name: 'Insecure', url: 'ws://other.example/ws' },
      { name: 'Dup', url: 'wss://rumble.example/ws' },
      'junk',
      { url: 'javascript:x' },
    ]);
    expect(officialServers({ VITE_RUMBLE_SERVERS: list }, prod)).toEqual([{ id: 'wss://rumble.example/ws', name: 'Blobbi Official', url: 'wss://rumble.example/ws', source: 'official', region: 'South America', operator: 'Blobbi' }]);
    expect(officialServers({ VITE_RUMBLE_SERVERS: 'not json', VITE_RUMBLE_SERVER: 'wss://one.example/ws' }, prod)).toEqual([{ id: 'wss://one.example/ws', name: 'one.example', url: 'wss://one.example/ws', source: 'official' }]);
    expect(officialServers({ VITE_RUMBLE_SERVERS: JSON.stringify([{ name: 'x', url: 'ws://lan.example/ws' }]) }, prod)).toEqual([]);
  });
  it('the page’s own server is its origin at /ws (wss on https); in development, the dev server beside the page', () => {
    expect(ownServers({ protocol: 'https:', host: 'rumble.example', hostname: 'rumble.example' }, false)).toEqual([{ id: 'wss://rumble.example/ws', name: 'This site (rumble.example)', url: 'wss://rumble.example/ws', source: 'page' }]);
    expect(ownServers({ protocol: 'http:', host: '192.168.1.5:8080', hostname: '192.168.1.5' }, false)[0].url).toBe('ws://192.168.1.5:8080/ws');
    expect(ownServers({ protocol: 'http:', host: '127.0.0.1:5177', hostname: '127.0.0.1' }, true)).toMatchObject([{ url: 'ws://127.0.0.1:8787/', source: 'dev' }]);
  });
  it('community servers: added with a checked address, bounded, de-duplicated, kept in storage and re-checked on the way back', () => {
    const store = memory();
    let list = loadCommunityServers(store, prod);
    expect(list).toEqual([]);
    const r = addCommunityServer(list, { name: 'Friend', url: 'https://friend.example', region: 'Europe' }, prod);
    expect(r).toMatchObject({ servers: [{ id: 'community:wss://friend.example/ws', name: 'Friend', url: 'wss://friend.example/ws', source: 'community', region: 'Europe' }] });
    list = (r as { servers: typeof list }).servers;
    expect(addCommunityServer(list, { url: 'ws://friend.example/ws' }, prod)).toHaveProperty('error');
    expect(addCommunityServer(list, { url: 'wss://user:pw@x.example' }, prod)).toHaveProperty('error');
    const again = addCommunityServer(list, { name: 'Friend renamed', url: 'wss://friend.example/ws' }, prod) as { servers: typeof list };
    expect(again.servers).toHaveLength(1);
    expect(again.servers[0].name).toBe('Friend renamed');
    saveCommunityServers(store, again.servers);
    expect(store.raw.get(SERVERS.storageKey)).not.toMatch(/secret|nsec/);
    expect(loadCommunityServers(store, prod)).toEqual(again.servers);
    // Storage is not trusted: a tampered entry is dropped, the rest kept; the list is bounded.
    store.raw.set(SERVERS.storageKey, JSON.stringify([{ name: 'ok', url: 'wss://a.example/ws' }, { name: 'bad', url: 'ws://evil.example' }, { url: 'javascript:x' }, 'x', ...Array.from({ length: 20 }, (_, i) => ({ url: `wss://s${i}.example/ws` }))]));
    const loaded = loadCommunityServers(store, prod);
    expect(loaded.length).toBeLessThanOrEqual(SERVERS.maxCommunity);
    expect(loaded.some((s) => s.url.startsWith('ws://'))).toBe(false);
    store.raw.set(SERVERS.storageKey, '{broken');
    expect(loadCommunityServers(store, prod)).toEqual([]);
    expect(removeCommunityServer(again.servers, again.servers[0].id)).toEqual([]);
    const full = Array.from({ length: SERVERS.maxCommunity }, (_, i) => ({ id: `community:wss://s${i}.example/ws`, name: `s${i}`, url: `wss://s${i}.example/ws`, source: 'community' as const }));
    expect(addCommunityServer(full, { url: 'wss://one-more.example/ws' }, prod)).toHaveProperty('error');
  });
});

describe('which server a page uses', () => {
  const page = ownServers({ protocol: 'https:', host: 'site.example', hostname: 'site.example' }, false);
  const official = officialServers({ VITE_RUMBLE_SERVERS: JSON.stringify([{ name: 'Official', url: 'wss://official.example/ws' }]) }, prod);
  const friend = { id: 'community:wss://friend.example/ws', name: 'Friend', url: 'wss://friend.example/ws', source: 'community' as const };
  it('the first official server by default, else the page’s own; the remembered choice when it is still known', () => {
    expect(chooseServer([...official, ...page], null, '', prod).server).toBe(official[0]);
    expect(chooseServer([...page], null, '', prod).server).toBe(page[0]);
    expect(chooseServer([...official, ...page, friend], friend.id, '', prod).server).toBe(friend);
    expect(chooseServer([...official, ...page], 'community:wss://gone.example/ws', '', prod).server).toBe(official[0]);
  });
  it('a link’s ?server= wins for this page (a known one by identity; an unknown one as a link server); a bad one is reported, not used', () => {
    expect(chooseServer([...official, ...page, friend], null, '?server=wss%3A%2F%2Ffriend.example%2Fws', prod).server).toBe(friend);
    const linked = chooseServer([...official, ...page], null, '?server=https://other.example', prod);
    expect(linked.server).toEqual({ id: 'link:wss://other.example/ws', name: 'other.example', url: 'wss://other.example/ws', source: 'link' });
    const bad = chooseServer([...official, ...page], null, '?server=ws://other.example/ws', prod);
    expect(bad.server).toBe(official[0]);
    expect(bad.linkError).toMatch(/wss/);
    expect(chooseServer([...page], null, '?server=javascript:alert(1)', prod)).toMatchObject({ server: page[0], linkError: expect.any(String) });
  });
  it('the choice is one id in storage, read back only if it looks like one', () => {
    const store = memory();
    saveChosenServer(store, friend.id);
    expect(loadChosenServer(store)).toBe(friend.id);
    saveChosenServer(store, null);
    expect(loadChosenServer(store)).toBeNull();
    store.raw.set(SERVERS.chosenKey, 'x'.repeat(1000));
    expect(loadChosenServer(store)).toBeNull();
  });
});
