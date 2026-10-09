/**
 * Receiving invites inside Rumble (M8C-B): opt-in, the player's own 10050
 * inbox only, newest first within a budget, one invite however many relays
 * deliver it, live arrivals, reloads that do not re-decrypt, dismiss,
 * expiry, cleanup on identity change, and privacy: an unrelated private
 * message is opened, judged and dropped, and nothing of it is kept or
 * stored (ids only). Throwaway TEST keys.
 */
import * as nip44 from 'nostr-tools/nip44';
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate, type NostrEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import type { SubscribePoolLike } from '../../social/inbox';
import { wrapForRecipient } from '../../social/nip17';
import { BoundedPool, type PoolLike } from '../../social/pool';
import { nip07Signer, type NostrSigner } from '../../social/signer';
import { INBOX, InviteInbox } from './inviteInbox';
import { inviteTemplate } from './invites';

const alice = generateSecretKey();
const bob = generateSecretKey();
const A = getPublicKey(alice);
const B = getPublicKey(bob);
const SECRET = 'my bank PIN is 4242';

function signer(sk: Uint8Array, opts: { nip44?: boolean; refuse?: boolean } = {}) {
  const calls = { decrypt: 0 };
  const s: NostrSigner = nip07Signer({
    getPublicKey: async () => getPublicKey(sk),
    signEvent: async (t: EventTemplate) => finalizeEvent(t, sk),
    ...(opts.nip44 === false
      ? {}
      : {
          nip44: {
            encrypt: async (pk: string, t: string) => nip44.encrypt(t, nip44.getConversationKey(sk, pk)),
            decrypt: async (pk: string, d: string) => {
              calls.decrypt++;
              if (opts.refuse) throw new Error('User rejected');
              return nip44.decrypt(d, nip44.getConversationKey(sk, pk));
            },
          },
        }),
  });
  return { s, calls };
}
const now = () => Math.floor(Date.now() / 1000);
async function wrapOf(t: EventTemplate) {
  return (await wrapForRecipient(signer(alice).s, A, t, B, null)).wrap;
}
const invite = (room = 'X3ZH', at = now()) => wrapOf(inviteTemplate(B, `https://rumble.example/play/${room}`, 'danidfra', at));
const plainDm = () => wrapOf({ kind: 14, created_at: now(), content: SECRET, tags: [['p', B]] });
const tenk = finalizeEvent({ kind: 10050, created_at: now() - 50, tags: [['relay', 'wss://in1.example'], ['relay', 'wss://in2.example']], content: '' }, bob);

function memoryStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), dump: () => [...m.entries()] };
}
/** A fake inbox: every relay delivers `stored` (so duplicates arrive), then EOSE; `push` delivers live. */
function setup(stored: NostrEvent[], opts: { list?: NostrEvent | null; sig?: ReturnType<typeof signer>; storage?: ReturnType<typeof memoryStore> } = {}) {
  const lookupPool: PoolLike = { querySync: async (_r, f) => (opts.list === null ? [] : [opts.list ?? tenk]).filter((e) => f.kinds?.includes(e.kind) && f.authors?.includes(e.pubkey)), close() {} };
  let onevent: ((e: NostrEvent) => void) | null = null;
  const state = { subscribed: [] as string[][], closed: 0, destroyed: 0 };
  const pool: SubscribePoolLike & { destroy: () => void } = {
    subscribeMany(relays, _f, params) {
      state.subscribed.push(relays);
      onevent = params.onevent;
      setTimeout(() => {
        for (const r of relays) for (const e of stored) if (r) params.onevent(e);
        params.oneose?.();
      }, 0);
      return { close: () => void state.closed++ };
    },
    destroy: () => void state.destroyed++,
  };
  const sig = opts.sig ?? signer(bob);
  const storage = opts.storage ?? memoryStore();
  const live: string[] = [];
  const inbox = new InviteInbox({ signer: sig.s, me: B, lookup: new BoundedPool(lookupPool), subscribePool: () => pool, lookupRelays: ['wss://lookup.example'], storage, onLiveInvite: (i) => live.push(i.room) });
  return { inbox, sig, storage, state, live, push: (e: NostrEvent) => onevent!(e) };
}
const settle = () => new Promise((r) => setTimeout(r, 30));

