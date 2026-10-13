import { Hono } from "hono";
import type { Context } from "hono";
import { serve } from "@hono/node-server";
import twilio from "twilio";
import { supabase } from "./db";
import { askAgent, type Msg, type AgentMeta, type PendingAction } from "./agent";
import { getConversation, saveMessage, getHistory, setPendingAction, recordEscalationDelivery } from "./memory";
import { resolveContact, liveContactDeps } from "./leads";
import { registerInbound, awaitBurstQuiet, releaseBurst } from "./coalescer";
import { isWithinBusinessHours } from "./gating";
import { notifyEscalation, twilioWhatsAppSender, checkEscalationChannelAtStartup } from "./escalation-notify";
import { rateLimiterFromEnv, clampMessage, maxMessageLength } from "./guard";

const app = new Hono();

// Anti-flood guards for /whatsapp. In-memory per process (single-instance caveat, see guard.ts).
const rateLimiter = rateLimiterFromEnv();
const MAX_MSG_LEN = maxMessageLength();

app.get("/health", (c) => c.json({ status: "ok" }));

// Debug-only: dumps the `business` table (incl. per-tenant Optima credentials).
// OFF by default so it is NEVER reachable through ngrok. Set ENABLE_DEBUG_ROUTES=true
// for LOCAL debugging only.
if (process.env.ENABLE_DEBUG_ROUTES === "true") {
  app.get("/db-test", async (c) => {
    const { data, error } = await supabase.from("business").select("*");
    if (error) return c.json({ ok: false, error: error.message });
    return c.json({ ok: true, businesses: data });
  });
}

/** Twilio signature validation is enforced by default; skipped only in dev/test
 *  (unless FORCE_TWILIO_VALIDATION=true). */
function twilioValidationEnabled(): boolean {
  const env = process.env.NODE_ENV;
  if (env === "development" || env === "test") {
    return process.env.FORCE_TWILIO_VALIDATION === "true";
  }
  return true;
}

/** Rebuild the PUBLIC url Twilio actually signed. ngrok terminates SSL and forwards
 *  http→localhost, so trust X-Forwarded-Proto/Host (or an explicit TWILIO_WEBHOOK_URL)
 *  instead of c.req.url, otherwise the signature check fails on protocol/host mismatch. */
function twilioWebhookUrl(c: Context): string {
  if (process.env.TWILIO_WEBHOOK_URL) return process.env.TWILIO_WEBHOOK_URL;
  const proto = c.req.header("x-forwarded-proto") ?? "https";
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "";
  const { pathname, search } = new URL(c.req.url);
  return `${proto}://${host}${pathname}${search}`;
}

function toParams(body: Record<string, unknown>): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    params[key] = typeof value === "string" ? value : String(value);
  }
  return params;
}

const port = Number(process.env.PORT) || 3001;
serve({ fetch: app.fetch, port });
console.log(`API running on port ${port}`);
// Loud one-time boot check: know the escalation channel is dead BEFORE a customer needs it.
checkEscalationChannelAtStartup();
// Startup visibility (A5a): is the application-level Optima card_id guard active this run?
console.log(
  `[booking-guard] Optima card_id guard: ${process.env.BOOKING_PROVIDER === "optima" ? "ACTIVE" : "inactive (BOOKING_PROVIDER != optima)"}`,
);
app.post("/login", async (c) => {
  const { email, password } = await c.req.json();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) return c.json({ ok: false, error: error.message });
  return c.json({ ok: true, user: data.user.email });
});

