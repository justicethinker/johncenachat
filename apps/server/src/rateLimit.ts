import type { Clock } from "./clock.js";

/** Token bucket: `ratePerSecond` tokens refill up to `burst` capacity. */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly clock: Clock,
    private readonly ratePerSecond: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
    this.lastRefill = clock.now();
  }

  tryConsume(): boolean {
    const now = this.clock.now();
    const elapsed = now - this.lastRefill;
    if (elapsed > 0) {
      this.tokens = Math.min(this.burst, this.tokens + (elapsed * this.ratePerSecond) / 1000);
      this.lastRefill = now;
    }
    if (this.tokens < 1) {
      return false;
    }
    this.tokens -= 1;
    return true;
  }
}

/**
 * Fixed-window counter keyed by an in-memory string (e.g. a socket address).
 * Entries expire after `windowMs` and are pruned by the reaper. Never logged.
 */
export class WindowCounter {
  private readonly entries = new Map<string, { count: number; start: number }>();

  constructor(
    private readonly clock: Clock,
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true (and consumes one unit) when `key` is below the limit. */
  allow(key: string): boolean {
    const now = this.clock.now();
    let entry = this.entries.get(key);
    if (!entry || now - entry.start >= this.windowMs) {
      entry = { count: 0, start: now };
      this.entries.set(key, entry);
    }
    if (entry.count >= this.limit) {
      return false;
    }
    entry.count += 1;
    return true;
  }

  prune(): void {
    const now = this.clock.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.start >= this.windowMs) {
        this.entries.delete(key);
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
