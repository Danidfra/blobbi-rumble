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

function signer(sk: Uint8Array, opts: { nip44?: boolean; refuse?: boolean; hang?: boolean } = {}) {
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
              if (opts.hang) return new Promise(() => {});
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
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), dump: () => [...m.entries()] };
}
/** A fake inbox: every relay delivers `stored` (so duplicates arrive), then EOSE; `push` delivers live. */
function setup(stored: NostrEvent[], opts: { list?: NostrEvent | null; sig?: ReturnType<typeof signer>; storage?: ReturnType<typeof memoryStore>; prefs?: ReturnType<typeof memoryStore>; me?: string } = {}) {
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
  const prefs = opts.prefs ?? memoryStore();
  const live: string[] = [];
  let paused = 0;
  const inbox = new InviteInbox({ signer: sig.s, me: opts.me ?? B, lookup: new BoundedPool(lookupPool), subscribePool: () => pool, lookupRelays: ['wss://lookup.example'], storage, prefs, onLiveInvite: (i) => live.push(i.room), onPaused: () => paused++ });
  return { inbox, sig, storage, prefs, state, live, paused: () => paused, push: (e: NostrEvent) => onevent!(e) };
}
const settle = () => new Promise((r) => setTimeout(r, 30));
/** Wait (bounded) until `ok` holds: heavy decrypt runs take longer under a loaded test runner. */
const until = async (ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await settle();
};

