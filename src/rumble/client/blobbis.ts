/**
 * THE PLAYER'S BLOBBIS (M9A): which Blobbis the connected Nostr identity owns,
 * and which one they would like Rumble to use. Discovery, ownership and a
 * local choice only: nothing here is published, nothing here changes a
 * Blobbi, and (in this milestone) nothing here changes the fighter yet.
 *
 * The event model is the ecosystem's (`@blobbi-kit/core`, as nostr-pet and
 * Blobbi Island use it):
 *
 *   kind 31124   ONE Blobbi: an addressable event at (owner pubkey, d), where
 *                d = blobbi-<12 hex of the owner>-<10 hex pet id>. Every
 *                version of a Blobbi (egg, baby, adult, each care) is a
 *                replacement at the same address: the newest wins. The
 *                author IS the owner; a 31124 by anyone else is another
 *                address, whatever its tags claim.
 *   kind 11125   the player's profile (owned list `has`, `current_companion`,
 *                XP): metadata, never a Blobbi, and `has` may lag. Not read
 *                here; 31125 is its deprecated twin; 1124 is an interaction
 *                log. None of them lists a Blobbi.
 *
 * Listing, exactly as the kit's own collection does: ask for kind 31124 by
 * this author with the ecosystem marker, keep only what the kit calls
 * MODERN (legacy and invalid events are hidden, never migrated), keep the
 * newest per d, parse. Every event is signature-checked again here.
 *
 * The choice is one `d` in localStorage under this identity's pubkey. It
 * is the player's intent, and only the player removes it (Use the default
 * fighter): a relay that is down, slow, partial or simply does not hold the
 * event proves nothing about the Blobbi, so a choice that cannot be
 * resolved right now is kept, said so, and tried again (once by itself,
 * then on Look again); the form returns by itself when it is found.
 */
import { BLOBBI_ECOSYSTEM_NAMESPACE, KIND_BLOBBI_STATE, getBlobbiVisualIdentity, isModernBlobbiEvent, parseModernBlobbiEvent, type BlobbiStage, type BlobbiVisualGeneration, type BlobbiVisualIdentity } from '@blobbi-kit/core';
import type { NostrEvent } from 'nostr-tools/pure';
import { isPubkey } from '../../social/keys';
import type { BoundedPool } from '../../social/pool';
import { cleanText } from '../../social/profile';
import { verifyFresh } from '../../social/verify';

export const BLOBBIS = Object.freeze({
  /** Blobbi state events asked for (one per Blobbi on a relay: addressable). */
  fetchLimit: 200,
  /** Longest kept name, code points. */
  maxName: 32,
  /** How long discovery waits for the Blobbi relay's complete answer, ms (a cold connection included). */
  waitMs: 8000,
  /** One automatic retry after an unanswered discovery, after this long, ms; then only Look again. */
  retryMs: 5000,
});

/**
 * Where Blobbi state lives. relay.ditto.pub is the one relay the ecosystem's
 * own audit found serving kinds 31124 / 11125 (nostr-pet's BASE_RELAYS also
 * name primal and nostr.band, which index none of them). Dev: ?blobbi-relays=.
 */
export const BLOBBI_RELAYS: readonly string[] = Object.freeze(['wss://relay.ditto.pub']);

export interface OwnedBlobbi {
  /** The address part that names this Blobbi (with the owner's pubkey). */
  d: string;
  name: string;
  stage: BlobbiStage;
  generation: BlobbiVisualGeneration;
  /** What a renderer draws from (the kit's projection; V3 carries its seed). */
  visual: BlobbiVisualIdentity;
  /** The state event's time. */
  updatedAt: number;
  /** Whether Rumble's 3D fighter can be built from it (procedural, V3). V1 / V2 are 2D artwork. */
  rumbleReady: boolean;
  /** The event names a visual generation this app does not know (the kit would read it as V1): shown, not selectable. */
  unsupported: boolean;
}

