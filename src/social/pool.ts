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

/** The part of nostr-tools' SimplePool this needs (and tests fake). `subscribeMany` is what a reporting query needs; without it the report is conservative. */
export interface PoolLike {
  querySync(relays: string[], filter: Filter, params?: { maxWait?: number }): Promise<NostrEvent[]>;
  subscribeMany?(relays: string[], filter: Filter, params: { onevent: (e: NostrEvent) => void; oneose?: () => void; onclose?: (reasons: { url: string; reason: string }[]) => void; maxWait?: number }): { close: (reason?: string) => void };
  close(relays: string[]): void;
}

/** A query's answer with what it is worth: `answered` are the relays that sent their complete stored answer (EOSE) in time. */
export interface QueryReport {
  events: NostrEvent[];
  /** Relays whose stored answer arrived complete. Empty: nothing can be concluded from an empty `events`. */
  answered: string[];
  /** Relays this query went to (admitted); [] when none could be. */
  asked: string[];
}

/** The longest any reporting query may wait, ms. */
export const REPORT_MAX_WAIT = 12_000;

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

  /**
   * Like `query`, and says which relays ANSWERED: a relay counts only when
   * it sent its complete stored answer (EOSE) within `maxWait`; a relay that
   * was down, refused, timed out or is still sending does not. So an empty
   * `events` with no `answered` relay means "unknown", never "none".
   * Never throws.
   */
  async queryReport(relays: readonly string[], filter: Filter, opts: { maxWait?: number } = {}): Promise<QueryReport> {
    const use = this.admit(relays);
    if (!use.length) return { events: [], answered: [], asked: [] };
    const wait = Math.min(opts.maxWait ?? this.maxWait, REPORT_MAX_WAIT);
    this.queries += 1;
    for (const u of use) this.open.get(u)!.busy += 1;
    try {
      if (!this.pool.subscribeMany) {
        // No per-relay report possible: an answer with events is taken as answered, an empty one as unknown.
        const events = await this.pool.querySync(use, filter, { maxWait: wait });
        return { events, answered: events.length ? [...use] : [], asked: [...use] };
      }
      return await new Promise<QueryReport>((resolve) => {
        const events: NostrEvent[] = [];
        let settled = false;
        let sub: { close: (reason?: string) => void } | null = null;
        const settle = (reasons: { url: string; reason: string }[]) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            sub?.close('done');
          } catch {
            // Already closed.
          }
          resolve({ events, answered: reasons.filter((r) => r.reason === 'done').map((r) => r.url), asked: [...use] });
        };
        // Our own clock decides: a relay still silent when it fires has not answered (nostr-tools' own EOSE timeout is set later than this).
        const timer = setTimeout(() => settle([]), wait);
        sub = this.pool.subscribeMany!(use, filter, {
          onevent: (e) => void events.push(e),
          // Every relay sent EOSE (or closed): close with our own reason, which marks the ones that really answered.
          oneose: () => void sub?.close('done'),
          onclose: (reasons) => settle(reasons),
          maxWait: wait + 2000,
        });
      });
    } catch {
      return { events: [], answered: [], asked: [...use] };
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
