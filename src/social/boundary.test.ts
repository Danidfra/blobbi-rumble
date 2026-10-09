/**
 * The social core is generic: it may import nostr-tools and itself, and
 * nothing of Rumble (no match, combat, physics, Babylon, view, protocol),
 * so extracting it later is a move, not a rewrite. And no code anywhere
 * asks for, stores or logs a secret key.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));

describe('the social module boundary', () => {
  it('imports only nostr-tools and its own files', () => {
    for (const f of files(__dirname).filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts'))) {
      const imports = [...readFileSync(f, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      for (const i of imports) expect(i.startsWith('nostr-tools') || i.startsWith('./'), `${f} imports ${i}`).toBe(true);
    }
  });

  it('no app code builds a secret key, imports one, or renders Nostr data as HTML', () => {
    const app = files(join(__dirname, '..')).filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts'));
    for (const f of app) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/generateSecretKey|nsecEncode|PlainKeySigner|fromNsec|decode\(\s*['"]nsec/);
    }
    for (const f of [join(__dirname, '../rumble/client/shell.ts'), join(__dirname, '../rumble/client/dom.ts'), join(__dirname, '../rumble/client/identity.ts'), ...files(__dirname)]) {
      if (f.endsWith('.test.ts')) continue;
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=/);
    }
  });
});

describe('the identity proof is never published to Nostr', () => {
  it('no app code can publish an event or answer a relay AUTH: the pool only reads', () => {
    const app = files(join(__dirname, '..')).filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts'));
    for (const f of app) {
      const src = readFileSync(f, 'utf8');
      // No publishing, no relay-side AUTH (which would sign a 22242 for a relay), no raw EVENT frames.
      expect(src, f).not.toMatch(/\.publish\(|automaticallyAuth|onauth\s*:|\[\s*['"]EVENT['"]|\[\s*['"]AUTH['"]/);
    }
    // The pool interface the app uses has reads and closes, nothing else.
    const pool = readFileSync(join(__dirname, 'pool.ts'), 'utf8');
    const iface = pool.slice(pool.indexOf('export interface PoolLike'), pool.indexOf('\n}', pool.indexOf('export interface PoolLike')));
    expect(iface).toMatch(/querySync/);
    expect(iface).toMatch(/close/);
    expect(iface).not.toMatch(/publish|subscribe/);
  });

  it('the identity session sends the signed proof only through the game connection it is given', () => {
    const src = readFileSync(join(__dirname, '../rumble/client/identity.ts'), 'utf8');
    expect(src).not.toMatch(/social\/(pool|directory|relays)|nostr-tools\/(pool|relay)/);
    expect(src).toMatch(/this\.d\.send\(\{ t: 'auth', event/);
  });
});
