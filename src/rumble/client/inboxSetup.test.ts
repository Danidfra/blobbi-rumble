/**
 * Setting up private invites (M8C-B.1): an existing kind-10050 list is used
 * as it is (no signing, no publishing, no merge); with none, setup is
 * offered, probes without signing, and only an explicit confirm signs and
 * publishes the player's own list, to discovery and inbox relays, with
 * honest results (done, partial, unverified, failed), no retries of its
 * own, nothing after a disconnect, and relay AUTH for exactly those relays.
 * Throwaway TEST keys; a fake network ties probing, publishing and read-back
 * together.
 */
import { makeAuthEvent } from 'nostr-tools/nip42';
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate, type NostrEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { inboxListTemplate, probeRelays, publishInboxList, type ProbePoolLike, type PublishPoolLike } from '../../social/inbox';
import { BoundedPool, type PoolLike } from '../../social/pool';
import { nip07Signer } from '../../social/signer';
import { InboxSetup } from './inboxSetup';
import { InviteInbox } from './inviteInbox';

const sk = generateSecretKey();
const ME = getPublicKey(sk);
const LOOKUP = ['wss://look1.example/', 'wss://look2.example/', 'wss://look3.example/'];
const SUGGEST = ['wss://in1.example/', 'wss://in2.example/', 'wss://in3.example/'];
const now = () => Math.floor(Date.now() / 1000);

type Behaviour = { probe?: 'answered' | 'auth' | 'down'; write?: 'ok' | 'no' | 'auth' };
/** One fake network: relays hold events; probes, reads and publishes all see the same data. */
function network(behaviour: Record<string, Behaviour>, held: Record<string, NostrEvent[]> = {}) {
  const log = { published: [] as { relay: string; kind: number }[], authed: [] as string[], subscribed: [] as string[] };
  const store = (r: string) => (held[r] ??= []);
  const pool: ProbePoolLike & PublishPoolLike & { destroy: () => void } = {
    subscribeMany(relays, filter, params) {
      const url = relays[0];
      log.subscribed.push(url);
      const b = behaviour[url]?.probe ?? 'answered';
      setTimeout(() => {
        if (b === 'down') return;
        // As nostr-tools does: a CLOSED arrives as an EOSE, then the close with its reason.
        if (b === 'auth') return (params.oneose?.(), params.onclose?.([{ url, reason: 'auth-required: sign in' }]));
        const f = filter as { kinds?: number[]; authors?: string[] };
        for (const e of store(url)) if ((!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey))) params.onevent(e);
        params.oneose?.();
      }, 1);
      return { close: () => {} };
    },
    publish(relays, event, params) {
      return relays.map(async (url) => {
        const b = behaviour[url]?.write ?? 'ok';
        if (b === 'no') throw new Error('blocked: no');
        if (b === 'auth') {
          if (!params?.onauth) throw new Error('auth-required: sign in');
          const ev = await params.onauth(makeAuthEvent(url, 'challenge'));
          log.authed.push(ev.tags.find((t) => t[0] === 'relay')![1]);
        }
        log.published.push({ relay: url, kind: event.kind });
        store(url).push(event);
        return 'ok';
      });
    },
    destroy() {},
  };
  const lookupPool: PoolLike = {
    async querySync(relays, f) {
      return relays.flatMap((r) => ((behaviour[r]?.probe ?? 'answered') === 'down' ? [] : store(r).filter((e) => f.kinds?.includes(e.kind) && f.authors?.includes(e.pubkey))));
    },
    close() {},
  };
  return { pool, lookup: new BoundedPool(lookupPool), log, held };
}
function extension(opts: { deny?: boolean; slow?: Promise<void> } = {}) {
  const signed: number[] = [];
  const s = nip07Signer({
    getPublicKey: async () => ME,
    signEvent: async (t: EventTemplate) => {
      await opts.slow;
      if (opts.deny) throw new Error('User rejected');
      signed.push(t.kind);
      return finalizeEvent(t, sk);
    },
  });
  void s.getPublicKey();
  return { s, signed };
}
function setupWith(net: ReturnType<typeof network>, ext = extension()) {
  const adopted: NostrEvent[] = [];
  const setup = new InboxSetup({ signer: ext.s, me: ME, lookup: net.lookup, pools: () => net.pool, lookupRelays: LOOKUP, suggestions: SUGGEST, probeWaitMs: 100, onInbox: (l) => adopted.push(l) });
  return { setup, adopted, ext };
}
const list = (relays: string[], at = now() - 100) => finalizeEvent({ kind: 10050, created_at: at, tags: relays.map((r) => ['relay', r]), content: '' }, sk);

