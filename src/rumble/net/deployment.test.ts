/**
 * L4.7B.1: the production configuration as files (compose.yaml,
 * .env.example, the Dockerfile) agrees with what the server reads. Every
 * setting the process reads reaches the container (compose passes only the
 * variables it lists: TRUSTED_PROXIES and ROOM_IDLE_MINUTES used to be
 * silently dropped); every setting in .env.example is used; the proxy
 * header is believed from exactly one peer, the project network's gateway
 * (not "private"); the port is published on loopback only; and the image is
 * tagged by commit, never "latest", so a rollback runs a known build.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trustedProxies } from './address';
import { identityFromEnv } from './serverIdentity';
import { NUMBER_SETTINGS, numberSettings } from './settings';

const repo = resolve(__dirname, '../../..');
const read = (f: string) => readFileSync(resolve(repo, f), 'utf8');
const compose = read('compose.yaml');
const dockerfile = read('Dockerfile');
const example = Object.fromEntries(
  read('.env.example')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
) as Record<string, string>;

/** The service's `environment:` block: name → its value as written (`${X:-default}` or a literal). */
const environment = (() => {
  const block = /\n {4}environment:\n((?: {6}.*\n)+)/.exec(compose);
  expect(block).not.toBeNull();
  const out: Record<string, string> = {};
  for (const line of block![1].split('\n')) {
    const m = /^ {6}([A-Z_]+): (.+)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
})();
/** The default compose falls back to for `${NAME:-default}` wherever it appears. */
const composeDefault = (name: string) => new RegExp(`\\$\\{${name}:-([^}]*)\\}`).exec(compose)?.[1];
/** What the container sees for a variable, given .env.example as the .env. */
const seen = (name: string) => {
  const v = environment[name];
  const ref = /^\$\{([A-Z_]+)(?::[-?]([^}]*))?\}$/.exec(v);
  return ref ? (example[ref[1]] || (v.includes(':-') ? ref[2] : undefined)) : v;
};

/** The settings the production entrypoint reads, from its own source (and the identity module it calls). */
const readsFromEnv = (() => {
  const names = new Set<string>(Object.keys(NUMBER_SETTINGS));
  for (const src of ['src/rumble/net/serve-cli.ts', 'src/rumble/net/serverIdentity.ts'])
    for (const m of read(src).matchAll(/\benv\.([A-Z][A-Z_]+)\b/g)) names.add(m[1]);
  return names;
})();
/** Set by the Dockerfile itself (where the process listens and what it serves), not by the operator. */
const IMAGE_SET = ['HOST', 'PORT', 'STATIC_DIR'];
/** compose's own settings (interpolated into compose.yaml, not passed to the process). */
const COMPOSE_ONLY = ['RUMBLE_HOST_PORT', 'RUMBLE_TAG', 'RUMBLE_SUBNET', 'RUMBLE_GATEWAY'];