const KNOWN_GENERATIONS: readonly string[] = ['v1', 'v2', 'v3'];

/** Newest per address, then the kit's parse; everything else dropped. Pure. */
export function collectBlobbis(events: readonly unknown[], me: string): OwnedBlobbi[] {
  const byD = new Map<string, NostrEvent>();
  for (const raw of events) {
    const ev = raw as NostrEvent;
    if (!verifyFresh(ev) || ev.kind !== KIND_BLOBBI_STATE || ev.pubkey !== me) continue;
    if (!ev.tags.some((t) => t[0] === 'b' && t[1] === BLOBBI_ECOSYSTEM_NAMESPACE)) continue;
    if (!isModernBlobbiEvent(ev)) continue;
    const d = ev.tags.find((t) => t[0] === 'd')?.[1];
    if (typeof d !== 'string' || !d) continue;
    const prev = byD.get(d);
    // NIP-01 addressable: the newest wins; on a tie, the lowest id.
    if (!prev || ev.created_at > prev.created_at || (ev.created_at === prev.created_at && ev.id < prev.id)) byD.set(d, ev);
  }
  const out: OwnedBlobbi[] = [];
  for (const ev of byD.values()) {
    let b: OwnedBlobbi | null = null;
    try {
      const c = parseModernBlobbiEvent(ev);
      if (!c) continue;
      const visual = getBlobbiVisualIdentity(c);
      const rawGen = ev.tags.find((t) => t[0] === 'visual_generation')?.[1];
      const unsupported = rawGen !== undefined && !KNOWN_GENERATIONS.includes(rawGen);
      b = { d: c.d, name: cleanText(c.name, BLOBBIS.maxName) ?? 'Unnamed Blobbi', stage: c.stage, generation: c.visualGeneration, visual, updatedAt: ev.created_at, rumbleReady: !unsupported && c.visualGeneration === 'v3' && !!visual.v3?.seed, unsupported };
    } catch {
      // The kit refused it: not shown.
    }
    if (b) out.push(b);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
}

export interface Discovery {
  blobbis: OwnedBlobbi[];
  /** Whether every relay asked sent its complete answer: only then does an empty list mean "none there". */
  answered: boolean;
}

/** The connected identity's Blobbis from the Blobbi relays. Read only. An unanswered query is not an empty answer. */
export async function findBlobbis(pool: BoundedPool, me: string, opts: { relays?: readonly string[]; waitMs?: number } = {}): Promise<Discovery> {
  if (!isPubkey(me)) return { blobbis: [], answered: true };
  const r = await pool.queryReport(opts.relays ?? BLOBBI_RELAYS, { kinds: [KIND_BLOBBI_STATE], authors: [me], '#b': [BLOBBI_ECOSYSTEM_NAMESPACE], limit: BLOBBIS.fetchLimit }, { maxWait: opts.waitMs ?? BLOBBIS.waitMs });
  return { blobbis: collectBlobbis(r.events, me), answered: r.asked.length > 0 && r.answered.length === r.asked.length };
}

// ─── The choice ─────────────────────────────────────────────────────────────

export type PickerPhase = 'idle' | 'loading' | 'ready' | 'none' | 'unreachable';

export interface PickerState {
  phase: PickerPhase;
  /** What the last complete answer listed (kept through an unanswered retry). */
  blobbis: OwnedBlobbi[];
  /** The chosen Blobbi's d, or null: the default Rumble fighter. Removed only by the player. */
  selected: string | null;
  /** The relays answered and the chosen Blobbi was not among them: the default fighter for now, the choice kept. */
  missing: boolean;
  /** Small pictures by d (data: URLs of the kit's SVG), as they are made. */
  previews: Record<string, string>;
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface PickerDeps {
  me: string;
  lookup: BoundedPool;
  relays?: readonly string[];
  storage: Store | null;
  /** Make a small picture for a Blobbi (null: no previews). */
  preview?: ((b: OwnedBlobbi) => Promise<string | null>) | null;
  /** The one automatic retry's delay, ms. */
  retryMs?: number;
  /** How long a discovery waits for the relays' complete answer, ms. */
  waitMs?: number;
  onChange?: () => void;
}

const KEY = (me: string) => `rumble:blobbi:v1:${me}`;
const D_SHAPE = /^blobbi-[0-9a-f]{12}-[0-9a-f]{10}$/;

export class BlobbiPicker {
  state: PickerState;
  private stopped = false;
  private gen = 0;
  private retried = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly d: PickerDeps) {
    this.state = { phase: 'idle', blobbis: [], selected: this.loadChoice(), missing: false, previews: {} };
  }

  private set(patch: Partial<PickerState>) {
    if (this.stopped) return;
    this.state = { ...this.state, ...patch };
    this.d.onChange?.();
  }

  /** Read the list once (the first time My Blobbis is on screen, or at once with a remembered choice); `again` re-reads (Look again). */
  async load(again = false): Promise<void> {
    if (this.stopped || (this.state.phase !== 'idle' && !again) || this.state.phase === 'loading') return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const g = ++this.gen;
    this.set({ phase: 'loading' });
    const r = await findBlobbis(this.d.lookup, this.d.me, { relays: this.d.relays, waitMs: this.d.waitMs });
    if (this.stopped || g !== this.gen) return;
    if (!r.answered) {
      // Nothing can be concluded: what was known stays, the choice stays, and one retry comes by itself.
      this.set({ phase: 'unreachable' });
      if (!this.retried) {
        this.retried = true;
        this.retryTimer = setTimeout(() => void this.load(true), this.d.retryMs ?? BLOBBIS.retryMs);
      }
      return;
    }
    const chosen = this.state.selected;
    const listed = chosen !== null && r.blobbis.some((b) => b.d === chosen && !b.unsupported);
    this.set({ phase: r.blobbis.length ? 'ready' : 'none', blobbis: r.blobbis, missing: chosen !== null && !listed });
    void this.makePreviews(r.blobbis, g);
  }

  /** Use this Blobbi (one of the listed ones) as the preferred Rumble character: local to this browser and identity. */
  select(d: string) {
    if (this.stopped || !this.state.blobbis.some((b) => b.d === d && !b.unsupported)) return;
    this.saveChoice(d);
    this.set({ selected: d, missing: false });
  }

  /** Back to the default Rumble fighter: the one way a remembered choice goes. */
  useDefault() {
    if (this.stopped) return;
    this.saveChoice(null);
    this.set({ selected: null, missing: false });
  }

  /** The chosen Blobbi, if it is listed. */
  get chosen(): OwnedBlobbi | null {
    return this.state.blobbis.find((b) => b.d === this.state.selected) ?? null;
  }

  private async makePreviews(blobbis: OwnedBlobbi[], g: number) {
    if (!this.d.preview) return;
    for (const b of blobbis) {
      let url: string | null = null;
      try {
        url = await this.d.preview(b);
      } catch {
        url = null;
      }
      if (this.stopped || g !== this.gen) return;
      if (url) this.set({ previews: { ...this.state.previews, [b.d]: url } });
    }
  }

  private loadChoice(): string | null {
    try {
      const v = this.d.storage?.getItem(KEY(this.d.me));
      return typeof v === 'string' && D_SHAPE.test(v) ? v : null;
    } catch {
      return null;
    }
  }

  private saveChoice(d: string | null) {
    try {
      if (d === null) this.d.storage?.removeItem(KEY(this.d.me));
      else this.d.storage?.setItem(KEY(this.d.me), d);
    } catch {
      // Storage blocked: the choice holds for this page only.
    }
  }

  /** The identity went away: nothing here updates again (the stored choice stays with its pubkey). */
  stop() {
    this.stopped = true;
    this.gen++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}
