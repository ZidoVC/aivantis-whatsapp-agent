/**
 * Deterministic Gating layer (Stage 3) — the single source of truth for the
 * clinic's business rules, enforced in CODE (not just the system prompt) and not
 * bypassable by clever user phrasing. Every write-tool call routes through here
 * before it can reach the provider.
 *
 * These functions are PURE (no provider / network / clock access): the caller
 * supplies a fully-resolved context (built from read-only provider calls + config)
 * and a `now: Date`. That makes each rule independently unit-testable.
 *
 * Rule numbers refer to section 0 of the master build prompt.
 */

import type { AppointmentType } from "@aivantis/booking-provider";

/* --------------------------- escalation taxonomy -------------------------- */

export type EscalationCategory =
  | "medical_symptom" // rule 6 → DemoA / DemoB (targeted, not generic staff)
  | "general_complaint" // rule 7 → reception (Adi)
  | "sales_inquiry" // rule 5
  | "staff_approval_needed" // rule 2 (active series)
  | "reschedule_request" // rule 4
  | "late_cancellation"; // rule 8

export const ESCALATION_CATEGORIES: EscalationCategory[] = [
  "medical_symptom",
  "general_complaint",
  "sales_inquiry",
  "staff_approval_needed",
  "reschedule_request",
  "late_cancellation",
];

export interface EscalationRoute {
  to: string;
  note: string;
}

/**
 * Routing is CLINIC config (per-tenant in future); kept here for the DemoClinic
 * clinic. Note the targeted medical routing (rule 6) — not a generic "staff".
 */
export const ESCALATION_ROUTING: Record<EscalationCategory, EscalationRoute> = {
  medical_symptom: { to: "דנה / רות", note: "תלונה פיזית/רפואית — ישירות לדנה או רות, לא לקבלה" },
  general_complaint: { to: "קבלה (עדי)", note: "תלונה שירותית/כללית — לקבלה" },
  sales_inquiry: { to: "נציג אנושי", note: "פנייה מכירתית — לנציג, לא תיאום תור רגיל" },
  staff_approval_needed: { to: "צוות", note: "אישור צוות לקביעת הטיפול הבא בסדרה פעילה" },
  reschedule_request: { to: "פקידה", note: "שינוי/דחיית תור — תמיד ידני דרך הפקידה" },
  late_cancellation: { to: "צוות", note: "ביטול פחות מ-24 שעות לפני התור" },
};

export function isEscalationCategory(value: unknown): value is EscalationCategory {
  return typeof value === "string" && (ESCALATION_CATEGORIES as string[]).includes(value);
}

/* ---------------------- rule 1 + 3: consultation gate --------------------- */

export interface AppointmentGateContext {
  /** What the caller is trying to book. */
  requestedType: AppointmentType;
  /** undefined / isNewLead=true means the patient is not in the system. */
  patientId?: string;
  treatmentCode?: string;
  /** Not found via phone search → a new lead. */
  isNewLead: boolean;
  /** A completed consultation exists for THIS patient + THIS treatment_code. */
  consultationCompleted: boolean;
  /** Clinic override set in advance for THIS patient + THIS treatment_code. */
  clinicOverride: boolean;
  /** The requested treatment is the next session of an ACTIVE series for this patient. */
  activeSeries: boolean;
}

export interface AppointmentGateResult {
  allow: boolean;
  reason?: string;
  /** When set, the caller should offer/book this type instead (always "consultation"). */
  forceType?: AppointmentType;
  /** When set, route to a human with this category instead of booking. */
  escalate?: EscalationCategory;
}

/**
 * Rule 1: new lead → always consultation (no exception).
 * Rule 2: existing patient asking for the next session of an active series → staff approval.
 * Rule 3: existing patient, new treatment → consultation, unless a completed consultation
 *         OR an explicit (patient_id, treatment_code) clinic_override exists.
 * Default is ALWAYS consultation.
 */
