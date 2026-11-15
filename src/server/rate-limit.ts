interface Bucket {
  startedAt: number;
  count: number;
}

export class ActionRateLimiter {
  private readonly sessions = new Map<string, Bucket>();
  private readonly ips = new Map<string, Bucket>();
  private global: Bucket = { startedAt: 0, count: 0 };

  constructor(
    private readonly limits = { session: 20, ip: 60, global: 300 },
    private readonly windowMs = 60_000,
  ) {}

  check(sessionId: string, ip: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    const session = this.use(this.sessions, sessionId, this.limits.session, now);
    const ipResult = this.use(this.ips, ip, this.limits.ip, now);
    const global = this.useBucket(this.global, this.limits.global, now);
    return {
      allowed: session.allowed && ipResult.allowed && global.allowed,
      retryAfterSeconds: Math.max(session.retryAfterSeconds, ipResult.retryAfterSeconds, global.retryAfterSeconds),
    };
  }

  private use(map: Map<string, Bucket>, key: string, limit: number, now: number) {
    const current = map.get(key) ?? { startedAt: now, count: 0 };
    map.set(key, current);
    return this.useBucket(current, limit, now);
  }

  private useBucket(bucket: Bucket, limit: number, now: number) {
    if (now - bucket.startedAt >= this.windowMs) {
      bucket.startedAt = now;
      bucket.count = 0;
    }
    bucket.count += 1;
    return {
      allowed: bucket.count <= limit,
      retryAfterSeconds: Math.max(1, Math.ceil((this.windowMs - (now - bucket.startedAt)) / 1000)),
    };
  }
}
