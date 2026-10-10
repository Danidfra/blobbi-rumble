/**
 * The client's identity session: guest by default, a remembered login is
 * only a hint, the signer is asked only on connect(), the proof goes to
 * the server and only its verdict makes "verified"; a dropped connection
 * proves again; disconnecting forgets everything but keeps playing. Nothing
 * secret is ever stored.
 */
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type EventTemplate } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { SignerError, type NostrSigner } from '../../social/signer';
import type { ClientMessage } from '../net/protocol';
import { IdentitySession } from './identity';

const URL_ = 'wss://rumble.example/ws';
function setup(opts: { saved?: string; signer?: NostrSigner | null; connected?: boolean; sk?: Uint8Array; findDelayMs?: number; findHangs?: boolean; restoreMs?: number } = {}) {
  const sk = opts.sk ?? generateSecretKey();
  const pk = getPublicKey(sk);
  const store = new Map<string, string>();
  if (opts.saved) store.set('rumble:nostr-login', opts.saved);
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  const sent: ClientMessage[] = [];
  let up = opts.connected ?? true;
  let asked = 0;
  const signer: NostrSigner | null =
    opts.signer === undefined
      ? { method: 'nip07', getPublicKey: async () => pk, signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) }
      : opts.signer;
  const session = new IdentitySession({
    url: URL_,
    send: (m) => (up ? (sent.push(m), true) : false),
    findSigner: async () => {
      asked += 1;
      if (opts.findHangs) await new Promise(() => {});
      if (opts.findDelayMs) await new Promise((r) => setTimeout(r, opts.findDelayMs));
      return signer;
    },
    storage,
    ...(opts.restoreMs ? { restoreMs: opts.restoreMs } : {}),
  });
  return { session, sent, store, pk, sk, setUp: (v: boolean) => (up = v), asked: () => asked };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('the identity session', () => {
  it('starts as a guest and asks no signer on its own', () => {
    const s = setup();
    expect(s.session.state.phase).toBe('guest');
    expect(s.asked()).toBe(0);
    expect(s.sent).toEqual([]);
  });

  it('a remembered login is only "known": no signature, not verified', () => {
    const pk = getPublicKey(generateSecretKey());
    const s = setup({ saved: JSON.stringify({ v: 1, method: 'nip07', pubkey: pk }) });
    expect(s.session.state).toMatchObject({ phase: 'known', pubkey: pk });
    expect(s.session.verified).toBeNull();
    expect(s.asked()).toBe(0);
  });

  it('a corrupt or secret-bearing record is not trusted', () => {
    expect(setup({ saved: '{bad' }).session.state.phase).toBe('guest');
    expect(setup({ saved: JSON.stringify({ v: 1, method: 'nsec', pubkey: 'a'.repeat(64) }) }).session.state.phase).toBe('guest');
    // Extra fields (a secret someone stuffed in) are dropped, never read back.
    const s = setup({ saved: JSON.stringify({ v: 1, method: 'nip07', pubkey: 'a'.repeat(64), nsec: 'nsec1secret' }) });
    expect(s.session.state.phase).toBe('known');
    expect(JSON.stringify(s.session.state)).not.toContain('nsec1');
  });

  it('connect → challenge → signed proof → the server’s yes: verified; only method and pubkey are stored', async () => {
    const s = setup();
    s.session.onWelcome(['nostr-auth']);
    await s.session.connect();
    expect(s.session.state.phase).toBe('proving');
    expect(s.sent).toEqual([{ t: 'challenge' }]);
    await s.session.onChallenge('c'.repeat(64));
    const auth = s.sent[1] as { t: 'auth'; event: Record<string, unknown> };
    expect(auth.t).toBe('auth');
    expect(verifyEvent(auth.event as never)).toBe(true);
    expect(auth.event.tags).toEqual([['relay', URL_], ['challenge', 'c'.repeat(64)]]);
    expect(s.session.verified).toBeNull();
    s.session.onAuth({ t: 'auth', ok: true, pubkey: s.pk });
    expect(s.session.verified).toBe(s.pk);
    expect(JSON.parse(s.store.get('rumble:nostr-login')!)).toEqual({ v: 1, method: 'nip07', pubkey: s.pk, auto: true });
    expect(s.session.state.auto).toBe(true);
    expect([...s.store.values()].join()).not.toMatch(/nsec|[0-9a-f]{64}.*[0-9a-f]{64}/);
  });

  it('a yes for another pubkey is not a yes', async () => {
    const s = setup();
    s.session.onWelcome(['nostr-auth']);
    await s.session.connect();
    s.session.onAuth({ t: 'auth', ok: true, pubkey: 'b'.repeat(64) });
    expect(s.session.state.phase).toBe('error');
  });

  it('no extension, a refusal, a timeout: an error with words, still a guest to the server', async () => {
    const none = setup({ signer: null });
    await none.session.connect();
    expect(none.session.state.phase).toBe('error');
    expect(none.session.state.error).toMatch(/No Nostr extension/);
    expect(none.sent).toEqual([]);
    const refuse = setup({ signer: { method: 'nip07', getPublicKey: () => Promise.reject(new SignerError('denied', 'no')), signEvent: () => Promise.reject(new Error('x')) } });
    await refuse.session.connect();
    expect(refuse.session.state.error).toMatch(/declined/);
    refuse.session.dismissError();
    expect(refuse.session.state.phase).toBe('guest');
    const s = setup({ signer: { method: 'nip07', getPublicKey: async () => 'a'.repeat(64), signEvent: () => Promise.reject(new SignerError('timeout', 'slow')) } });
    s.session.onWelcome(['nostr-auth']);
    await s.session.connect();
    await s.session.onChallenge('c');
    expect(s.session.state.error).toMatch(/No answer/);
    expect(s.sent).toEqual([{ t: 'challenge' }]);
  });

  it('an old server without the handshake: an error, the game unaffected', async () => {
    const s = setup();
    s.session.onWelcome(undefined);
    await s.session.connect();
    expect(s.session.state.error).toMatch(/does not support/);
    expect(s.sent).toEqual([]);
  });

  it('connecting before the game connection is up waits for the welcome', async () => {
    const s = setup({ connected: false });
    await s.session.connect();
    expect(s.session.state.phase).toBe('proving');
    expect(s.sent).toEqual([]);
    s.setUp(true);
    s.session.onWelcome(['nostr-auth']);
    expect(s.sent).toEqual([{ t: 'challenge' }]);
  });

  it('a dropped connection forgets the proof; the next connection proves again, by itself', async () => {
    const s = setup();
    s.session.onWelcome(['nostr-auth']);
    await s.session.connect();
    await s.session.onChallenge('c1');
    s.session.onAuth({ t: 'auth', ok: true, pubkey: s.pk });
    s.session.onClose();
    expect(s.session.verified).toBeNull();
    expect(s.session.state.phase).toBe('proving');
    s.sent.length = 0;
    s.session.onWelcome(['nostr-auth']);
    expect(s.sent).toEqual([{ t: 'challenge' }]);
  });

  it('the page’s signer (what the invite inbox follows) survives a game reconnect and a room switch; disconnect ends it', async () => {
    const s = setup();
    s.session.onWelcome(['nostr-auth']);
    expect(s.session.connectedSigner).toBeNull();
    await s.session.connect();
    const held = s.session.connectedSigner;
    expect(held).not.toBeNull();
    await s.session.onChallenge('c1');
    s.session.onAuth({ t: 'auth', ok: true, pubkey: s.pk });
    expect(s.session.connectedSigner).toBe(held);
    // The game socket drops, or the player switches room: a new connection, the same signer.
    s.session.onClose();
    expect(s.session.connectedSigner).toBe(held);
    s.session.onWelcome(['nostr-auth']);
    await s.session.onChallenge('c2');
    s.session.onAuth({ t: 'auth', ok: true, pubkey: s.pk });
    expect(s.session.connectedSigner).toBe(held);
    s.session.disconnect();
    expect(s.session.connectedSigner).toBeNull();
  });

  it('a challenge that expired during a slow prompt is retried once, then reported', async () => {
    const s = setup();
    s.session.onWelcome(['nostr-auth']);
    await s.session.connect();
    s.session.onAuth({ t: 'auth', ok: false, reason: 'expired' });
    expect(s.session.state.phase).toBe('proving');
    expect(s.sent.filter((m) => m.t === 'challenge')).toHaveLength(2);
    s.session.onAuth({ t: 'auth', ok: false, reason: 'expired' });
    expect(s.session.state.phase).toBe('error');
  });

  it('disconnect: logout sent, login forgotten, back to guest', async () => {
    const s = setup();
    s.session.onWelcome(['nostr-auth']);
    await s.session.connect();
    await s.session.onChallenge('c1');
    s.session.onAuth({ t: 'auth', ok: true, pubkey: s.pk });
    s.session.disconnect();
    await tick();
    expect(s.sent.at(-1)).toEqual({ t: 'logout' });
    expect(s.session.state).toMatchObject({ phase: 'guest', pubkey: null });
    expect(s.store.size).toBe(0);
    // A late challenge after disconnecting signs nothing.
    await s.session.onChallenge('late');
    expect(s.sent.at(-1)).toEqual({ t: 'logout' });
  });
});