export function gateAppointment(ctx: AppointmentGateContext): AppointmentGateResult {
  // Consultations are always allowed.
  if (ctx.requestedType === "consultation") return { allow: true };

  // Rule 1 — new lead can never book a treatment directly.
  if (ctx.isNewLead || !ctx.patientId) {
    return {
      allow: false,
      reason: "פונה חדש/ה — כל פנייה מתחילה בפגישת ייעוץ.",
      forceType: "consultation",
    };
  }

  // Rule 2 — next session of an active series requires staff approval (not booked directly).
  if (ctx.activeSeries) {
    return {
      allow: false,
      reason: "הטיפול הבא בסדרה פעילה דורש אישור צוות לפני קביעה.",
      escalate: "staff_approval_needed",
    };
  }

  // Rule 3 — existing patient, new treatment.
  if (ctx.consultationCompleted || ctx.clinicOverride) {
    return { allow: true };
  }
  return {
    allow: false,
    reason: "טיפול מחייב פגישת ייעוץ קודם (אלא אם יש אישור מפורש מהקליניקה).",
    forceType: "consultation",
  };
}

/* ------------------------- rule 3: clinic overrides ----------------------- */

/**
 * Overrides are checked at (patient_id, treatment_code) granularity — never blanket
 * for all of a patient's treatments. Clinic config (per-tenant in future).
 */
export const CLINIC_OVERRIDES: ReadonlySet<string> = new Set<string>([
  "1001:botox", // demo: veteran client, repeat botox pre-approved for direct booking
]);

export function hasClinicOverride(patientId: string, treatmentCode: string): boolean {
  return CLINIC_OVERRIDES.has(`${patientId}:${treatmentCode}`);
}

/* ------------------- rule 4 + 8: reschedule / cancellation ---------------- */

/** Hours from `now` until `target` (negative if in the past). */
export function hoursBetween(now: Date, target: Date): number {
  return (target.getTime() - now.getTime()) / 3_600_000;
}

export interface RescheduleResult {
  /** Reschedules are NEVER automatic — always handed to a human. */
  escalate: "reschedule_request";
  urgency: "within_48h" | "standard";
}

/** Rule 4 — a reschedule request is only ever staged + escalated, never applied. */
export function gateReschedule(appointmentStart: Date, now: Date): RescheduleResult {
  return {
    escalate: "reschedule_request",
    urgency: hoursBetween(now, appointmentStart) < 48 ? "within_48h" : "standard",
  };
}

export type CancellationResult =
  | { allow: true }
  | { allow: false; escalate: "late_cancellation"; message: string };

/** Rule 8 — cancellations < 24h before the appointment are escalated, not auto-cancelled. */
export function gateCancellation(appointmentStart: Date, now: Date): CancellationResult {
  if (hoursBetween(now, appointmentStart) >= 24) return { allow: true };
  return {
    allow: false,
    escalate: "late_cancellation",
    message: "ביטול פחות מ-24 שעות לפני התור — ייתכן שהתור יחויב בהתאם לטופס ההסכמה.",
  };
}

/* ----------------------- rule 5 + 6 + 7: classifier ----------------------- */

const MEDICAL_SYMPTOM_KEYWORDS = [
  "כואב", "כאב", "שורף", "צורב", "נפוח", "נפיחות", "דימום", "מדמם", "אדמומיות",
  "אדום", "גירוד", "מגרד", "אלרגי", "אלרגיה", "תגובה", "חום", "מוגלה", "זיהום", "כוויה",
];

// Haggle / upsell only. Plain price questions ("כמה עולה", "מחיר") were REMOVED here — they
// are handled deterministically by rule 10 (classifyPriceIntent), not escalated as sales.
const SALES_KEYWORDS = [
  "לקנות עוד", "לרכוש עוד", "עוד סדרה", "סדרה נוספת", "חבילה נוספת", "עוד חבילה",
  "מה עוד יש", "מה עוד יש לכם", "שדרוג", "לשדרג", "עוד טיפולים",
  "הנחה", "מבצע", "יקר", "זול יותר", "מחיר סופי",
];

const GENERAL_COMPLAINT_KEYWORDS = [
  "מאוכזב", "מאוכזבת", "אכזבה", "לא מרוצה", "לא מרוצת", "תלונה", "שירות גרוע",
  "יחס גרוע", "לא מקצועי", "חוויה גרועה", "מתלונן", "מתלוננת",
];

