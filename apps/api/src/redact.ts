/**
 * PII redaction at the MODEL boundary — the ONLY data flow that is de-identified (G1).
 *
 * Scope (deliberately narrow): this is applied ONLY to text sent to the Claude API. It does NOT
 * touch what we store in our DB, and it does NOT touch what we send to the clinic on escalation
 * (that is the clinic's own data returning to the clinic). It also does NOT redact message CONTENT
 * — the customer's words ARE the sensitive health info and the agent needs them to classify and
 * escalate. It removes only IDENTIFIERS the model does not functionally need:
 *   - Israeli phone numbers (lookup happens in code; the model never needs the digits)
 *   - Israeli ID numbers (ת.ז)
 * Surname minimization (first-name-only for personal address) is handled where the name is known,
 * via `firstNameOnly` — a regex can't tell which token is the surname.
 *
 * Redaction is a MARGINAL reduction in exposure, not our protection mechanism (that is processor
 * status + DPA, RLS, service-role access, encryption, retention policy). See docs/security-posture.md.
 */

// Israeli phone: optional whatsapp:/+ prefix, then a 972- or 0-led run of 9–10 digits, with space
// or hyphen separators only. Colons (times) and slashes (dates) are NOT separators, so 14:30 and
// 24/07/2026 never match; prices/durations are too short to match the required 9+ digit run.
const PHONE_RE = /(?:whatsapp:\s*)?(?:\+?972|0)(?:[ \-]?\d){8,9}/g;

// Israeli ID (ת.ז): a labeled form, or a bare 9-digit run (bounded so it never matches inside a
// longer number). Runs AFTER phone redaction, so phone-shaped numbers are already gone.
const ID_LABELED_RE = /(?:ת\.?\s?["'׳]?ז\.?|תעודת\s?זהות|מספר\s?זהות|מס['׳]?\s?זהות)\s*[:#]?\s*\d[\d \-]{3,10}\d/g;
const ID_BARE_RE = /(?<!\d)\d{9}(?!\d)/g;

const PHONE_PLACEHOLDER = "«טלפון»";
const ID_PLACEHOLDER = "«ת.ז»";

/** Replace Israeli phone numbers with a placeholder. */
export function redactPhone(text: string): string {
  return (text ?? "").toString().replace(PHONE_RE, PHONE_PLACEHOLDER);
}

/** Replace Israeli ID (ת.ז) numbers with a placeholder. */
export function redactId(text: string): string {
  return (text ?? "").toString().replace(ID_LABELED_RE, ID_PLACEHOLDER).replace(ID_BARE_RE, ID_PLACEHOLDER);
}

/** The single redaction layer for anything sent to the model: phones + IDs (content preserved). */
export function redactForModel(text: string): string {
  return redactId(redactPhone((text ?? "").toString()));
}

/** First name only — surname minimization for the personal-address context (name known in code). */
export function firstNameOnly(name: string | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? "";
}