/**
 * Restoring the session (M9B.1): an explicit connection remembers { pubkey,
 * auto }; the next page asks the same signer for its pubkey (no signature)
 * and goes on as a click would when it matches; anything else stops it; a
 * click or Disconnect meanwhile wins; Disconnect ends reconnection; a new
 * game connection is always proven with a fresh challenge.
 */
describe('restoring the session', () => {
  const saved = (pk: string, auto = true) => JSON.stringify({ v: 1, method: 'nip07', pubkey: pk, auto });

  it('an explicit connection turns reconnection on; a page with that record restores: same signer, same pubkey, then the normal proof', async () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const page = setup({ sk, saved: saved(pk) });
    expect(page.session.state).toMatchObject({ phase: 'known', pubkey: pk, auto: true });
    expect(page.session.connectedSigner).toBeNull();
    page.session.onWelcome(['nostr-auth']);
    const p = page.session.restore();
    expect(page.session.state.phase).toBe('restoring');
    await p;
    expect(page.asked()).toBe(1);
    expect(page.session.state).toMatchObject({ phase: 'proving', pubkey: pk, auto: true, other: null });
    expect(page.session.connectedSigner).not.toBeNull();
    expect(page.sent).toEqual([{ t: 'challenge' }]);
    // The proof is fresh: this connection's challenge, signed now; nothing from any earlier page.
    await page.session.onChallenge('fresh-1');
    const auth = page.sent[1] as { t: 'auth'; event: { tags: string[][]; created_at: number } };
    expect(auth.event.tags).toContainEqual(['challenge', 'fresh-1']);
    page.session.onAuth({ t: 'auth', ok: true, pubkey: pk });
    expect(page.session.verified).toBe(pk);
    // Once per page: a second call does nothing.
    await page.session.restore();
    expect(page.asked()).toBe(1);
  });

  it('a record without the preference (an older one, Not now, a refusal) restores nothing: the hint and a Reconnect button', async () => {
    const pk = getPublicKey(generateSecretKey());
    const old = setup({ saved: JSON.stringify({ v: 1, method: 'nip07', pubkey: pk }) });
    expect(old.session.state).toMatchObject({ phase: 'known', auto: false });
    await old.session.restore();
    expect(old.asked()).toBe(0);
    expect(old.session.state.phase).toBe('known');
    const off = setup({ saved: saved(pk, false) });
    await off.session.restore();
    expect(off.asked()).toBe(0);
    const guest = setup();
    await guest.session.restore();
    expect(guest.asked()).toBe(0);
    expect(guest.session.state.phase).toBe('guest');
  });

  it('the extension holds another identity: shown as changed, nothing switched, the saved identity untouched; only "connect as" adopts it', async () => {
    const remembered = getPublicKey(generateSecretKey());
    const t = setup({ saved: saved(remembered) });
    await t.session.restore();
    expect(t.session.state).toMatchObject({ phase: 'changed', pubkey: remembered, other: t.pk, auto: true });
    expect(t.session.connectedSigner).toBeNull();
    expect(JSON.parse(t.store.get('rumble:nostr-login')!).pubkey).toBe(remembered);
    expect(t.sent).toEqual([]);
    // Not now: the hint stays, reconnection is off, nothing asked again.
    t.session.dismissChanged();
    expect(t.session.state).toMatchObject({ phase: 'known', pubkey: remembered, other: null, auto: false });
    expect(JSON.parse(t.store.get('rumble:nostr-login')!)).toMatchObject({ pubkey: remembered, auto: false });
    await t.session.restore();
    expect(t.asked()).toBe(1);
    // Connect as the other: a normal connection to that identity, remembered from now on.
    const u = setup({ saved: saved(remembered) });
    await u.session.restore();
    u.session.onWelcome(['nostr-auth']);
    u.session.connectOther();
    expect(u.session.state).toMatchObject({ phase: 'proving', pubkey: u.pk, auto: true, other: null });
    expect(JSON.parse(u.store.get('rumble:nostr-login')!)).toMatchObject({ pubkey: u.pk, auto: true });
    expect(u.asked()).toBe(1);
  });

  it('no extension: the hint stays with reconnection on (next time, maybe); a refusal or a time-out keeps the hint but turns reconnection off', async () => {
    const pk = getPublicKey(generateSecretKey());
    const none = setup({ saved: saved(pk), signer: null });
    await none.session.restore();
    expect(none.session.state).toMatchObject({ phase: 'known', pubkey: pk, auto: true, error: null });
    expect(JSON.parse(none.store.get('rumble:nostr-login')!).auto).toBe(true);
    for (const code of ['denied', 'timeout'] as const) {
      const refusing: NostrSigner = { method: 'nip07', getPublicKey: async () => Promise.reject(new SignerError(code, 'no')), signEvent: async () => Promise.reject(new Error('no')) };
      const t = setup({ saved: saved(pk), signer: refusing });
      await t.session.restore();
      expect(t.session.state).toMatchObject({ phase: 'known', pubkey: pk, auto: false, error: null });
      expect(JSON.parse(t.store.get('rumble:nostr-login')!)).toMatchObject({ pubkey: pk, auto: false });
      await t.session.restore();
      expect(t.asked()).toBe(1);
    }
  });

  it('Disconnect ends reconnection: the record goes, the next page restores nothing; a Disconnect during a restore wins over its late answer', async () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const t = setup({ sk, saved: saved(pk) });
    await t.session.restore();
    t.session.disconnect();
    expect(t.session.state).toMatchObject({ phase: 'guest', pubkey: null, auto: false });
    expect(t.store.size).toBe(0);
    const next = setup({ sk, saved: t.store.get('rumble:nostr-login') });
    await next.session.restore();
    expect(next.asked()).toBe(0);
    expect(next.session.state.phase).toBe('guest');
    // Slow extension, Disconnect meanwhile: the answer is thrown away.
    const slow = setup({ sk, saved: saved(pk), findDelayMs: 30 });
    const p = slow.session.restore();
    slow.session.disconnect();
    await p;
    expect(slow.session.state.phase).toBe('guest');
    expect(slow.session.connectedSigner).toBeNull();
    expect(slow.store.size).toBe(0);
  });

  it('a click during a restore wins: one connection, no duplicate; a game reconnect after a restore proves again with the new challenge', async () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const t = setup({ sk, saved: saved(pk), findDelayMs: 30 });
    t.session.onWelcome(['nostr-auth']);
    const p = t.session.restore();
    await t.session.connect();
    await p;
    expect(t.session.state.phase).toBe('proving');
    expect(t.sent.filter((m) => m.t === 'challenge')).toHaveLength(1);
    await t.session.onChallenge('c1');
    t.session.onAuth({ t: 'auth', ok: true, pubkey: pk });
    const held = t.session.connectedSigner;
    // The game socket drops (or the room changes): the same signer, a fresh challenge, a fresh signature.
    t.session.onClose();
    expect(t.session.connectedSigner).toBe(held);
    t.sent.length = 0;
    t.session.onWelcome(['nostr-auth']);
    expect(t.sent).toEqual([{ t: 'challenge' }]);
    await t.session.onChallenge('c2');
    const auth = t.sent[1] as { t: 'auth'; event: { tags: string[][] } };
    expect(auth.event.tags).toContainEqual(['challenge', 'c2']);
    expect(auth.event.tags).not.toContainEqual(['challenge', 'c1']);
  });
});