app.post("/whatsapp", async (c) => {
  const body = await c.req.parseBody();

  if (twilioValidationEnabled()) {
    const authToken = process.env.TWILIO_AUTH_TOKEN ?? "";
    const signature = c.req.header("x-twilio-signature") ?? "";
    const url = twilioWebhookUrl(c);

    // --- TEMP TWILIO DEBUG (remove once the 403 is resolved) ---
    const rebuiltFromHeaders = `${c.req.header("x-forwarded-proto") ?? "https"}://${
      c.req.header("x-forwarded-host") ?? c.req.header("host") ?? ""
    }${new URL(c.req.url).pathname}`;
    console.log("[twilio-debug] url used for validation :", JSON.stringify(url));
    console.log("[twilio-debug] TWILIO_WEBHOOK_URL env   :", JSON.stringify(process.env.TWILIO_WEBHOOK_URL ?? null));
    console.log("[twilio-debug] url rebuilt from headers :", JSON.stringify(rebuiltFromHeaders));
    console.log("[twilio-debug] X-Twilio-Signature recv  :", JSON.stringify(signature));
    console.log("[twilio-debug] auth token length        :", authToken.length, "(a real Twilio token is 32)");
    console.log("[twilio-debug] param keys               :", Object.keys(toParams(body)).join(", "));
    // --- /TEMP TWILIO DEBUG ---

    const valid = authToken.length > 0 && twilio.validateRequest(authToken, signature, url, toParams(body));
    console.log("[twilio-debug] validateRequest result   :", valid);
    if (!valid) {
      console.warn("Rejected /whatsapp — invalid or missing Twilio signature");
      return c.text("Invalid Twilio signature", 403);
    }
  }

  const from = String(body["From"]);
  const rawText = String(body["Body"]);

  // Rate limiting (anti-flood): a burst from one phone — or globally — must not run up Claude API
  // cost or take the service down. Checked BEFORE any DB write or model call, and returns empty
  // TwiML (200) so Twilio does not retry. In-memory per process (single-instance caveat).
  const rl = rateLimiter.check(from, Date.now());
  if (!rl.allowed) {
    console.warn(`[rate-limit] dropped inbound (scope=${rl.scope}) from ${from}`);
    c.header("Content-Type", "text/xml");
    return c.body('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }

  // Input hardening: cap message size before it reaches the model (token cost + abuse). Truncate
  // rather than reject so a genuinely long message still gets a reply.
  const { text, truncated } = clampMessage(rawText, MAX_MSG_LEN);
  if (truncated) {
    console.warn(`[input-clamp] truncated oversized inbound (${rawText.length} → ${MAX_MSG_LEN} chars) from ${from}`);
  }
  console.log(`הודעה מ-${from}: ${text}`);

  const businessId = process.env.DEFAULT_BUSINESS_ID;
  if (!businessId) {
    console.error("DEFAULT_BUSINESS_ID is not set in .env — cannot resolve a conversation.");
    return c.text("Server misconfigured: DEFAULT_BUSINESS_ID missing", 500);
  }

  const conv = await getConversation(from, businessId);
  await saveMessage(conv.id, "inbound", text);

  // Coalesce rapid messages (Issue 5): a follow-up that arrives while this conversation is
  // already being handled returns EMPTY TwiML immediately — its content is already saved and
  // is covered by the single in-flight reply. Nothing is held here, so no absorbed webhook
  // approaches Twilio's ~15s timeout.
  if (registerInbound(conv.id) === "absorbed") {
    c.header("Content-Type", "text/xml");
    return c.body('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }

  try {
    // Lead handler: wait out the debounce window (extends as more messages arrive, capped by
    // the safety valve), then process the whole coalesced burst as one turn.
    await awaitBurstQuiet(conv.id);

    // Deterministic contact resolution + lead capture (Issue 2), BEFORE the model runs — so a
    // lead is never lost and the agent always knows who it is talking to. Non-fatal: a capture
    // failure must never stop us from replying to the customer.
    let contactContext: string | undefined;
    try {
      const contact = await resolveContact(from, businessId, liveContactDeps);
      contactContext = contact.context;
      if (process.env.AGENT_DEBUG) console.error(`  [lead-capture] ${contact.status}`);
    } catch (err) {
      console.error("[lead-capture] error:", (err as Error).message);
    }

    const history = await getHistory(conv.id); // includes every message in the coalesced burst
    const pendingAction = (conv as { pending_action?: PendingAction | null }).pending_action ?? null;
    let meta: AgentMeta | undefined;
    const reply = await askAgent(history as Msg[], {
      pendingAction,
      contactContext,
      afterHours: !isWithinBusinessHours(new Date()),
      emit: (m) => {
        meta = m;
      },
    });

    // Persist the outbound reply + its tool-call audit, and update pending state (both defensive).
    await saveMessage(conv.id, "outbound", reply, meta?.toolLog);
    if (meta && meta.nextPendingAction !== undefined) {
      await setPendingAction(conv.id, meta.nextPendingAction);
    }

    // Staff notification for every escalation this turn. Deterministic (meta.escalations is set
    // from actual tool outcomes in agent.ts, never from the reply text) and fired AFTER the reply
    // is recorded above, so a notification can never make an escalation disappear. Fire-and-forget:
    // the customer's reply below is returned regardless of notification status, and notifyEscalation
    // is itself failure-safe (logs [escalation-notify-failed], never throws). On any delivery
    // failure it writes a durable "unnotified" record so we can query escalations never delivered.
    if (meta?.escalations?.length) {
      const send = twilioWhatsAppSender();
      const at = new Date();
      for (const category of meta.escalations) {
        void notifyEscalation(
          { category, customerMessage: text, customerPhone: from, at },
          {
            send,
            onUndelivered: ({ reason }) =>
              recordEscalationDelivery({ businessId, conversationId: conv.id, category, customerPhone: from, reason }),
          },
        ).catch((err) => console.error(`[escalation-notify-failed] unexpected: ${(err as Error).message}`));
      }
    }

    c.header("Content-Type", "text/xml");
    return c.body(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply}</Message></Response>`
    );
  } finally {
    releaseBurst(conv.id); // always free the conversation, even on error, to avoid a stuck burst
  }
});


