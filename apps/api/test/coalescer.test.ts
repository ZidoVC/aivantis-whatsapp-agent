import { describe, it, expect } from "vitest";
import { coalesceWait, type CoalesceOptions } from "../src/coalescer";

const opts: CoalesceOptions = { debounceMs: 2000, maxWaitMs: 6000 };

describe("coalesceWait — debounce with a max-wait safety valve", () => {
  it("right after the first message → wait the full debounce window", () => {
    expect(coalesceWait(0, 0, 0, opts)).toBe(2000);
  });

  it("debounce gap elapsed since the last message → process now (0)", () => {
    expect(coalesceWait(0, 1000, 3000, opts)).toBe(0); // 3000 - 1000 = 2000 >= debounce
  });

  it("a new message resets the wait (still inside the debounce window)", () => {
    // first=0, last=1000, now=1500 → sinceLast=500 → 1500ms of debounce remain
    expect(coalesceWait(0, 1000, 1500, opts)).toBe(1500);
  });

  it("safety valve: total wait is capped at maxWaitMs even if messages keep arriving", () => {
    // messages still coming (last=5900) but 6s have passed since the first → process now
    expect(coalesceWait(0, 5900, 6000, opts)).toBe(0);
  });

  it("near the cap → returns the smaller of remaining-debounce and remaining-maxWait", () => {
    // sinceLast=200 (1800 debounce left), sinceFirst=5200 (800 maxWait left) → min = 800
    expect(coalesceWait(0, 5000, 5200, opts)).toBe(800);
  });

  it("never returns a negative wait", () => {
    expect(coalesceWait(0, 0, 10_000, opts)).toBe(0);
  });
});