// Appointment-change intents are detected as (verb + appointment noun) co-occurrence,
// so phrasing like "להעביר לי את התור" (words not adjacent) is still caught.
const RESCHEDULE_VERBS = ["להעביר", "לשנות", "לדחות", "להזיז"];
const CANCEL_VERBS = ["לבטל", "ביטול"];
const APPOINTMENT_NOUNS = ["תור", "מועד", "פגישה"];

/**
 * Best-effort deterministic classification of a CUSTOMER message to an escalation
 * category. Returns exactly ONE category (highest priority) so a mixed message never
 * fires two escalations. Priority (safety first):
 *   medical → cancellation → reschedule → sales → general complaint.
 * Returns undefined when nothing matches (no escalation intent).
 */
export function classifyEscalation(text: string): EscalationCategory | undefined {
  const t = (text ?? "").toString();
  const mentionsAppointment = APPOINTMENT_NOUNS.some((n) => t.includes(n));

  if (MEDICAL_SYMPTOM_KEYWORDS.some((k) => t.includes(k))) return "medical_symptom";
  if (mentionsAppointment && CANCEL_VERBS.some((v) => t.includes(v))) return "late_cancellation";
  if (mentionsAppointment && RESCHEDULE_VERBS.some((v) => t.includes(v))) return "reschedule_request";
  if (SALES_KEYWORDS.some((k) => t.includes(k))) return "sales_inquiry";
  if (GENERAL_COMPLAINT_KEYWORDS.some((k) => t.includes(k))) return "general_complaint";
  return undefined;
}

/* ------------------------------- rule 10: pricing ------------------------- */

/** The consultation price the agent MAY state — the single price exception. One source of truth. */
export const CONSULTATION_PRICE_ILS = 100;

export type PriceIntent = "consultation_price" | "treatment_price";

const PRICE_QUESTION_RE = /(כמה עולה|כמה זה עולה|כמה יעלה|מה המחיר|המחיר של|מה העלות|עלות של|כמה זה)/;
const CONSULTATION_WORD_RE = /ייעוץ|יעוץ/;

/**
 * Classify a price question (rule 10): about the CONSULTATION (we may quote CONSULTATION_PRICE_ILS)
 * or about a TREATMENT (deflect to a consultation, never quote a number). null = not a price
 * question — haggling/discount is a separate path (classifyEscalation → sales_inquiry, rule 5).
 */
export function classifyPriceIntent(text: string): PriceIntent | null {
  const t = (text ?? "").toString();
  if (!PRICE_QUESTION_RE.test(t)) return null;
  return CONSULTATION_WORD_RE.test(t) ? "consultation_price" : "treatment_price";
}

// A price token: a number adjacent to a currency marker.
const PRICE_TOKEN_RE = /(\d[\d,]*)\s*(?:₪|ש"?ח|שקל|שקלים)|₪\s*(\d[\d,]*)/g;

/**
 * Deterministic guardrail (telemetry-first): a reply to a TREATMENT-price question that names a
 * concrete price OTHER than the consultation price is a leak — treatment prices are set in the
 * consultation, never quoted. Returns true to flag; the caller logs it and does not rewrite.
 */
export function detectTreatmentPriceLeak(reply: string, priceIntent: PriceIntent | null): boolean {
  if (priceIntent !== "treatment_price") return false;
  for (const m of (reply ?? "").toString().matchAll(PRICE_TOKEN_RE)) {
    const digits = (m[1] ?? m[2] ?? "").replace(/,/g, "");
    if (digits && Number(digits) !== CONSULTATION_PRICE_ILS) return true;
  }
  return false;
}

/* ------------------------------ business hours ---------------------------- */

// PROVISIONAL clinic hours (Asia/Jerusalem) — REAL hours are unconfirmed (Tue/Fri uncertain per
// the Optima field intel; Demo contact confirms Monday). Best-effort default, not gospel. 0=Sun … 6=Sat.
const BUSINESS_HOURS: Record<number, [number, number] | null> = {
  0: [9, 19],
  1: [9, 19],
  2: [9, 19],
  3: [9, 19],
  4: [9, 19],
  5: [9, 14],
  6: null, // Saturday closed
};

/** Pure core — is (day-of-week, hour) within provisional clinic hours? Unit-tested. */
export function withinHours(dow: number, hour: number): boolean {
  const w = BUSINESS_HOURS[dow];
  return !!w && hour >= w[0] && hour < w[1];
}

function israelParts(instant: Date): { dow: number; hour: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem",
    weekday: "short",
    hour: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(instant)) parts[p.type] = p.value;
  const days: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { dow: days[parts.weekday] ?? 0, hour: parts.hour === "24" ? 0 : Number(parts.hour) };
}