/** The M9B.1 hotfix: a restore always settles, whatever the extension does, within its own bounded wait. */
describe('a restore always settles', () => {
  const saved = (pk: string) => JSON.stringify({ v: 1, method: 'nip07', pubkey: pk, auto: true });

  it('an extension that never answers for its public key: the restore times out, the hint stays, reconnection is off, and a click still works', async () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const hanging: NostrSigner = { method: 'nip07', getPublicKey: () => new Promise(() => {}), signEvent: async () => Promise.reject(new Error('no')) };
    const t = setup({ sk, saved: saved(pk), signer: hanging, restoreMs: 20 });
    const p = t.session.restore();
    expect(t.session.state.phase).toBe('restoring');
    await p;
    expect(t.session.state).toMatchObject({ phase: 'known', pubkey: pk, auto: false, error: null });
    expect(t.session.connectedSigner).toBeNull();
    // Not a loop: nothing asks again by itself.
    await t.session.restore();
    expect(t.asked()).toBe(1);
  });

  it('an extension that is never found (the finder hangs): the same bounded settle, with reconnection kept (nothing was prompted)', async () => {
    const pk = getPublicKey(generateSecretKey());
    const t = setup({ saved: saved(pk), findHangs: true, restoreMs: 20 });
    await t.session.restore();
    expect(t.session.state).toMatchObject({ phase: 'known', pubkey: pk, auto: false });
  });

  it('a late answer after the wait changes nothing: the state the restore settled to stays', async () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    let resolveKey: ((pk: string) => void) | null = null;
    const late: NostrSigner = { method: 'nip07', getPublicKey: () => new Promise((r) => (resolveKey = r)), signEvent: async () => Promise.reject(new Error('no')) };
    const t = setup({ sk, saved: saved(pk), signer: late, restoreMs: 20 });
    await t.session.restore();
    expect(t.session.state.phase).toBe('known');
    resolveKey!(pk);
    await new Promise((r) => setTimeout(r, 0));
    expect(t.session.state.phase).toBe('known');
    expect(t.session.connectedSigner).toBeNull();
  });

  it('the game server is down while an identity is restored: "proving" waits for the game connection and never pretends to be verified', async () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const t = setup({ sk, saved: saved(pk), connected: false });
    await t.session.restore();
    expect(t.session.state.phase).toBe('proving');
    expect(t.session.verified).toBeNull();
    expect(t.sent).toEqual([]);
    // The game comes up: the proof is asked for now, with a fresh challenge.
    t.setUp(true);
    t.session.onWelcome(['nostr-auth']);
    expect(t.sent).toEqual([{ t: 'challenge' }]);
  });
});
