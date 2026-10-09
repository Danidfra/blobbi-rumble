/**
 * The Rumble invite (M8C-A): a readable kind-14 message whose text and `r`
 * tag carry the same room link, the Blobbi namespace marker, and a 30-minute
 * expiration; and the whole send flow with fakes, step by step.
 */
import * as nip44 from 'nostr-tools/nip44';
import { npubEncode } from 'nostr-tools/nip19';
import { unwrapEvent } from 'nostr-tools/nip59';
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate, type NostrEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import type { PublishPoolLike } from '../../social/inbox';
import { BoundedPool, type PoolLike } from '../../social/pool';
import { SignerError, nip07Signer, type NostrSigner } from '../../social/signer';
import { INVITE_LIFETIME, INVITE_MARKER, inviteLink, inviteTemplate } from './invites';
import { sendInvite, type InviteStatus } from './inviteSender';

const now = 1_800_000_000;
const alice = generateSecretKey();
const bob = generateSecretKey();
const A = getPublicKey(alice);
const B = getPublicKey(bob);

describe('the invite message', () => {
  it('is a kind-14 message: readable text and r tag with the same link, the marker, a 30-minute expiration', () => {
    const t = inviteTemplate(B, 'https://rumble.example/play/V4BU', 'danidfra', now);
    expect(t).toEqual({
      kind: 14,
      created_at: now,
      content: 'danidfra invited you to Blobbi Rumble: https://rumble.example/play/V4BU',
      tags: [['p', B], ['r', 'https://rumble.example/play/V4BU'], ['b', 'blobbi:rumble:invite:v1'], ['expiration', String(now + 30 * 60)]],
    });
    expect(INVITE_MARKER).toEqual(['b', 'blobbi:rumble:invite:v1']);
    expect(INVITE_LIFETIME).toBe(1800);
    expect(inviteTemplate(B, 'http://192.168.1.4:8080/play/V4BU', '  ', now).content).toBe('Someone invited you to Blobbi Rumble: http://192.168.1.4:8080/play/V4BU');
  });

  it('only sends a plain room link', () => {
    expect(inviteLink('https://rumble.example/play/v4bu')).toBe('https://rumble.example/play/v4bu');
    for (const bad of ['javascript:alert(1)', 'https://rumble.example/', 'https://rumble.example/play/V4BU/x', 'https://rumble.example/play/A0F2', 'https://u:p@rumble.example/play/V4BU', 'https://rumble.example/play/V4BU?x=1', 'https://rumble.example/play/V4BU#t=1', 'ftp://rumble.example/play/V4BU', 'not a url'])
      expect(inviteLink(bad), bad).toBeNull();
    expect(() => inviteTemplate('nope', 'https://rumble.example/play/V4BU', 'x', now)).toThrow();
    expect(() => inviteTemplate(B, 'https://evil.example/', 'x', now)).toThrow();
  });
});

