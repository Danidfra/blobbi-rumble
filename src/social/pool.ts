/**
 * A BOUNDED RELAY POOL: nostr-tools' SimplePool (which opens a socket per
 * relay it is asked to use and keeps it) with a hard cap on open relays and
 * an idle close. A query asks for some relays; the pool admits as many as
 * fit, closing the least recently used idle relay to make room, and simply
 * leaves out the rest (a lookup on fewer relays is fine; a page with
 * dozens of sockets is not). Relays nothing has used for `idleMs` are
 * closed by `sweep()`.
 *
 * Relays are never gameplay: queries are async, best effort, time-boxed,
 * and an empty answer (all relays down) is a normal result.
 * Framework-free; no Rumble imports.
 */
import type { Filter } from 'nostr-tools/filter';
import type { NostrEvent } from 'nostr-tools/pure';
import { RELAY_LIMITS, relayUrl } from './relays';

/** The part of nostr-tools' SimplePool this needs (and tests fake). */
export interface PoolLike {
  querySync(relays: string[], filter: Filter, params?: { maxWait?: number }): Promise<NostrEvent[]>;
  close(relays: string[]): void;
}

export interface BoundedPoolOptions {
  maxOpen?: number;
  idleMs?: number;
  /** Longest a query waits for its relays, ms. */
  maxWait?: number;
  now?: () => number;
}

export class BoundedPool {
  readonly maxOpen: number;
  readonly idleMs: number;
  readonly maxWait: number;
  private readonly now: () => number;
  /** Open relays: when last used, and how many queries are on them now. */
  private readonly open = new Map<string, { used: number; busy: number }>();
  /** Most relays ever open at once (for tests and diagnostics). */
  peak = 0;
  queries = 0;

  constructor(
    private readonly pool: PoolLike,
    opts: BoundedPoolOptions = {},
  ) {
    this.maxOpen = opts.maxOpen ?? RELAY_LIMITS.maxOpen;
    this.idleMs = opts.idleMs ?? 30_000;
    this.maxWait = opts.maxWait ?? 4000;
    this.now = opts.now ?? (() => Date.now());
  }

  get openRelays(): string[] {
    return [...this.open.keys()];
  }

  /** Which of `relays` this query may use: the open ones, then new ones while there is room (closing idle ones for it). */
  admit(relays: readonly string[]): string[] {
    const wanted: string[] = [];
    for (const r of relays) {
      const u = relayUrl(r);
      if (u && !wanted.includes(u)) wanted.push(u);
    }
    const out: string[] = [];
    for (const url of wanted) {
      if (this.open.has(url)) {
        out.push(url);
        continue;
      }
      if (this.open.size >= this.maxOpen) {
        // Make room: the least recently used relay no query is on.
        let victim: string | null = null;
        let oldest = Infinity;
        for (const [u, s] of this.open) if (s.busy === 0 && !wanted.includes(u) && s.used < oldest) [victim, oldest] = [u, s.used];
        if (!victim) continue;
        this.closeRelay(victim);
      }
      this.open.set(url, { used: this.now(), busy: 0 });
      out.push(url);
    }
    this.peak = Math.max(this.peak, this.open.size);
    return out;
  }

  /** Events matching `filter` from (at most the admitted part of) `relays`; [] if none answer. Never throws. */
  async query(relays: readonly string[], filter: Filter, opts: { maxWait?: number } = {}): Promise<NostrEvent[]> {
    const use = this.admit(relays);
    if (!use.length) return [];
    this.queries += 1;
    for (const u of use) this.open.get(u)!.busy += 1;
    try {
      return await this.pool.querySync(use, filter, { maxWait: Math.min(opts.maxWait ?? this.maxWait, this.maxWait) });
    } catch {
      return [];
    } finally {
      const t = this.now();
      for (const u of use) {
        const s = this.open.get(u);
        if (s) {
          s.busy = Math.max(0, s.busy - 1);
          s.used = t;
        }
      }
    }
  }

  /** Close every relay idle for longer than idleMs. */
  sweep() {
    const t = this.now();
    for (const [u, s] of this.open) if (s.busy === 0 && t - s.used > this.idleMs) this.closeRelay(u);
  }

  /** Close idle relays (least recently used first) until `n` more connections fit under the cap (for a short-lived publish elsewhere). */
  makeRoom(n: number) {
    const idle = [...this.open.entries()].filter(([, s]) => s.busy === 0).sort((a, b) => a[1].used - b[1].used);
    while (this.open.size > Math.max(0, this.maxOpen - n) && idle.length) this.closeRelay(idle.shift()![0]);
  }

  /** Close everything (leaving the page, logging out). */
  closeAll() {
    for (const u of [...this.open.keys()]) this.closeRelay(u);
  }

  private closeRelay(url: string) {
    this.open.delete(url);
    try {
      this.pool.close([url]);
    } catch {
      // Already gone.
    }
  }
}
