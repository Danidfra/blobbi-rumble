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
function setup(opts: { saved?: string; signer?: NostrSigner | null; connected?: boolean } = {}) {
  const sk = generateSecretKey();
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
      return signer;
    },
    storage,
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
    expect(JSON.parse(s.store.get('rumble:nostr-login')!)).toEqual({ v: 1, method: 'nip07', pubkey: s.pk });
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