function signer(sk: Uint8Array, opts: { nip44?: boolean; deny?: boolean } = {}): NostrSigner {
  const s = nip07Signer({
    getPublicKey: async () => getPublicKey(sk),
    signEvent: async (t: EventTemplate) => (opts.deny ? Promise.reject(new Error('User rejected')) : finalizeEvent(t, sk)),
    ...(opts.nip44 === false ? {} : { nip44: { encrypt: async (pk: string, text: string) => nip44.encrypt(text, nip44.getConversationKey(sk, pk)), decrypt: async () => '' } }),
  });
  void s.getPublicKey();
  return s;
}
const tenk = (relays: string[]) => finalizeEvent({ kind: 10050, created_at: Math.floor(Date.now() / 1000) - 100, tags: relays.map((r) => ['relay', r]), content: '' }, bob);
function deps(over: { holds?: NostrEvent[]; publish?: Record<string, boolean>; signer?: NostrSigner } = {}) {
  const statuses: InviteStatus[] = [];
  const published: { relays: string[]; event: NostrEvent }[] = [];
  let destroyed = 0;
  let madeRoom = -1;
  const lookupPool: PoolLike = { querySync: async (_r, f) => (over.holds ?? []).filter((e) => f.kinds?.includes(e.kind) && f.authors?.includes(e.pubkey)), close() {} };
  const lookup = new BoundedPool(lookupPool);
  const orig = lookup.makeRoom.bind(lookup);
  lookup.makeRoom = (n) => ((madeRoom = n), orig(n));
  const pool: PublishPoolLike & { destroy: () => void } = {
    publish: (relays, event) => (published.push({ relays, event }), relays.map(async (r) => ((over.publish ?? {})[r] ? 'ok' : Promise.reject(new Error('blocked'))))),
    destroy: () => void destroyed++,
  };
  return {
    d: { signer: over.signer ?? signer(alice), sender: A, lookup, publishPool: () => pool, lookupRelays: ['wss://lookup.example'], link: 'https://rumble.example/play/V4BU', inviterName: 'danidfra', onStatus: (s: InviteStatus) => statuses.push(s), now: () => now },
    statuses,
    published,
    get destroyed() {
      return destroyed;
    },
    get madeRoom() {
      return madeRoom;
    },
  };
}

describe('sending an invite', () => {
  it('npub → inbox → wrap → published to the inbox; Bob can open it and reads the invite', async () => {
    const t = deps({ holds: [tenk(['wss://in1.example', 'wss://in2.example'])], publish: { 'wss://in1.example/': true } });
    const r = await sendInvite(npubEncode(B), t.d);
    expect(r).toEqual({ k: 'sent', pubkey: B, accepted: 1, total: 2 });
    expect(t.statuses.map((s) => s.k)).toEqual(['looking', 'sending', 'sent']);
    expect(t.published).toHaveLength(1);
    expect(t.published[0].relays).toEqual(['wss://in1.example/', 'wss://in2.example/']);
    expect(t.published[0].event.kind).toBe(1059);
    expect(t.madeRoom).toBe(2);
    expect(t.destroyed).toBe(1);
    const rumor = unwrapEvent(t.published[0].event, bob);
    expect(rumor).toMatchObject({ kind: 14, pubkey: A, content: 'danidfra invited you to Blobbi Rumble: https://rumble.example/play/V4BU' });
    expect(rumor.tags).toContainEqual(['r', 'https://rumble.example/play/V4BU']);
    expect(rumor.tags).toContainEqual(['b', 'blobbi:rumble:invite:v1']);
  });

  it('every way it does not go: invalid, no inbox, declined, no relay accepts; nothing published when there is nothing to send', async () => {
    const bad = deps();
    expect(await sendInvite('alice@example.com', bad.d)).toEqual({ k: 'invalid' });
    const none = deps();
    expect(await sendInvite(npubEncode(B), none.d)).toEqual({ k: 'no-inbox', pubkey: B });
    expect(none.published).toHaveLength(0);
    const declined = deps({ holds: [tenk(['wss://in1.example'])], signer: signer(alice, { deny: true }) });
    expect(await sendInvite(npubEncode(B), declined.d)).toEqual({ k: 'declined', pubkey: B });
    expect(declined.published).toHaveLength(0);
    const dead = deps({ holds: [tenk(['wss://in1.example'])], publish: {} });
    expect(await sendInvite(npubEncode(B), dead.d)).toMatchObject({ k: 'failed', why: 'relays' });
    expect(dead.destroyed).toBe(1);
    const no44 = deps({ holds: [tenk(['wss://in1.example'])], signer: signer(alice, { nip44: false }) });
    expect(await sendInvite(npubEncode(B), no44.d)).toMatchObject({ k: 'failed', why: 'error' });
    expect(no44.published).toHaveLength(0);
    expect(SignerError).toBeDefined();
  });
});