describe('the kind-10050 list and its publishing', () => {
  it('the template: 1-3 secure relays, canonical, de-duplicated, no content', () => {
    expect(inboxListTemplate(['wss://A.example', 'wss://a.example/', 'wss://b.example'], 100)).toEqual({ kind: 10050, created_at: 100, tags: [['relay', 'wss://a.example/'], ['relay', 'wss://b.example/']], content: '' });
    for (const bad of [[], ['ws://a.example'], ['https://a.example'], ['javascript:x'], ['wss://u:p@a.example'], ['wss://a.example', 'wss://b.example', 'wss://c.example', 'wss://d.example']])
      expect(() => inboxListTemplate(bad), JSON.stringify(bad)).toThrow();
  });

  it('publishes only the player’s own valid list, only to secure targets, with AUTH for exactly those', async () => {
    const net = network({ 'wss://in1.example/': { write: 'auth' } });
    const signer = extension().s;
    const mine = list(['wss://in1.example/']);
    const r = await publishInboxList(net.pool, mine, ME, ['wss://in1.example', 'wss://look1.example', 'ws://insecure.example', 'https://web.example'], signer);
    expect(r.accepted.sort()).toEqual(['wss://in1.example/', 'wss://look1.example/']);
    expect(net.log.authed).toEqual(['wss://in1.example/']);
    const other = finalizeEvent({ kind: 10050, created_at: now(), tags: [['relay', 'wss://x.example/']], content: '' }, generateSecretKey());
    await expect(publishInboxList(net.pool, other, ME, ['wss://look1.example'], signer)).rejects.toThrow(/own valid/);
    await expect(publishInboxList(net.pool, finalizeEvent({ kind: 10002, created_at: now(), tags: [['r', 'wss://x.example/']], content: '' }, sk), ME, ['wss://look1.example'], signer)).rejects.toThrow(/own valid/);
    await expect(publishInboxList(net.pool, finalizeEvent({ kind: 10050, created_at: now(), tags: [['relay', 'wss://x.example/'], ['p', ME]], content: '' }, sk), ME, ['wss://look1.example'], signer)).rejects.toThrow(/own valid/);
    await expect(publishInboxList(net.pool, { ...mine, content: 'x' }, ME, ['wss://look1.example'], signer)).rejects.toThrow(/own valid/);
    await expect(publishInboxList(net.pool, mine, ME, Array.from({ length: 12 }, (_, i) => `wss://r${i}.example`), signer)).rejects.toThrow(/targets/);
    await expect(publishInboxList(net.pool, mine, ME, ['ws://only-insecure.example'], signer)).rejects.toThrow(/targets/);
  });

  it('probes read-only: answered, needs AUTH, or down; nothing signed', async () => {
    const net = network({ 'wss://in2.example/': { probe: 'auth' }, 'wss://in3.example/': { probe: 'down' } });
    const { answers } = await probeRelays(net.pool, [...SUGGEST, 'ws://bad.example', 'nonsense'], { kinds: [1059] }, 50);
    expect(Object.fromEntries(answers)).toEqual({ 'wss://in1.example/': 'answered', 'wss://in2.example/': 'auth', 'wss://in3.example/': 'down' });
    expect(net.log.published).toHaveLength(0);
  });
});