describe('the invite inbox', () => {
  it('does nothing until asked; no NIP-44 means unavailable (identity is not its business)', async () => {
    const t = setup([await invite()]);
    expect(t.inbox.state.phase).toBe('idle');
    await settle();
    expect(t.sig.calls.decrypt).toBe(0);
    expect(t.state.subscribed).toHaveLength(0);
    const no = setup([], { sig: signer(bob, { nip44: false }) });
    expect(no.inbox.state.phase).toBe('no-nip44');
    await no.inbox.check();
    expect(no.state.subscribed).toHaveLength(0);
  });

  it('no kind 10050: nothing to check, nothing subscribed', async () => {
    const t = setup([], { list: null });
    await t.inbox.check();
    expect(t.inbox.state.phase).toBe('no-inbox');
    expect(t.state.subscribed).toHaveLength(0);
  });

  it('finds the invite once (two relays deliver it), drops the unrelated DM, keeps nothing of it', async () => {
    const t = setup([await invite(), await plainDm()]);
    await t.inbox.check();
    expect(t.state.subscribed[0]).toEqual(['wss://in1.example/', 'wss://in2.example/']);
    expect(t.inbox.state.phase).toBe('live');
    expect(t.inbox.state.invites).toHaveLength(1);
    expect(t.inbox.state.invites[0]).toMatchObject({ from: A, room: 'X3ZH', origin: 'https://rumble.example' });
    // Two wraps, each decrypted once (two layers each), despite two deliveries.
    expect(t.sig.calls.decrypt).toBe(4);
    // Privacy: the unrelated plaintext is nowhere in state or storage; storage holds ids only.
    expect(JSON.stringify(t.inbox.state)).not.toContain(SECRET);
    expect(JSON.stringify(t.storage.dump())).not.toContain(SECRET);
    for (const [, v] of t.storage.dump()) for (const id of JSON.parse(v)) expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(t.storage.dump()[0][0]).toBe(`rumble:invites-seen:v1:${B}`);
  });

  it('newest first, within the budget', async () => {
    const wraps: NostrEvent[] = [];
    for (let i = 0; i < 40; i++) wraps.push(await plainDm());
    const t = setup(wraps);
    await t.inbox.check();
    expect(t.inbox.state.checked).toBe(INBOX.budget);
    expect(t.sig.calls.decrypt).toBe(INBOX.budget * 2);
    const remembered = new Set(JSON.parse(t.storage.dump()[0][1]) as string[]);
    const newest = [...wraps].sort((a, b) => b.created_at - a.created_at).slice(0, INBOX.budget).map((w) => w.id);
    expect(newest.every((id) => remembered.has(id))).toBe(true);
  });

  it('a reload does not decrypt again what was already judged (but reopens a live invite to show it)', async () => {
    const storage = memoryStore();
    const stored = [await invite(), await plainDm(), await plainDm()];
    const first = setup(stored, { storage });
    await first.inbox.check();
    const again = setup(stored, { storage });
    await again.inbox.check();
    expect(again.inbox.state.skipped).toBe(2);
    expect(again.sig.calls.decrypt).toBe(2);
    expect(again.inbox.state.invites).toHaveLength(1);
  });

  it('live: a new invite after the first check shows (with a toast); an unrelated one does not', async () => {
    const t = setup([]);
    await t.inbox.check();
    expect(t.inbox.state.invites).toHaveLength(0);
    t.push(await plainDm());
    t.push(await invite('Y4ZK'));
    await settle();
    expect(t.inbox.state.invites.map((i) => i.room)).toEqual(['Y4ZK']);
    expect(t.live).toEqual(['Y4ZK']);
  });

  it('dismiss and expiry remove an invite (and its wrap is not opened again); expired invites never show', async () => {
    const storage = memoryStore();
    const t = setup([await invite()], { storage });
    await t.inbox.check();
    const id = t.inbox.state.invites[0].id;
    t.inbox.dismiss(id);
    expect(t.inbox.state.invites).toHaveLength(0);
    const again = setup([], { storage });
    expect(again.inbox.state.invites).toHaveLength(0);
    const old = setup([await invite('Z5ZM', now() - 3600)]);
    await old.inbox.check();
    expect(old.inbox.state.invites).toHaveLength(0);
  });

  it('a refusal stops the check; stop() (Disconnect Nostr, another identity) closes everything and forgets', async () => {
    const t = setup([await invite()], { sig: signer(bob, { refuse: true }) });
    await t.inbox.check();
    expect(t.inbox.state.phase).toBe('declined');
    expect(t.state.closed).toBe(1);
    const u = setup([await invite()]);
    await u.inbox.check();
    expect(u.inbox.state.invites).toHaveLength(1);
    u.inbox.stop();
    expect(u.inbox.state.invites).toHaveLength(0);
    expect(u.state.closed).toBe(1);
    expect(u.state.destroyed).toBe(1);
    u.push(await invite('W6ZN'));
    await settle();
    expect(u.inbox.state.invites).toHaveLength(0);
  });
});
