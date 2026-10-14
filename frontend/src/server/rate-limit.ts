// A small in-memory limiter: a token bucket per client (requests per minute, with a short
// burst) and a cap on uploads running at once per client. Memory is bounded: when more
// clients are tracked than allowed, the least recently seen idle ones are dropped.

export interface LimiterOptions {
  /** Sustained requests per minute per client. */
  perMinute: number;
  /** Bucket size: how many requests may arrive back to back. */
  burst: number;
  /** Uploads one client may have in progress at once. */
  maxConcurrent: number;
  /** Most clients remembered. */
  maxClients: number;
  /** Clock in milliseconds; replaceable in tests. */
  now?: () => number;
}

export type Refusal = { ok: false; reason: "rate" | "concurrent"; retryAfterSeconds: number };
export type Ticket = { ok: true; release: () => void };

interface Entry {
  tokens: number;
  updated: number;
  active: number;
  seen: number;
}

export class RateLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(private readonly options: LimiterOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Count one request for ``key``; the ticket must be released when the upload is over. */
  acquire(key: string): Ticket | Refusal {
    const time = this.now();
    const entry = this.entry(key, time);
    this.refill(entry, time);
    if (entry.active >= this.options.maxConcurrent) {
      return { ok: false, reason: "concurrent", retryAfterSeconds: 5 };
    }
    if (entry.tokens < 1) {
      const perSecond = this.options.perMinute / 60;
      return { ok: false, reason: "rate", retryAfterSeconds: Math.max(1, Math.ceil((1 - entry.tokens) / perSecond)) };
    }
    entry.tokens -= 1;
    entry.active += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        entry.active -= 1;
      },
    };
  }

  /** Number of clients currently remembered (for tests and diagnostics). */
  get size(): number {
    return this.entries.size;
  }

  private refill(entry: Entry, time: number): void {
    const elapsed = Math.max(0, time - entry.updated) / 1000;
    entry.tokens = Math.min(this.options.burst, entry.tokens + elapsed * (this.options.perMinute / 60));
    entry.updated = time;
  }

  private entry(key: string, time: number): Entry {
    let entry = this.entries.get(key);
    if (entry === undefined) {
      this.evict();
      entry = { tokens: this.options.burst, updated: time, active: 0, seen: time };
      this.entries.set(key, entry);
    }
    entry.seen = time;
    return entry;
  }

  /** Make room for one more client by dropping idle ones, least recently seen first. */
  private evict(): void {
    if (this.entries.size < this.options.maxClients) return;
    const idle = [...this.entries].filter(([, e]) => e.active === 0).sort((a, b) => a[1].seen - b[1].seen);
    for (const [key] of idle.slice(0, Math.max(1, Math.ceil(this.options.maxClients / 10)))) {
      this.entries.delete(key);
    }
  }
}
