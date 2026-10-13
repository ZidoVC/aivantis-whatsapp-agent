import { supabase } from "./db";

/**
 * Surface the real Supabase/Postgrest error instead of silently returning null
 * (which previously showed up downstream as a cryptic "Cannot read properties of
 * null (reading 'id')"). Includes code/details/hint — e.g. a missing table or an
 * RLS policy blocking the anon key.
 */
function fail(context: string, error: { message: string; code?: string; details?: string; hint?: string }): never {
  throw new Error(
    `[memory] ${context} failed: ${error.message}` +
      ` (code=${error.code ?? "?"}, details=${error.details ?? ""}, hint=${error.hint ?? ""})`,
  );
}

/**
 * True when an error is "this column does not exist" — i.e. the 004 migration
 * (pending_action / tool_log) hasn't been applied yet. Lets the new features degrade
 * silently instead of breaking the live /whatsapp flow. Postgres undefined_column = 42703;
 * PostgREST schema-cache miss = PGRST204; both also mention the column name in the message.
 */
function isMissingColumn(error: { message?: string; code?: string }, column: string): boolean {
  if (error.code === "42703" || error.code === "PGRST204") return true;
  return !!error.message && error.message.toLowerCase().includes(column.toLowerCase());
}

export async function getConversation(phone: string, businessId: string) {
  // TODO(race-safety): once the unique(business_id, customer_phone) constraint exists
  // (supabase/002_schema_hardening.sql §A), replace this select-then-insert with an
  // upsert (insert ... on conflict (business_id, customer_phone) do nothing → re-select)
  // to be safe under concurrent messages from the same new customer. Deferred until the
  // current flow is verified end-to-end.
  const { data: existing, error: selectError } = await supabase
    .from("conversation")
    .select("*")
    .eq("business_id", businessId)
    .eq("customer_phone", phone)
    .maybeSingle();
  if (selectError) fail("select conversation", selectError);

  if (existing) return existing;

  const { data: created, error: insertError } = await supabase
    .from("conversation")
    .insert({ customer_phone: phone, business_id: businessId })
    .select("*")
    .single();
  if (insertError) fail("insert conversation", insertError);
  if (!created) {
    throw new Error(
      "[memory] insert conversation returned no row — an RLS policy is likely blocking the anon key from reading back the inserted row.",
    );
  }
  return created;
}

export async function saveMessage(
  conversationId: string,
  direction: "inbound" | "outbound",
  body: string,
  toolLog?: unknown[],
) {
  const base = { conversation_id: conversationId, direction, body };
  const row = toolLog && toolLog.length ? { ...base, tool_log: toolLog } : base;
  let { error } = await supabase.from("message").insert(row);
  // Defensive: if the tool_log column (004) isn't migrated yet, retry without it so the
  // message — and therefore the reply — still persists. Any other error is surfaced.
  if (error && "tool_log" in row && isMissingColumn(error, "tool_log")) {
    ({ error } = await supabase.from("message").insert(base));
  }
  if (error) fail("insert message", error);
}

/**
 * Persist (or clear, with null) the conversation's pending escalated change (Issue 1).
 * Defensive: if the pending_action column (004) isn't migrated yet, this is a no-op instead
 * of breaking the flow — the feature simply stays inert until the migration runs.
 */
export async function setPendingAction(conversationId: string, action: unknown | null) {
  const { error } = await supabase
    .from("conversation")
    .update({ pending_action: action })
    .eq("id", conversationId);
  if (error && isMissingColumn(error, "pending_action")) return;
  if (error) fail("update pending_action", error);
}

/**
 * Durable record of an escalation whose staff notification could NOT be delivered
 * (Twilio down / misconfigured / no phone). Lets us query "escalations that were never
 * delivered" — a silent miss on a medical complaint is the one failure we cannot have.
 *
 * LAST LINE OF DEFENSE: never throws. If the escalation_delivery table isn't migrated yet
 * (008) or the write is blocked, it logs LOUDLY under [escalation-notify-failed] rather than
 * crashing the fire-and-forget notification path.
 */
export async function recordEscalationDelivery(rec: {
  businessId: string;
  conversationId?: string | null;
  category: string;
  customerPhone: string;
  reason: string;
}): Promise<void> {
  try {
    const { error } = await supabase.from("escalation_delivery").insert({
      business_id: rec.businessId,
      conversation_id: rec.conversationId ?? null,
      category: rec.category,
      customer_phone: rec.customerPhone,
      reason: rec.reason,
      delivered: false,
    });
    if (error) {
      console.error(
        `[escalation-notify-failed] durable record write FAILED for category=${rec.category} ` +
          `customer=${rec.customerPhone} reason=${rec.reason}: ${error.message}` +
          ` (code=${error.code ?? "?"}) — this escalation may be UNTRACKED. ` +
          `Run supabase/008_escalation_delivery.sql if the table is missing.`,
      );
    }
  } catch (err) {
    console.error(
      `[escalation-notify-failed] durable record write THREW for category=${rec.category} ` +
        `customer=${rec.customerPhone} reason=${rec.reason}: ${(err as Error).message} — this escalation may be UNTRACKED.`,
    );
  }
}

/**
 * Look up the earliest lead for (business, phone). `phone` MUST already be normalized
 * (normalizePhone) so 05.../+9725... variants collapse to one row.
 */
export async function findLead(
  businessId: string,
  phone: string,
): Promise<{ id: string; created_at: string; status: string } | null> {
  const { data, error } = await supabase
    .from("lead")
    .select("id, created_at, status")
    .eq("business_id", businessId)
    .eq("customer_phone", phone)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) fail("select lead", error);
  return data ?? null;
}

/**
 * Deterministically capture a new lead (business-scoped). Caller checks findLead first;
 * a race window for two simultaneous first messages closes once migration 005 adds the
 * unique(business_id, customer_phone) constraint (then this becomes an upsert).
 */
export async function createLead(businessId: string, phone: string, note?: string): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from("lead")
    .insert({ business_id: businessId, customer_phone: phone, note: note ?? null, status: "open" })
    .select("id")
    .single();
  if (error) fail("insert lead", error);
  if (!data) throw new Error("[memory] insert lead returned no row — an RLS policy may be blocking read-back.");
  return data;
}

export async function getHistory(conversationId: string) {
  const { data, error } = await supabase
    .from("message")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  if (error) fail("select messages", error);

  return (data || []).map((m) => ({
    role: m.direction === "inbound" ? "user" : "assistant",
    content: m.body,
  }));
}
