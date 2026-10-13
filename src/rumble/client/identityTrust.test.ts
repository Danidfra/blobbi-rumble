/**
 * L4.5B: a Nostr identity proof goes by itself only to a server this page
 * trusts. On any other server (a `?server=` link, a community server) a
 * remembered login is not restored (the extension is not even asked) and
 * Connect asks first; only a yes approves that exact address, and only
 * then is a challenge asked for. Guests play as before; trusted servers
 * keep their one-click (and automatic) sign-in. The trust store keeps
 * exact canonical WebSocket URLs only, re-checked from storage.
 */
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import type { NostrSigner } from '../../social/signer';
import type { ClientMessage } from '../net/protocol';
import { IdentitySession } from './identity';
import { IDENTITY_TRUST, approveIdentityServer, chooseServer, identityTrusted, loadIdentityApprovals, ownServers, type GameServer } from './servers';

const EVIL = 'wss://evil.example/ws';
const rules = { secure: true, dev: false };
const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(opts: { trusted: boolean; saved?: 'auto' | 'manual' }) {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const store = new Map<string, string>();
  if (opts.saved) store.set('rumble:nostr-login', JSON.stringify({ v: 1, method: 'nip07', pubkey: pk, auto: opts.saved === 'auto' }));
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  const sent: ClientMessage[] = [];
  let found = 0;
  let signed = 0;
  let approved = opts.trusted;
  let approvals = 0;
  const signer: NostrSigner = {
    method: 'nip07',
    getPublicKey: async () => pk,
    signEvent: async (t: EventTemplate) => {
      signed += 1;
      return finalizeEvent(t, sk);
    },
  };
  const session = new IdentitySession({
    url: EVIL,
    send: (m) => (sent.push(m), true),
    findSigner: async () => {
      found += 1;
      return signer;
    },
    storage,
    trusted: () => approved,
    approve: () => {
      approvals += 1;
      approved = true;
    },
  });
  session.onWelcome(['nostr-auth']);
  return { session, sent, pk, found: () => found, signed: () => signed, approvals: () => approvals };
}

describe('Nostr proofs and the server they go to (L4.5B)', () => {
  it('an unknown server: a remembered automatic login is NOT restored; the extension is not even asked; nothing is sent', async () => {
    const s = setup({ trusted: false, saved: 'auto' });
    await s.session.restore();
    await tick();
    expect(s.found()).toBe(0);
    expect(s.signed()).toBe(0);
    expect(s.sent).toEqual([]);
    expect(s.session.state).toMatchObject({ phase: 'known', held: true, pubkey: s.pk });
    expect(s.session.verified).toBeNull();
  });

  it('a trusted server: the remembered login restores by itself, as before', async () => {
    const s = setup({ trusted: true, saved: 'auto' });
    await s.session.restore();
    await tick();
    expect(s.found()).toBe(1);
    expect(s.sent).toContainEqual({ t: 'challenge' });
    expect(s.session.state.held).toBe(false);
  });

  it('Connect on an unknown server asks first: no signer, no challenge; "Stay a guest" leaves nothing shared', async () => {
    const s = setup({ trusted: false });
    await s.session.connect();
    expect(s.session.state.phase).toBe('confirm');
    expect(s.found()).toBe(0);
    expect(s.sent).toEqual([]);
    // Clicking Connect again while asked changes nothing.
    await s.session.connect();
    expect(s.found()).toBe(0);
    s.session.cancelConfirm();
    expect(s.session.state.phase).toBe('guest');
    expect(s.approvals()).toBe(0);
    expect(s.sent).toEqual([]);
  });

  it('a yes approves that server once, then signs in as a click does; a reconnect proves again without asking', async () => {
    const s = setup({ trusted: false });
    await s.session.connect();
    await s.session.confirmServer();
    await tick();
    expect(s.approvals()).toBe(1);
    expect(s.found()).toBe(1);
    expect(s.sent).toContainEqual({ t: 'challenge' });
    expect(s.session.state.phase).toBe('proving');
    // The game connection drops and comes back: proven again by itself (the approval stands).
    s.session.onClose();
    s.session.onWelcome(['nostr-auth']);
    expect(s.sent.filter((m) => m.t === 'challenge')).toHaveLength(2);
    expect(s.approvals()).toBe(1);
  });

  it('a held login: "Use it on this server" is the yes (one click), then it signs in', async () => {
    const s = setup({ trusted: false, saved: 'auto' });
    await s.session.restore();
    expect(s.session.state.held).toBe(true);
    await s.session.confirmServer();
    await tick();
    expect(s.approvals()).toBe(1);
    expect(s.sent).toContainEqual({ t: 'challenge' });
    expect(s.session.state.held).toBe(false);
  });

  it('a challenge the server sends on its own is never signed without a yes', async () => {
    const s = setup({ trusted: false, saved: 'auto' });
    await s.session.restore();
    await s.session.onChallenge('ab'.repeat(32));
    await s.session.connect();
    await s.session.onChallenge('cd'.repeat(32));
    expect(s.signed()).toBe(0);
    expect(s.sent.filter((m) => m.t === 'auth')).toHaveLength(0);
  });

  it('confirmServer without a question pending does nothing', async () => {
    const s = setup({ trusted: false });
    await s.session.confirmServer();
    expect(s.approvals()).toBe(0);
    expect(s.found()).toBe(0);
  });
});