describe('every production setting reaches the container (L4.7B.1)', () => {
  it('the entrypoint reads what we think it reads', () => {
    for (const k of ['PUBLIC_URL', 'ALLOWED_ORIGINS', 'CLIENT_IP_HEADER', 'TRUSTED_PROXIES', 'SERVER_NAME', 'OPERATOR_PUBKEY', 'MAX_CONNECTIONS', 'MAX_ROOMS', 'ROOM_IDLE_MINUTES', 'TICK_HZ', 'SNAPSHOT_HZ', 'HOST', 'STATIC_DIR']) expect(readsFromEnv).toContain(k);
  });

  it('compose passes every setting the process reads (except the image’s own), so nothing in .env is silently dropped', () => {
    for (const k of readsFromEnv) if (!IMAGE_SET.includes(k)) expect(environment, k).toHaveProperty(k);
    for (const k of IMAGE_SET) expect(dockerfile).toMatch(new RegExp(`ENV [^\\n]*\\b${k}=`));
  });

  it('every setting in .env.example is used: by the process (through compose) or by compose itself', () => {
    for (const k of Object.keys(example)) {
      if (COMPOSE_ONLY.includes(k)) expect(compose, k).toContain(`\${${k}:`);
      else {
        expect(readsFromEnv, k).toContain(k);
        expect(environment[k], k).toMatch(new RegExp(`^\\$\\{${k}[:}]`));
      }
    }
  });

  it('the example .env starts a valid production server: identity without warnings, numbers in range', () => {
    const env = Object.fromEntries(Object.keys(environment).map((k) => [k, seen(k)]));
    const { identity, authUrls, warnings } = identityFromEnv(env);
    expect(identity.public?.origin).toBe('https://rumble.blobbi.pet');
    expect(authUrls).toEqual(['wss://rumble.blobbi.pet/ws']);
    expect(warnings).toEqual([]);
    expect(env.ALLOWED_ORIGINS).toBe('https://rumble.blobbi.pet');
    expect(env.CLIENT_IP_HEADER).toBe('cf-connecting-ip');
    expect(numberSettings(env)).toMatchObject({ MAX_CONNECTIONS: 64, MAX_ROOMS: 16, ROOM_IDLE_MINUTES: 20, TICK_HZ: 60, SNAPSHOT_HZ: 20 });
    // PUBLIC_URL has no default: compose refuses to start without it.
    expect(environment.PUBLIC_URL).toMatch(/^\$\{PUBLIC_URL:\?/);
  });
});

describe('whose address header is believed (L4.7B.1)', () => {
  const subnet = example.RUMBLE_SUBNET;
  const gateway = example.RUMBLE_GATEWAY;

  it('exactly the project network’s gateway: the same address in .env.example and in every compose default, inside the subnet', () => {
    expect(example.TRUSTED_PROXIES).toBe(gateway);
    expect(composeDefault('TRUSTED_PROXIES')).toBe(gateway);
    expect(composeDefault('RUMBLE_GATEWAY')).toBe(gateway);
    expect(composeDefault('RUMBLE_SUBNET')).toBe(subnet);
    expect(trustedProxies(subnet).trusts(gateway)).toBe(true);
    // The service is on that network (not the default one, whose range Docker picks).
    expect(compose).toMatch(/\n {4}networks:\n {6}- rumble\n/);
    expect(compose).toMatch(/\nnetworks:\n {2}rumble:\n {4}ipam:\n {6}config:\n {8}- subnet: \$\{RUMBLE_SUBNET:-[^}]+\}\n {10}gateway: \$\{RUMBLE_GATEWAY:-[^}]+\}\n/);
  });

  it('the gateway is believed; the container itself, other Docker networks, the LAN, a tailnet and loopback are not (as "private" would)', () => {
    const t = trustedProxies(example.TRUSTED_PROXIES);
    expect(t.invalid).toEqual([]);
    expect(t.trusts(gateway)).toBe(true);
    expect(t.trusts(`::ffff:${gateway}`)).toBe(true);
    const others = ['172.31.250.2', '172.31.250.9', '172.17.0.1', '172.18.0.1', '192.168.1.20', '10.0.0.5', '100.64.0.7', '127.0.0.1', '::1', 'fd00::1', '203.0.113.9'];
    for (const p of others) expect(t.trusts(p), p).toBe(false);
    // What the old advice ("private") would have believed: every one of those but the public one.
    const priv = trustedProxies('private');
    expect(others.filter((p) => priv.trusts(p))).toHaveLength(others.length - 1);
  });

  it('the port is published on the host’s loopback only', () => {
    const ports = /\n {4}ports:\n((?: {6}.*\n)+)/.exec(compose)![1].split('\n').filter((l) => /^ {6}- /.test(l));
    expect(ports).toEqual(['      - "127.0.0.1:${RUMBLE_HOST_PORT:-8080}:8080"']);
  });
});

describe('one image per commit, for rollbacks (L4.7B.1)', () => {
  it('the image is tagged by RUMBLE_TAG, which is required (no "latest" fallback) and empty in the example', () => {
    expect(compose).toMatch(/\n {4}image: blobbi-rumble:\$\{RUMBLE_TAG:\?[^}]+\}\n/);
    expect(compose).not.toMatch(/:-?latest\b/);
    expect(example.RUMBLE_TAG).toBe('');
  });

  it('the image records the commit it was built from', () => {
    expect(compose).toMatch(/\n {8}RUMBLE_REVISION: \$\{RUMBLE_TAG:\?[^}]+\}\n/);
    expect(dockerfile).toMatch(/\nARG RUMBLE_REVISION=unknown\nLABEL [^\n]*org\.opencontainers\.image\.revision="\$\{RUMBLE_REVISION\}"/);
  });
});
