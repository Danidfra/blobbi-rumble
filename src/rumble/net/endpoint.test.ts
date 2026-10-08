/** Where the page looks for the Rumble server: explicit, configured, the dev server, or its own origin (wss under https). */
import { describe, expect, it } from 'vitest';
import { asWebSocketUrl, resolveServerUrl } from './endpoint';

const page = (href: string) => {
  const u = new URL(href);
  return { protocol: u.protocol, host: u.host, hostname: u.hostname, search: u.search };
};
const resolve = (href: string, dev = false, configured?: string) => {
  const p = page(href);
  return resolveServerUrl(p, p.search, { dev, configured });
};

describe('the server address', () => {
  it('a built game served by `npm run serve` talks to its own origin, wss when the page is https', () => {
    expect(resolve('https://rumble.example.org/rumble.html?network=1')).toBe('wss://rumble.example.org/ws');
    expect(resolve('http://192.168.1.4:8080/rumble.html?network=1')).toBe('ws://192.168.1.4:8080/ws');
    expect(resolve('https://abc.ts.net:8443/rumble.html?network=1')).toBe('wss://abc.ts.net:8443/ws');
  });

  it('the Vite dev server keeps the dev game server beside it on port 8787, on whatever host the page came from', () => {
    expect(resolve('http://127.0.0.1:5177/rumble.html?network=1', true)).toBe('ws://127.0.0.1:8787');
    expect(resolve('http://192.168.1.4:5177/rumble.html?network=1', true)).toBe('ws://192.168.1.4:8787');
    expect(resolve('http://[::1]:5177/rumble.html?network=1', true)).toBe('ws://[::1]:8787');
  });

  it('?server= wins over everything, and an http(s) address means the same host’s /ws', () => {
    expect(resolve('https://rumble.example.org/rumble.html?network=1&server=wss://other.example:9000', false, 'wss://configured.example/ws')).toBe('wss://other.example:9000/');
    expect(resolve('http://127.0.0.1:5177/rumble.html?network=1&server=ws://10.0.0.2:8787', true)).toBe('ws://10.0.0.2:8787/');
    expect(resolve('http://127.0.0.1:5177/?server=https://host.example')).toBe('wss://host.example/ws');
    // Junk is ignored rather than tried.
    expect(resolve('http://127.0.0.1:5177/rumble.html?network=1&server=javascript:alert(1)', true)).toBe('ws://127.0.0.1:8787');
    expect(asWebSocketUrl('ftp://x')).toBeNull();
    expect(asWebSocketUrl('not a url')).toBeNull();
  });

  it('a build-time configured server is used when nothing overrides it', () => {
    expect(resolve('https://cdn.example/rumble.html?network=1', false, 'wss://game.example/ws')).toBe('wss://game.example/ws');
  });
});