/** Whether `now` (a UTC instant) falls within provisional clinic hours, Israel-local. */
export function isWithinBusinessHours(now: Date): boolean {
  const { dow, hour } = israelParts(now);
  return withinHours(dow, hour);
}

/* ----------------- booking-intent detection + enforcement ---------------- */

// A NEW-appointment / consultation booking intent = a "make/schedule" verb co-occurring
// with an appointment noun. Kept SEPARATE from reschedule ("להעביר"/"לשנות") and cancel
// ("לבטל"), which carry their own escalation categories and must NOT count as a new booking.
const NEW_BOOKING_VERBS = ["לקבוע", "לתאם", "לזמן"];
const BOOKING_NOUNS = ["תור", "פגישה", "ייעוץ", "מועד"];

/**
 * True when a CUSTOMER message asks to book/schedule a new appointment or consultation
 * (create-verb + appointment-noun). Used to enforce — in code, not via prompt — that a
 * mixed "escalation + booking" message still advances the booking half even if the model's
 * reply dropped it. Deliberately does NOT match reschedule/cancel phrasing.
 */
export function hasNewBookingRequest(text: string): boolean {
  const t = (text ?? "").toString();
  return NEW_BOOKING_VERBS.some((v) => t.includes(v)) && BOOKING_NOUNS.some((n) => t.includes(n));
}

/**
 * Whether a reply already references booking/consultation. This is the SAME pattern used by
 * scenario 7's assert in scripts/run-test-scenarios.ts — exported here so the enforcement and
 * the test share one definition and can never drift apart.
 */
export const BOOKING_MENTION_RE = /(תור|ייעוץ|לקבוע|לתאם|זמין|לזמן)/;

/**
 * Remove any booking-pivot segment (a paragraph/sentence that mentions a תור/ייעוץ) from a
 * reply. The deterministic INVERSE of the Case-A booking-net: the agent (`agent.ts`) calls this
 * ONLY when the turn escalated a medical_symptom and the customer did NOT ask to book — so
 * offering an appointment next to a pain complaint (tone-deaf) is stripped, not just flagged.
 * Never empties the reply: if every segment mentions booking, the original is returned unchanged.
 */
export function stripBookingPivot(reply: string): string {
  const text = (reply ?? "").toString();
  if (!BOOKING_MENTION_RE.test(text)) return text; // nothing to strip → identical reply
  // Split into segments on line breaks AND sentence enders, drop any that mention booking.
  const segments = text.split(/\n+|(?<=[.!?])\s+/);
  const kept = segments.map((s) => s.trim()).filter((s) => s.length > 0 && !BOOKING_MENTION_RE.test(s));
  const result = kept.join("\n").trim();
  return result.length > 0 ? result : text.trim();
}

/* --------------------- false "it's done" claim detection ------------------ */

// Conservative markers for a reply CLAIMING a booking action was COMPLETED (past tense).
// Deliberately narrow to avoid flagging escalation acks like "העברתי את הפנייה לצוות".
const DONE_CANCEL_RE = /ביטלתי (?:את )?התור|התור (?:כבר )?בוטל|בוטל התור/;
const DONE_MOVE_RE = /הזזתי (?:את )?התור|שיניתי (?:את )?(?:התור|המועד)|העברתי (?:את )?התור ל(?:יום|שעה|תאריך|שעת|מועד)|קבעתי לך מחדש/;
const DONE_BOOK_RE = /קבעתי לך (?:את )?התור|התור נקבע|קבעתי לך תור/;

