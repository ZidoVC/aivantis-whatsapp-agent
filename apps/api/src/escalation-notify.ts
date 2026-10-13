/**
 * Escalation staff-notification channel.
 *
 * When the code records an escalation (see agent.ts — model-driven OR enforcement-driven),
 * a WhatsApp alert is sent to the responsible staff member so the promise "no message is
 * missed" is actually kept. This module is the pure, testable core:
 *
 *   - `escalationChannel` / `resolveEscalationPhone` — deterministic routing (medical vs service)
 *   - `notifyEscalation` — FAILURE-SAFE send: never throws; on any failure it logs
 *     `[escalation-notify-failed]` loudly and returns { sent:false }. The caller records the
 *     escalation independently, so a notify failure can never make an escalation disappear.
 *
 * The Twilio dependency is injected (`WhatsAppSender`) so routing and the failure path are
 * unit-tested without touching Twilio. `twilioWhatsAppSender` builds the real sender from env.
 */

import twilio from "twilio";
import { ESCALATION_ROUTING, type EscalationCategory } from "./gating";

export type EscalationChannel = "medical" | "service";

/** Only a physical/medical complaint goes to the medical channel; everything else is service. */
export function escalationChannel(category: EscalationCategory): EscalationChannel {
  return category === "medical_symptom" ? "medical" : "service";
}

/**
 * Resolve the staff phone for a category:
 *   medical  → ESCALATION_PHONE_MEDICAL
 *   service  → ESCALATION_PHONE_SERVICE
 * falling back to ESCALATION_PHONE_DEFAULT when the specific one is unset/empty.
 * Returns undefined when nothing is configured (the caller then logs + skips, never silently).
 */
export function resolveEscalationPhone(
  category: EscalationCategory,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const specific =
    escalationChannel(category) === "medical"
      ? env.ESCALATION_PHONE_MEDICAL
      : env.ESCALATION_PHONE_SERVICE;
  const chosen = (specific && specific.trim()) || (env.ESCALATION_PHONE_DEFAULT?.trim() ?? "");
  return chosen || undefined;
}

export interface EscalationEvent {
  category: EscalationCategory;
  /** The customer's own message that triggered the escalation. */
  customerMessage: string;
  /** The customer's WhatsApp address (may carry a `whatsapp:` prefix). */
  customerPhone: string;
  at: Date;
}

/** Human-readable staff alert body (Hebrew, matches the clinic routing labels). */
export function formatEscalationMessage(e: EscalationEvent): string {
  const route = ESCALATION_ROUTING[e.category];
  const phone = e.customerPhone.replace(/^whatsapp:/i, "");
  return [
    `🔔 הסלמה חדשה — ${e.category}`,
    `יעד: ${route.to}`,
    `לקוח/ה: ${phone}`,
    `הודעה: ${e.customerMessage}`,
    `זמן: ${e.at.toISOString()}`,
  ].join("\n");
}

/** Injectable WhatsApp sender so the notifier is unit-testable without Twilio. */
export type WhatsAppSender = (to: string, body: string) => Promise<void>;

/** Why a notification could not be delivered — persisted on the durable "unnotified" record. */
export type UndeliveredReason = "no_phone" | "sender_not_configured" | "send_error";

export interface NotifyDeps {
  /** The WhatsApp sender, or null when Twilio sending isn't configured. */
  send: WhatsAppSender | null;
  env?: NodeJS.ProcessEnv;
  /**
   * Best-effort hook fired when a notification could NOT be delivered, so the caller can write
   * a durable "unnotified" record (a silent miss on a medical complaint is the one failure we
   * cannot have). Invoked AFTER [escalation-notify-failed] is logged. If it throws, notifyEscalation
   * still never throws.
   */
  onUndelivered?: (info: { category: EscalationCategory; reason: UndeliveredReason; event: EscalationEvent }) => void | Promise<void>;
}

export interface NotifyResult {
  sent: boolean;
  to?: string;
  reason?: UndeliveredReason;
}

/**
 * Send a staff WhatsApp alert for one escalation. FAILURE-SAFE: never throws. On any delivery
 * failure (no phone, no Twilio sender, or a send error) it logs `[escalation-notify-failed]`,
 * fires the durable `onUndelivered` hook, and returns { sent:false }.
 */
export async function notifyEscalation(e: EscalationEvent, deps: NotifyDeps): Promise<NotifyResult> {
  const env = deps.env ?? process.env;
  const phone = e.customerPhone.replace(/^whatsapp:/i, "");

  const fail = async (reason: UndeliveredReason, detail: string, to?: string): Promise<NotifyResult> => {
    console.error(
      `[escalation-notify-failed] category=${e.category} reason=${reason} customer=${phone}: ` +
        `${detail} — escalation was still recorded.`,
    );
    try {
      await deps.onUndelivered?.({ category: e.category, reason, event: e });
    } catch (hookErr) {
      console.error(
        `[escalation-notify-failed] durable 'unnotified' hook threw for category=${e.category} ` +
          `customer=${phone}: ${(hookErr as Error).message} — this escalation may be UNTRACKED.`,
      );
    }
    return { sent: false, to, reason };
  };

  const to = resolveEscalationPhone(e.category, env);
  if (!to) {
    const key = escalationChannel(e.category) === "medical" ? "ESCALATION_PHONE_MEDICAL" : "ESCALATION_PHONE_SERVICE";
    return fail("no_phone", `no staff phone (set ${key} or ESCALATION_PHONE_DEFAULT)`);
  }
  if (!deps.send) {
    return fail("sender_not_configured", "Twilio sender not configured (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_WHATSAPP_FROM)", to);
  }
  try {
    await deps.send(to, formatEscalationMessage(e));
    return { sent: true, to };
  } catch (err) {
    return fail("send_error", `${(err as Error).message}`, to);
  }
}

/**
 * Build a Twilio WhatsApp sender from env, or null when sending isn't fully configured
 * (needs TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_WHATSAPP_FROM). A null sender is
 * treated by the caller as a notify failure (logged), never as a silent no-op.
 */
export function twilioWhatsAppSender(env: NodeJS.ProcessEnv = process.env): WhatsAppSender | null {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_WHATSAPP_FROM;
  if (!sid || !token || !from) return null;
  const client = twilio(sid, token);
  return async (to, body) => {
    const toAddr = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
    await client.messages.create({ from, to: toAddr, body });
  };
}

/**
 * Boot-time health check for the escalation channel. Logs a loud one-time `[escalation-channel]`
 * warning if staff could NOT actually be alerted (Twilio sender unconfigured, or a channel has no
 * phone) — so a dead channel is discovered at startup, not when a customer's escalation is missed.
 * Returns the list of problems (empty when healthy) for testing.
 */
export function checkEscalationChannelAtStartup(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];
  if (!twilioWhatsAppSender(env)) {
    problems.push("Twilio sender not configured (need TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_WHATSAPP_FROM)");
  }
  if (!resolveEscalationPhone("medical_symptom", env)) {
    problems.push("no MEDICAL escalation phone (set ESCALATION_PHONE_MEDICAL or ESCALATION_PHONE_DEFAULT)");
  }
  if (!resolveEscalationPhone("general_complaint", env)) {
    problems.push("no SERVICE escalation phone (set ESCALATION_PHONE_SERVICE or ESCALATION_PHONE_DEFAULT)");
  }
  if (problems.length) {
    console.warn(
      `[escalation-channel] ⚠️  DEGRADED at startup — staff will NOT be alerted on escalation: ` +
        `${problems.join("; ")}. Escalations are still recorded, but nobody is notified until this is fixed.`,
    );
  }
  return problems;
}
