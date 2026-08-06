export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, { count: number; resetsAt: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(
    limit: number,
    windowMs: number,
    maxKeys = 10_000,
    now: () => number = Date.now,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowMs) || windowMs < 1) {
      throw new Error("Rate limit and window must be positive integers.");
    }
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.now = now;
  }

  consume(key: string): boolean {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (bucket && bucket.resetsAt <= now) {
      this.buckets.delete(key);
      bucket = undefined;
    }
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) this.prune(now);
      if (this.buckets.size >= this.maxKeys) return false;
      this.buckets.set(key, { count: 1, resetsAt: now + this.windowMs });
      return true;
    }
    if (bucket.count >= this.limit) return false;
    bucket.count++;
    return true;
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) if (bucket.resetsAt <= now) this.buckets.delete(key);
  }
}
