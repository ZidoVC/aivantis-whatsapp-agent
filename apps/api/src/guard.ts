/**
 * Defensive request guards for the /whatsapp webhook:
 *   - clampMessage: cap inbound message size BEFORE it reaches the model (token-cost + abuse).
 *   - RateLimiter: per-phone and global request caps so a flood cannot run up Claude API cost
 *     or take the service down.
 *
 * Both are pure/injectable so they are unit-tested without a server. The RateLimiter keeps state
 * IN MEMORY per process (same single-instance caveat as coalescer.ts) — a multi-instance deploy
 * needs a shared store (e.g. Redis). Documented in docs/security-posture.md.
 */

export interface ClampResult {
  text: string;
  truncated: boolean;
}

/** Truncate an oversized message to `maxLen` chars (maxLen <= 0 disables clamping). */
export function clampMessage(text: string, maxLen: number): ClampResult {
  const s = (text ?? "").toString();
  if (maxLen > 0 && s.length > maxLen) return { text: s.slice(0, maxLen), truncated: true };
  return { text: s, truncated: false };
}

/** Max inbound message length from env (default 1600 — a WhatsApp text is ≤~1600 chars). */
export function maxMessageLength(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MAX_MESSAGE_LENGTH);
  return Number.isFinite(n) && n > 0 ? n : 1600;
}

export interface RateLimitConfig {
  /** Max requests per window per phone (0 = unlimited). */
  perPhone: number;
  /** Max requests per window across all phones (0 = unlimited). */
  global: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  scope?: "phone" | "global";
}

/**
 * Sliding-window rate limiter. `check` records the request and returns whether it is allowed.
 * `now` is injected (ms epoch) so it is fully deterministic in tests.
 */
export class RateLimiter {
  private readonly perPhoneHits = new Map<string, number[]>();
  private globalHits: number[] = [];

  constructor(private readonly cfg: RateLimitConfig) {}

  check(phone: string, now: number): RateLimitResult {
    const cutoff = now - this.cfg.windowMs;

    this.globalHits = this.globalHits.filter((t) => t > cutoff);
    if (this.cfg.global > 0 && this.globalHits.length >= this.cfg.global) {
      return { allowed: false, scope: "global" };
    }

    const hits = (this.perPhoneHits.get(phone) ?? []).filter((t) => t > cutoff);
    if (this.cfg.perPhone > 0 && hits.length >= this.cfg.perPhone) {
      this.perPhoneHits.set(phone, hits);
      return { allowed: false, scope: "phone" };
    }

    hits.push(now);
    this.perPhoneHits.set(phone, hits);
    this.globalHits.push(now);
    return { allowed: true };
  }
}

/** Build a RateLimiter from env with sane defaults (per-phone 20/min, global 600/min). */
export function rateLimiterFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimiter {
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  return new RateLimiter({
    perPhone: num(env.RATE_LIMIT_PER_PHONE, 20),
    global: num(env.RATE_LIMIT_GLOBAL, 600),
    windowMs: num(env.RATE_LIMIT_WINDOW_MS, 60_000),
  });
}