describe('which servers are trusted with the identity (L4.5B)', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { m, store: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } };
  };
  const page = ownServers({ protocol: 'https:', host: 'rumble.example', hostname: 'rumble.example' }, false);
  const official: GameServer = { id: 'wss://rumble.blobbi.pet/ws', name: 'Official', url: 'wss://rumble.blobbi.pet/ws', source: 'official' };

  it('this site’s own server and the official ones are trusted; a ?server= link to anywhere else is not', () => {
    expect(identityTrusted(page[0], [])).toBe(true);
    expect(identityTrusted(official, [])).toBe(true);
    const viaLink = chooseServer([official, ...page], null, '?server=wss://evil.example/ws', rules).server;
    expect(viaLink.source).toBe('link');
    expect(identityTrusted(viaLink, [])).toBe(false);
    // A link that names a trusted server is that server (trusted), not a stranger.
    expect(identityTrusted(chooseServer([official, ...page], null, '?server=rumble.blobbi.pet/ws', rules).server, [])).toBe(true);
    // A community server the player added is a server they chose, not one they let see their identity: it asks too.
    expect(identityTrusted({ url: 'wss://friend.example/ws', source: 'community' }, [])).toBe(false);
  });

  it('an approval is one exact address: another path, port, host or a lookalike is another server', () => {
    const { store } = mem();
    approveIdentityServer(store, 'wss://friend.example/ws', rules);
    const ok = loadIdentityApprovals(store, rules);
    expect(identityTrusted({ url: 'wss://friend.example/ws', source: 'link' }, ok)).toBe(true);
    for (const other of ['wss://friend.example/other', 'wss://friend.example:8443/ws', 'wss://evil.friend.example/ws', 'wss://friend.example.evil.com/ws', 'wss://friend.example/ws?room=x']) expect(identityTrusted({ url: other, source: 'link' }, ok)).toBe(false);
  });

  it('storage is not trusted: only canonical, valid ws(s) addresses survive; the list is bounded', () => {
    const { m, store } = mem();
    m.set(IDENTITY_TRUST.storageKey, JSON.stringify(['wss://ok.example/ws', 'javascript:alert(1)', 'wss://user:pw@x.example/ws', 'WSS://OK.EXAMPLE/ws', 'http://plain.example/', 'wss://frag.example/ws#x', 42, 'ws://public.example/ws']));
    expect(loadIdentityApprovals(store, rules)).toEqual(['wss://ok.example/ws']);
    m.set(IDENTITY_TRUST.storageKey, '{not json');
    expect(loadIdentityApprovals(store, rules)).toEqual([]);
    const { store: s2 } = mem();
    for (let i = 0; i < 40; i++) approveIdentityServer(s2, `wss://s${i}.example/ws`, rules);
    const kept = loadIdentityApprovals(s2, rules);
    expect(kept).toHaveLength(IDENTITY_TRUST.max);
    expect(kept.at(-1)).toBe('wss://s39.example/ws');
  });

  it('a malformed or unsafe ?server= is refused (and reported), never connected to', () => {
    for (const bad of ['javascript:alert(1)', 'wss://user:pw@evil.example/ws', 'wss://evil.example/ws#frag', 'ftp://evil.example', `wss://${'a'.repeat(300)}.example/ws`, 'ws://public.example/ws']) {
      const r = chooseServer(page, null, `?server=${encodeURIComponent(bad)}`, rules);
      expect(r.server.url).toBe(page[0].url);
      expect(r.linkError).toBeTruthy();
    }
  });
});
