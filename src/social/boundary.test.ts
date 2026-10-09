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

  it('no app code handles an identity secret key; the only key made is the one-time NIP-59 wrapper key, inside giftWrap', () => {
    const app = files(join(__dirname, '..')).filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts'));
    for (const f of app) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/nsecEncode|PlainKeySigner|fromNsec|decode\(\s*['"]nsec|nsec1|localStorage\.setItem\([^)]*(secret|nsec|privkey)/i);
      if (!f.endsWith('/social/nip17.ts')) expect(src, f).not.toMatch(/generateSecretKey|finalizeEvent|getConversationKey/);
    }
    // In nip17.ts: one key, made in giftWrap, used for that wrap's encryption and signature, never returned or kept.
    const nip17 = readFileSync(join(__dirname, 'nip17.ts'), 'utf8');
    const body = nip17.slice(nip17.indexOf('export function giftWrap'), nip17.indexOf('\n}', nip17.indexOf('export function giftWrap')));
    expect(nip17.match(/generateSecretKey\(\)/g)).toHaveLength(1);
    expect(body).toMatch(/const oneTime = generateSecretKey\(\);/);
    expect(body.match(/oneTime/g)).toHaveLength(3);
    expect(body).not.toMatch(/return oneTime|this\.|=\s*oneTime/);
  });

  it('no app code renders Nostr data as HTML', () => {
    for (const f of [join(__dirname, '../rumble/client/shell.ts'), join(__dirname, '../rumble/client/dom.ts'), join(__dirname, '../rumble/client/identity.ts'), ...files(__dirname)]) {
      if (f.endsWith('.test.ts')) continue;
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=/);
    }
  });
});

describe('publishing: only gift wraps to inboxes and the player’s own inbox list; the identity proof never', () => {
  it('only social/inbox.ts publishes or answers relay AUTH, and only the invite sender uses it; the lookup pool only reads', () => {
    const app = files(join(__dirname, '..')).filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts'));
    for (const f of app) {
      const src = readFileSync(f, 'utf8');
      // Nobody hands a pool a signer for automatic AUTH, and nobody writes raw relay frames.
      expect(src, f).not.toMatch(/automaticallyAuth|\[\s*['"]EVENT['"]|\[\s*['"]AUTH['"]/);
      if (f.endsWith('/social/inbox.ts')) continue;
      expect(src, f).not.toMatch(/\.publish\(|onauth/);
      if (!['/rumble/client/inviteSender.ts', '/rumble/client/inviteInbox.ts', '/rumble/client/inboxSetup.ts'].some((x) => f.endsWith(x))) expect(src, f).not.toMatch(/social\/inbox'|social\/nip17'/);
    }
    // In inbox.ts: one publish call, in a private helper, reached only by the two checked publishers.
    const inbox = readFileSync(join(__dirname, 'inbox.ts'), 'utf8');
    expect(inbox.match(/\.publish\(/g)).toHaveLength(1);
    expect(inbox).toMatch(/\nasync function publishTo\(/);
    expect(inbox).not.toMatch(/export (async )?function publishTo/);
    expect(inbox.slice(inbox.indexOf('async function publishTo')).indexOf('.publish(')).toBeGreaterThan(0);
    expect(inbox.match(/publishTo\(/g)).toHaveLength(3);
    const wrapFn = inbox.slice(inbox.indexOf('export async function publishGiftWrap'), inbox.indexOf('async function publishTo'));
    expect(wrapFn.indexOf('wrap.kind !== 1059')).toBeGreaterThan(0);
    expect(wrapFn.indexOf('issued.has(inbox)')).toBeGreaterThan(0);
    expect(wrapFn.indexOf('publishTo(')).toBeGreaterThan(wrapFn.indexOf('wrap.kind !== 1059'));
    const listFn = inbox.slice(inbox.indexOf('export async function publishInboxList'));
    expect(listFn.indexOf("list.kind !== 10050")).toBeGreaterThan(0);
    expect(listFn.indexOf('list.pubkey !== me')).toBeGreaterThan(0);
    expect(listFn.indexOf('publishTo(')).toBeGreaterThan(listFn.indexOf('list.pubkey !== me'));
    // The pool interface the app uses has reads and closes, nothing else.
    const pool = readFileSync(join(__dirname, 'pool.ts'), 'utf8');
    const iface = pool.slice(pool.indexOf('export interface PoolLike'), pool.indexOf('\n}', pool.indexOf('export interface PoolLike')));
    expect(iface).toMatch(/querySync/);
    expect(iface).toMatch(/close/);
    expect(iface).not.toMatch(/publish|subscribe/);
  });

  it('the identity session sends the signed proof only through the game connection it is given', () => {
    const src = readFileSync(join(__dirname, '../rumble/client/identity.ts'), 'utf8');
    expect(src).not.toMatch(/social\/(pool|directory|relays|inbox|nip17)|nostr-tools\/(pool|relay)/);
    expect(src).toMatch(/this\.d\.send\(\{ t: 'auth', event/);
  });
});