/**
 * Detects a reply that CLAIMS a booking change is already done while no matching tool
 * actually succeeded this turn. Telemetry-first: the caller LOGS this (does not rewrite the
 * reply) so we can measure the false-positive rate before promoting it to active correction.
 * A reschedule/move claim is ALWAYS false — request_reschedule never executes a change.
 * Returns a short reason string, or null when no false completion claim is detected.
 */
export function detectFalseCompletionClaim(
  reply: string,
  actions: { created: boolean; cancelled: boolean },
): string | null {
  const t = (reply ?? "").toString();
  if (DONE_MOVE_RE.test(t)) return "claims a reschedule/move was done — reschedule never executes (always pending)";
  if (DONE_CANCEL_RE.test(t) && !actions.cancelled) return "claims a cancellation was done, but no cancel succeeded this turn";
  if (DONE_BOOK_RE.test(t) && !actions.created) return "claims a booking was made, but no create succeeded this turn";
  return null;
}

/* --------------------- internal-leak output filter (security) ------------- */

// Identifiers that must NEVER appear in a customer-facing reply — tool names, escalation
// category ids, config/secret keys, and the "system prompt" tell. They are English snake_case
// or ALL_CAPS tokens that never occur in a legitimate Hebrew reply, so a match is a real leak.
const INTERNAL_LEAK_TOKENS = [
  "escalate_to_human", "create_appointment", "request_reschedule", "cancel_appointment",
  "modify_appointment", "create_contact", "modify_contact", "add_lead",
  "search_patient", "get_available_slots", "get_doctors_sites", "get_treatments",
  "get_patient_appointments", "get_hours_blocking",
  "medical_symptom", "general_complaint", "sales_inquiry", "staff_approval_needed",
  "reschedule_request", "late_cancellation",
  "booking_provider", "default_business_id", "supabase_", "anthropic_", "optima_",
  "twilio_", "system prompt", "system_prompt",
];

const SAFE_REFUSAL =
  "אני כאן כדי לעזור עם תורים בלבד 🙂 אשמח לקבוע לך תור, לבדוק זמינות או לעדכן פרטים. במה אפשר לעזור?";

/**
 * Deterministic INFORMATION-leak guard on the OUTGOING reply. If the reply discloses any internal
 * identifier (tool/category/config name, or the system prompt), the whole reply is replaced with a
 * safe redirect — the model must never reveal its instructions or internals, even when refusing.
 * Returns the leaked tokens (for telemetry) and the safe text. This is the last line before send.
 */
export function redactInternalLeak(reply: string): { leaked: string[]; text: string } {
  const t = (reply ?? "").toString();
  const lower = t.toLowerCase();
  const leaked = INTERNAL_LEAK_TOKENS.filter((tok) => lower.includes(tok));
  return leaked.length > 0 ? { leaked, text: SAFE_REFUSAL } : { leaked: [], text: t };
}

/* ----------------------- dead-end "please wait" detection ----------------- */

// The agent asking the CUSTOMER to hold while it (supposedly) checks something, then ending
// the turn — the check never happens. Narrow markers so an escalation ack ("הצוות יחזרו אליך")
// is NOT caught (that is a real answer, not a dead-end).
const WAIT_PROMISE_RE =
  /(תמתין|תמתיני|המתין|המתן|המתיני|רק רגע|רגע אחד|שנייה אחת|תכף אחזור|תן לי רגע|תני לי רגע|כבר בודק)/;

/** True when the reply promises to check and asks the customer to wait (a dead-end turn). */
export function isDeadEndWait(text: string): boolean {
  return WAIT_PROMISE_RE.test((text ?? "").toString());
}

/* ------------------------------- Hebrew lint ------------------------------ */

