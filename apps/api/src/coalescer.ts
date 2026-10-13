/**
 * Deterministic per-conversation message coalescing / debounce (Issue 5).
 *
 * Rapid inbound messages from one conversation ("העע" then "היי" a second later) are merged
 * into ONE agent turn with ONE reply, instead of firing a separate reply per webhook. The
 * lead handler waits out a quiet window (extending as more messages arrive, capped by a
 * safety valve), then processes the merged history once. Absorbed follow-ups return empty
 * TwiML immediately (never held), so no webhook approaches Twilio's ~15s timeout.
 *
 * State is in-memory and PER PROCESS — see the single-instance caveat in PROJECT_CONTEXT §4;
 * a shared lock (e.g. Redis) is required before a multi-instance deploy.
 */

export interface CoalesceOptions {
  /** Quiet gap after the last message before processing. */
  debounceMs: number;
  /** Hard cap on total coalescing wait — a customer typing many rapid messages is answered
   *  after at most this long, never indefinitely. */
  maxWaitMs: number;
}

/** Tunable from the field without a code change (MESSAGE_DEBOUNCE_MS / MESSAGE_MAX_WAIT_MS). */
export function envCoalesceOptions(): CoalesceOptions {
  return {
    debounceMs: Number(process.env.MESSAGE_DEBOUNCE_MS) || 2000,
    maxWaitMs: Number(process.env.MESSAGE_MAX_WAIT_MS) || 6000,
  };
}

/**
 * PURE, unit-tested core: how many ms the lead handler should still wait, given the burst's
 * first/last message timestamps and `now`. Returns 0 when it should process now — either the
 * debounce gap since the last message elapsed, OR the max-wait safety valve tripped.
 */
export function coalesceWait(firstAt: number, lastAt: number, now: number, opts: CoalesceOptions): number {
  const sinceLast = now - lastAt;
  const sinceFirst = now - firstAt;
  if (sinceLast >= opts.debounceMs || sinceFirst >= opts.maxWaitMs) return 0;
  return Math.max(0, Math.min(opts.debounceMs - sinceLast, opts.maxWaitMs - sinceFirst));
}

interface Burst {
  firstAt: number;
  lastAt: number;
}
const bursts = new Map<string, Burst>();

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Record an inbound message. "lead" → the caller debounces + processes this burst; "absorbed"
 * → another handler is already coalescing this conversation, so the caller must reply with
 * empty TwiML immediately (the lead handler's single reply covers this message too).
 */
export function registerInbound(conversationId: string, now = Date.now()): "lead" | "absorbed" {
  const existing = bursts.get(conversationId);
  if (existing) {
    existing.lastAt = now; // extend the quiet window
    return "absorbed";
  }
  bursts.set(conversationId, { firstAt: now, lastAt: now });
  return "lead";
}

/** Lead handler: block until the burst goes quiet (or the safety valve trips). */
export async function awaitBurstQuiet(
  conversationId: string,
  opts: CoalesceOptions = envCoalesceOptions(),
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<void> {
  const b = bursts.get(conversationId);
  if (!b) return;
  for (;;) {
    const waitFor = coalesceWait(b.firstAt, b.lastAt, Date.now(), opts);
    if (waitFor <= 0) return;
    await sleep(waitFor);
  }
}

/** Always call this once the lead handler is done (in a finally), to free the conversation. */
export function releaseBurst(conversationId: string): void {
  bursts.delete(conversationId);
}
