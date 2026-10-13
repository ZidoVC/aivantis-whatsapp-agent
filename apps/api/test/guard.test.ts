import { describe, it, expect } from "vitest";
import { clampMessage, maxMessageLength, RateLimiter, rateLimiterFromEnv } from "../src/guard";

describe("clampMessage — input hardening (cap size before the model)", () => {
  it("passes a normal message through untouched", () => {
    expect(clampMessage("שלום, אני רוצה לקבוע תור", 1600)).toEqual({
      text: "שלום, אני רוצה לקבוע תור",
      truncated: false,
    });
  });
  it("truncates an oversized payload to the limit", () => {
    const huge = "x".repeat(5000);
    const out = clampMessage(huge, 1600);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBe(1600);
  });
  it("maxLen 0 disables clamping", () => {
    const huge = "x".repeat(5000);
    expect(clampMessage(huge, 0)).toEqual({ text: huge, truncated: false });
  });
  it("maxMessageLength reads env with a safe default", () => {
    expect(maxMessageLength({ MAX_MESSAGE_LENGTH: "500" })).toBe(500);
    expect(maxMessageLength({})).toBe(1600);
    expect(maxMessageLength({ MAX_MESSAGE_LENGTH: "-5" })).toBe(1600);
  });
});

describe("RateLimiter — per-phone + global caps", () => {
  const cfg = { perPhone: 3, global: 5, windowMs: 60_000 };

  it("allows up to the per-phone cap, then blocks that phone (scope=phone)", () => {
    const rl = new RateLimiter(cfg);
    const p = "whatsapp:+9721";
    expect(rl.check(p, 1000).allowed).toBe(true);
    expect(rl.check(p, 1001).allowed).toBe(true);
    expect(rl.check(p, 1002).allowed).toBe(true);
    const blocked = rl.check(p, 1003);
    expect(blocked.allowed).toBe(false);
    expect(blocked.scope).toBe("phone");
  });

  it("counts phones independently", () => {
    const rl = new RateLimiter(cfg);
    for (let i = 0; i < 3; i++) rl.check("whatsapp:+A", 1000 + i);
    // A is now at the cap, but B is fresh
    expect(rl.check("whatsapp:+A", 1004).allowed).toBe(false);
    expect(rl.check("whatsapp:+B", 1004).allowed).toBe(true);
  });

  it("blocks on the global cap even across different phones (scope=global)", () => {
    const rl = new RateLimiter({ perPhone: 100, global: 5, windowMs: 60_000 });
    for (let i = 0; i < 5; i++) expect(rl.check(`p${i}`, 1000 + i).allowed).toBe(true);
    const blocked = rl.check("p6", 1006);
    expect(blocked.allowed).toBe(false);
    expect(blocked.scope).toBe("global");
  });

  it("recovers after the window passes", () => {
    const rl = new RateLimiter(cfg);
    const p = "whatsapp:+9721";
    for (let i = 0; i < 3; i++) rl.check(p, 1000 + i);
    expect(rl.check(p, 1003).allowed).toBe(false);
    // advance beyond the window → old hits pruned
    expect(rl.check(p, 1000 + 60_001).allowed).toBe(true);
  });

  it("0 means unlimited for that dimension", () => {
    const rl = new RateLimiter({ perPhone: 0, global: 0, windowMs: 60_000 });
    for (let i = 0; i < 50; i++) expect(rl.check("p", 1000 + i).allowed).toBe(true);
  });

  it("rateLimiterFromEnv reads env with sane defaults", () => {
    const rl = rateLimiterFromEnv({ RATE_LIMIT_PER_PHONE: "2", RATE_LIMIT_GLOBAL: "0", RATE_LIMIT_WINDOW_MS: "1000" });
    expect(rl.check("p", 0).allowed).toBe(true);
    expect(rl.check("p", 1).allowed).toBe(true);
    expect(rl.check("p", 2).allowed).toBe(false); // per-phone=2
  });
});