describe('setting up private invites', () => {
  it('an existing list is found on connect and used unchanged: no setup, no signing, no publishing', async () => {
    const net = network({}, { [LOOKUP[0]]: [list(['wss://a.example/', 'wss://in2.example/'])] });
    const ext = extension();
    const inbox = new InviteInbox({ signer: { ...ext.s, nip44: { encrypt: async () => '', decrypt: async () => '' } }, me: ME, lookup: net.lookup, subscribePool: () => ({ subscribeMany: () => ({ close() {} }) }), lookupRelays: LOOKUP, storage: null });
    await new Promise((r) => setTimeout(r, 20));
    expect(inbox.state.phase).toBe('idle');
    expect(inbox.state.relays).toBe(2);
    expect(ext.signed).toEqual([]);
    expect(net.log.published).toEqual([]);
  });

  it('even if setup is opened, a list found by its strict check is used as it is (A+B stays A+B)', async () => {
    const existing = list(['wss://a.example/', 'wss://in2.example/']);
    const net = network({}, { [LOOKUP[1]]: [existing] });
    const t = setupWith(net);
    await t.setup.open();
    await t.setup.confirm();
    expect(t.setup.state.phase).toBe('exists');
    expect(t.adopted).toEqual([existing]);
    expect(t.ext.signed).toEqual([]);
    expect(net.log.published).toEqual([]);
  });

  it('suggestions are canonicalised (and insecure or invalid ones dropped) so probe answers match', async () => {
    const net = network({ 'wss://in2.example/': { probe: 'auth' } });
    const setup = new InboxSetup({ signer: extension().s, me: ME, lookup: net.lookup, pools: () => net.pool, lookupRelays: LOOKUP, suggestions: ['wss://IN1.example', 'wss://in2.example', 'ws://insecure.example', 'nonsense', 'wss://in1.example/'], probeWaitMs: 100, onInbox: () => {} });
    await setup.open();
    expect(setup.state.candidates.map((c) => [c.url, c.probe])).toEqual([
      ['wss://in1.example/', 'answered'],
      ['wss://in2.example/', 'auth'],
    ]);
  });

  it('opening probes without signing; unreachable suggestions start unselected; nothing happens until confirm', async () => {
    const net = network({ 'wss://in3.example/': { probe: 'down' } });
    const t = setupWith(net);
    await t.setup.open();
    expect(t.setup.state.phase).toBe('ready');
    expect(t.setup.state.candidates.map((c) => [c.url, c.probe, c.selected])).toEqual([
      ['wss://in1.example/', 'answered', true],
      ['wss://in2.example/', 'answered', true],
      ['wss://in3.example/', 'down', false],
    ]);
    expect(t.ext.signed).toEqual([]);
    expect(net.log.published).toEqual([]);
  });

  it('confirm: one signature (kind 10050), published to discovery and inbox relays, read back: done', async () => {
    const outbox = finalizeEvent({ kind: 10002, created_at: now() - 100, tags: [['r', 'wss://write.example']], content: '' }, sk);
    const net = network({ 'wss://in1.example/': { write: 'auth' } }, { [LOOKUP[0]]: [outbox] });
    const t = setupWith(net);
    await t.setup.open();
    t.setup.toggle('wss://in3.example/');
    await t.setup.confirm();
    expect(t.setup.state.phase).toBe('done');
    // One list signature, plus one relay AUTH (in1 asks for it): nothing else.
    expect(t.ext.signed.sort()).toEqual([10050, 22242]);
    const ev = t.adopted[0];
    expect(ev).toMatchObject({ kind: 10050, pubkey: ME, content: '', tags: [['relay', 'wss://in1.example/'], ['relay', 'wss://in2.example/']] });
    const to = [...new Set(net.log.published.map((p) => p.relay))].sort();
    expect(to).toEqual([...LOOKUP, 'wss://in1.example/', 'wss://in2.example/', 'wss://write.example/'].sort());
    expect(net.log.published.every((p) => p.kind === 10050)).toBe(true);
    expect(net.log.authed).toEqual(['wss://in1.example/']);
    expect(t.setup.state.listedOn.sort()).toEqual([...LOOKUP, 'wss://write.example/'].sort());
  });

  it('partial: one inbox relay refuses; failed: none accepts; unverified: not readable back', async () => {
    const part = setupWith(network({ 'wss://in2.example/': { write: 'no' } }));
    await part.setup.open();
    await part.setup.confirm();
    expect(part.setup.state).toMatchObject({ phase: 'partial', inboxFailed: ['wss://in2.example/'] });
    expect(part.adopted).toHaveLength(1);
    const allNo = Object.fromEntries([...LOOKUP, ...SUGGEST].map((r) => [r, { write: 'no' as const }]));
    const none = setupWith(network(allNo));
    await none.setup.open();
    await none.setup.confirm();
    expect(none.setup.state.phase).toBe('failed');
    expect(none.adopted).toHaveLength(0);
    const inboxesRefuse = setupWith(network(Object.fromEntries(SUGGEST.map((r) => [r, { write: 'no' as const }]))));
    await inboxesRefuse.setup.open();
    await inboxesRefuse.setup.confirm();
    expect(inboxesRefuse.setup.state.phase).toBe('failed');
    expect(inboxesRefuse.adopted).toHaveLength(0);
    const hidden = setupWith(network(Object.fromEntries(LOOKUP.map((r) => [r, { write: 'no' as const }]))));
    await hidden.setup.open();
    await hidden.setup.confirm();
    expect(hidden.setup.state.phase).toBe('unverified');
    expect(hidden.adopted).toHaveLength(0);
    // No retry of its own: still one signature.
    await new Promise((r) => setTimeout(r, 30));
    expect(hidden.ext.signed.filter((k) => k === 10050)).toHaveLength(1);
  });

  it('when the lookup relays do not answer, it will not risk replacing a list it could not see', async () => {
    const t = setupWith(network(Object.fromEntries(LOOKUP.map((r) => [r, { probe: 'down' as const }]))));
    await t.setup.open();
    await t.setup.confirm();
    expect(t.setup.state.phase).toBe('uncertain');
    expect(t.ext.signed).toEqual([]);
  });

  it('declined, nothing chosen, disconnected or switched mid-way: nothing published, nothing adopted', async () => {
    const net = network({});
    const denied = setupWith(net, extension({ deny: true }));
    await denied.setup.open();
    await denied.setup.confirm();
    expect(denied.setup.state.phase).toBe('declined');
    expect(net.log.published).toHaveLength(0);
    const empty = setupWith(network({}));
    await empty.setup.open();
    for (const u of SUGGEST) empty.setup.toggle(u);
    await empty.setup.confirm();
    expect(empty.ext.signed).toEqual([]);
    expect(empty.setup.state.message).toMatch(/at least one/);
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const net2 = network({});
    const gone = setupWith(net2, extension({ slow }));
    await gone.setup.open();
    const running = gone.setup.confirm();
    await new Promise((r) => setTimeout(r, 20));
    gone.setup.stop();
    release();
    await running;
    expect(net2.log.published).toHaveLength(0);
    expect(gone.adopted).toHaveLength(0);
  });

  it('the inbox AUTH signer never signs the game server’s proof', async () => {
    const net = network({ 'wss://in1.example/': { write: 'auth' } });
    const ext = extension();
    const mine = list(['wss://in1.example/']);
    // A relay that tried to get the game proof signed: its template names the game server, not a target.
    const evil: PublishPoolLike = { publish: (relays, _e, params) => relays.map(async () => (await params!.onauth!(makeAuthEvent('wss://rumble.example/ws', 'game')), 'ok')) };
    const r = await publishInboxList(evil, mine, ME, ['wss://in1.example'], ext.s);
    expect(r.accepted).toEqual([]);
    expect(ext.signed).toEqual([]);
    expect(net).toBeDefined();
  });
});