describe('the invite inbox', () => {
  it('does nothing until asked; no NIP-44 means unavailable (identity is not its business)', async () => {
    const t = setup([await invite()]);
    await settle();
    // Located on its own (public data), nothing decrypted or subscribed.
    expect(t.inbox.state.phase).toBe('idle');
    expect(t.inbox.state.relays).toBe(2);
    expect(t.sig.calls.decrypt).toBe(0);
    expect(t.state.subscribed).toHaveLength(0);
    const no = setup([], { sig: signer(bob, { nip44: false }) });
    expect(no.inbox.state.phase).toBe('no-nip44');
    await no.inbox.check();
    expect(no.state.subscribed).toHaveLength(0);
  });

  it('no kind 10050: nothing to check, nothing subscribed', async () => {
    const t = setup([], { list: null });
    await settle();
    expect(t.inbox.state.phase).toBe('no-inbox');
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

/**
 * Automatic checking (M8C-B.2): the same check, started by the page once the
 * player said yes, one preference per identity and origin; paused by a
 * refusal; off at once when turned off; nothing decrypted before consent.
 */
describe('automatic invites', () => {
  const PREF = `rumble:auto-invites:v1:${B}`;

  it('first time: offered once the inbox is located; nothing is decrypted or subscribed before an answer', async () => {
    const t = setup([await invite()]);
    expect(t.inbox.offersAuto).toBe(false);
    await settle();
    expect(t.inbox.state.auto).toBe('unasked');
    expect(t.inbox.offersAuto).toBe(true);
    expect(t.sig.calls.decrypt).toBe(0);
    expect(t.state.subscribed).toHaveLength(0);
    expect(t.prefs.dump()).toEqual([]);
  });

  it('not offered without NIP-44 or without an inbox (the setup flow stays)', async () => {
    const no44 = setup([], { sig: signer(bob, { nip44: false }) });
    await settle();
    expect(no44.inbox.offersAuto).toBe(false);
    const noList = setup([], { list: null });
    await settle();
    expect(noList.inbox.state.phase).toBe('no-inbox');
    expect(noList.inbox.offersAuto).toBe(false);
    noList.inbox.enableAuto();
    await settle();
    expect(noList.state.subscribed).toHaveLength(0);
    expect(noList.inbox.state.phase).toBe('no-inbox');
  });

  it('Not now: remembered as off for this identity, the offer is not repeated, the manual check stays', async () => {
    const prefs = memoryStore();
    const t = setup([await invite()], { prefs });
    await settle();
    t.inbox.declineAuto();
    expect(t.inbox.state.auto).toBe('off');
    expect(t.inbox.offersAuto).toBe(false);
    expect(prefs.dump()).toEqual([[PREF, 'off']]);
    expect(t.sig.calls.decrypt).toBe(0);
    const again = setup([await invite()], { prefs });
    await settle();
    expect(again.inbox.offersAuto).toBe(false);
    expect(again.state.subscribed).toHaveLength(0);
    await again.inbox.check();
    expect(again.inbox.state.invites).toHaveLength(1);
    expect(again.inbox.state.phase).toBe('live');
  });

  it('enable: the check starts by itself (bounded catch-up, then live), the preference is one word per identity', async () => {
    const prefs = memoryStore();
    // Exactly the budget (wraps are backdated at random, so more would leave which 30 are newest to chance).
    const wraps: NostrEvent[] = [await invite()];
    for (let i = 0; i < INBOX.budget - 1; i++) wraps.push(await plainDm());
    const t = setup(wraps, { prefs });
    await settle();
    t.inbox.enableAuto();
    expect(prefs.dump()).toEqual([[PREF, 'on']]);
    expect(t.inbox.state.auto).toBe('on');
    await until(() => t.inbox.state.phase === 'live');
    expect(t.inbox.state.phase).toBe('live');
    expect(t.state.subscribed).toHaveLength(1);
    expect(t.inbox.state.checked).toBe(INBOX.budget);
    expect(t.sig.calls.decrypt).toBe(INBOX.budget * 2);
    expect(t.inbox.state.invites.map((i) => i.room)).toEqual(['X3ZH']);
    // Live: a new invite shows and is announced; an unrelated message is dropped; a duplicate delivery is not reopened.
    const fresh = await invite('Y4ZK');
    t.push(await plainDm());
    t.push(fresh);
    t.push(fresh);
    await until(() => t.inbox.state.invites.length === 2);
    expect(t.inbox.state.invites.map((i) => i.room)).toEqual(['Y4ZK', 'X3ZH']);
    expect(t.live).toEqual(['Y4ZK']);
    expect(t.sig.calls.decrypt).toBe(INBOX.budget * 2 + 4);
    expect(JSON.stringify(t.inbox.state)).not.toContain(SECRET);
    expect(JSON.stringify(prefs.dump())).not.toContain(SECRET);
  });

  it('after a reload with it on: starts without being asked; judged wraps are skipped; a live invite is found again', async () => {
    const prefs = memoryStore();
    const storage = memoryStore();
    const stored = [await invite(), await plainDm(), await plainDm()];
    const first = setup(stored, { prefs, storage });
    await settle();
    first.inbox.enableAuto();
    await settle();
    expect(first.inbox.state.invites).toHaveLength(1);
    first.inbox.stop();
    const again = setup(stored, { prefs, storage });
    expect(again.inbox.offersAuto).toBe(false);
    await settle();
    expect(again.inbox.state.phase).toBe('live');
    expect(again.inbox.state.skipped).toBe(2);
    expect(again.sig.calls.decrypt).toBe(2);
    expect(again.inbox.state.invites).toHaveLength(1);
    // Dismissed: not shown next time either.
    again.inbox.dismiss(again.inbox.state.invites[0].id);
    const third = setup(stored, { prefs, storage });
    await settle();
    expect(third.sig.calls.decrypt).toBe(0);
    expect(third.inbox.state.invites).toHaveLength(0);
  });

  it('the preference is per identity: another pubkey is asked afresh', async () => {
    const prefs = memoryStore();
    const t = setup([], { prefs });
    await settle();
    t.inbox.enableAuto();
    await settle();
    const carol = generateSecretKey();
    const C = getPublicKey(carol);
    const listC = finalizeEvent({ kind: 10050, created_at: now() - 50, tags: [['relay', 'wss://in1.example']], content: '' }, carol);
    const u = setup([], { prefs, me: C, sig: signer(carol), list: listC });
    await settle();
    expect(u.inbox.state.auto).toBe('unasked');
    expect(u.inbox.offersAuto).toBe(true);
    expect(u.state.subscribed).toHaveLength(0);
  });

  it('turning it off closes the subscription at once, keeps what was shown, leaves the manual check; nothing stale lands afterwards', async () => {
    const prefs = memoryStore();
    const t = setup([await invite()], { prefs });
    await settle();
    t.inbox.enableAuto();
    await settle();
    expect(t.inbox.state.phase).toBe('live');
    t.inbox.disableAuto();
    expect(t.inbox.state.auto).toBe('off');
    expect(t.inbox.state.phase).toBe('idle');
    expect(t.state.closed).toBe(1);
    expect(t.state.destroyed).toBe(1);
    expect(t.inbox.state.invites).toHaveLength(1);
    expect(prefs.dump()).toEqual([[PREF, 'off']]);
    // A wrap the closed subscription still delivers is ignored: not decrypted, not shown.
    const before = t.sig.calls.decrypt;
    t.push(await invite('Q7ZP'));
    await settle();
    expect(t.sig.calls.decrypt).toBe(before);
    expect(t.inbox.state.invites.map((i) => i.room)).toEqual(['X3ZH']);
    // A reload stays off, and the manual check works.
    const again = setup([await invite()], { prefs });
    await settle();
    expect(again.state.subscribed).toHaveLength(0);
    await again.inbox.check();
    expect(again.inbox.state.invites).toHaveLength(1);
  });

  it('turned off while the signer is busy: that run goes no further, and the wrap is left for a later check', async () => {
    const hanging = signer(bob, { hang: true });
    const w = await invite();
    const t = setup([w], { sig: hanging.s ? hanging : hanging });
    await settle();
    t.inbox.enableAuto();
    await settle();
    expect(t.inbox.state.phase).toBe('checking');
    expect(hanging.calls.decrypt).toBe(1);
    t.inbox.disableAuto();
    expect(t.inbox.state.phase).toBe('idle');
    await settle();
    expect(t.inbox.state.phase).toBe('idle');
    expect(t.inbox.state.invites).toHaveLength(0);
    expect(JSON.stringify(t.storage.dump())).not.toContain(w.id);
  });

  it('a refusal pauses it (no second prompt, no new subscription); Try again is one more prompt; a timeout pauses too', async () => {
    const prefs = memoryStore();
    const t = setup([await invite(), await plainDm()], { prefs, sig: signer(bob, { refuse: true }) });
    await settle();
    t.inbox.enableAuto();
    await settle();
    expect(t.inbox.state.phase).toBe('paused');
    expect(t.inbox.state.auto).toBe('on');
    expect(t.sig.calls.decrypt).toBe(1);
    expect(t.paused()).toBe(1);
    expect(t.state.closed).toBe(1);
    // Nothing restarts it by itself: not a new inbox list, not time.
    t.inbox.adopt(tenk);
    await settle();
    expect(t.inbox.state.phase).toBe('paused');
    expect(t.sig.calls.decrypt).toBe(1);
    expect(t.state.subscribed).toHaveLength(1);
    // Try again: exactly one more attempt.
    await t.inbox.check();
    expect(t.sig.calls.decrypt).toBe(2);
    expect(t.inbox.state.phase).toBe('paused');
    expect(t.paused()).toBe(2);
    // The preference is untouched (still on): a reload tries once, then pauses again.
    expect(prefs.dump()).toEqual([[PREF, 'on']]);
    const again = setup([await invite()], { prefs, sig: signer(bob, { refuse: true }) });
    await settle();
    expect(again.inbox.state.phase).toBe('paused');
    expect(again.sig.calls.decrypt).toBe(1);
    // A refusal of a manual check (automatic off) is 'declined', as before.
    const manual = setup([await invite()], { sig: signer(bob, { refuse: true }) });
    await manual.inbox.check();
    expect(manual.inbox.state.phase).toBe('declined');
    expect(manual.paused()).toBe(0);
  });

  it('inbox set up after connecting: adopting the list makes the offer; with it on, listening starts', async () => {
    const prefs = memoryStore();
    const t = setup([await invite()], { prefs, list: null });
    await settle();
    expect(t.inbox.state.phase).toBe('no-inbox');
    expect(t.inbox.offersAuto).toBe(false);
    t.inbox.adopt(tenk);
    expect(t.inbox.offersAuto).toBe(true);
    expect(t.state.subscribed).toHaveLength(0);
    t.inbox.enableAuto();
    await settle();
    expect(t.inbox.state.phase).toBe('live');
    expect(t.inbox.state.invites).toHaveLength(1);
    // Already on (from before), and the list arrives later: starts by itself.
    const u = setup([await invite()], { prefs, list: null });
    await settle();
    expect(u.inbox.state.phase).toBe('no-inbox');
    u.inbox.adopt(tenk);
    await settle();
    expect(u.inbox.state.phase).toBe('live');
    expect(u.inbox.state.invites).toHaveLength(1);
  });

  it('Disconnect Nostr (stop) while listening: closed, emptied, and nothing arriving later is opened or shown', async () => {
    const t = setup([await invite()]);
    await settle();
    t.inbox.enableAuto();
    await settle();
    expect(t.inbox.state.invites).toHaveLength(1);
    t.inbox.stop();
    expect(t.state.closed).toBe(1);
    expect(t.state.destroyed).toBe(1);
    expect(t.inbox.state.invites).toHaveLength(0);
    expect(t.inbox.offersAuto).toBe(false);
    const before = t.sig.calls.decrypt;
    t.push(await invite('W6ZN'));
    t.inbox.enableAuto();
    t.inbox.adopt(tenk);
    await settle();
    expect(t.sig.calls.decrypt).toBe(before);
    expect(t.state.subscribed).toHaveLength(1);
    expect(t.inbox.state.invites).toHaveLength(0);
  });
});