// Known bad phrases seen in live output → the correct alternative. Extend as more surface.
const BANNED_PHRASES: { bad: RegExp; good: string }[] = [
  { bad: /בואנו/, good: "בוא/בואי" },
  { bad: /בחכייה|בחכיה/, good: "מחכים לך" },
  // Corporate / robotic phrasing — speak plainly and warmly instead.
  { bad: /הצוות המקצועי/, good: "פשוט: הצוות / דנה ולורות" },
  { bad: /יידעו להתייחס|ידעו להתייחס/, good: "בלי ניסוח תאגידי" },
  { bad: /מבי[ןנ]ה? שזה לא נוח/, good: 'אוי, מצטערת לשמוע 💙' },
  // Masculine spelling of "to you" — the feminine default is "אלייך" (two yods). Standalone
  // word only (lookarounds), so it never matches inside "אלייך" or a larger word.
  { bad: /(?<![א-ת])אליך(?![א-ת])/, good: "אלייך (כתיב נקבה)" },
];

// Slash gender forms ("מעביר/ה", "לקבוע/לשנות", "את/ה") — a Hebrew run, a slash, then more
// Hebrew, with NO surrounding spaces. Spares dates ("12/2026") and "דנה / רות" (spaced).
const SLASH_GENDER_RE = /[א-ת]{2,}\/[א-ת]+/;

// Routine replies should be short (2–4 lines). More than this reads as a wall of text.
const MAX_REPLY_LINES = 5;

// Foreign scripts (CJK / Hangul / Thai / Cyrillic / Arabic-presentation) = garble in a
// Hebrew reply — this catches artifacts like the stray Korean characters seen earlier.
const FOREIGN_SCRIPT_RE = /[Ѐ-ӿ฀-๿　-鿿가-힯]/;

/**
 * Lint an agent reply for Hebrew-quality problems: banned phrases and foreign-script garble.
 * Returns a list of issue strings (empty = clean). NOTE: grammatical garble made of valid
 * Hebrew letters (e.g. "אם אתה בחוד") cannot be reliably auto-detected — that stays a manual
 * review item. Telemetry-first: the runner reports these, it does not fail a scenario on them.
 */
export function hebrewLint(text: string): string[] {
  const t = (text ?? "").toString();
  const issues: string[] = [];
  for (const { bad, good } of BANNED_PHRASES) {
    if (bad.test(t)) issues.push(`banned phrase (${bad.source}) → use "${good}"`);
  }
  if (SLASH_GENDER_RE.test(t)) {
    issues.push('slash gender form (e.g. "מעביר/ה") → use one clean feminine form');
  }
  const lines = t.split(/\n/).map((l) => l.trim()).filter(Boolean).length;
  if (lines > MAX_REPLY_LINES) {
    issues.push(`reply too long (${lines} non-empty lines) → aim for 2–4`);
  }
  if (FOREIGN_SCRIPT_RE.test(t)) issues.push("foreign-script garble");
  return issues;
}

/* ----------------------------- phone normalization ------------------------ */

/**
 * Canonicalize an Israeli phone to local `0XXXXXXXXX` form so the SAME person matches
 * regardless of how the number arrived: `whatsapp:+972559415600`, `+972559415600`,
 * `972559415600`, `055-941-5600` all collapse to `0559415600`. Digits only (drops the
 * `whatsapp:` prefix, `+`, spaces, dashes). Non-IL / already-local numbers pass through.
 */
export function normalizePhone(raw: string): string {
  const digits = (raw ?? "").toString().replace(/\D/g, "");
  if (digits.startsWith("972")) return "0" + digits.slice(3); // +972XXXXXXXXX → 0XXXXXXXXX
  return digits;
}

/* -------------------------- timezone helper (rule 8) ---------------------- */

/**
 * Interpret an ISO date + `HH:MM[:SS]` wall-clock time as Asia/Jerusalem local time
 * and return the corresponding UTC instant (DST-aware via Intl). Used to compare an
 * appointment time against `now` for the 24h / 48h checks.
 */
export function israelInstant(dateIso: string, time: string): Date {
  const [y, m, d] = dateIso.split("-").map(Number);
  const [hh, mm, ss = 0] = time.split(":").map(Number);
  const guessUtc = Date.UTC(y, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0, ss);
  const offsetMin = israelOffsetMinutes(new Date(guessUtc));
  return new Date(guessUtc - offsetMin * 60_000);
}

function israelOffsetMinutes(instant: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(instant)) parts[p.type] = p.value;
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - instant.getTime()) / 60_000);
}
