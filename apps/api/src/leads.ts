/**
 * Deterministic contact resolution + lead capture (Issue 2).
 *
 * Runs in the webhook path BEFORE the model, so the clinic never loses a lead and the
 * agent always knows who it is talking to: a registered patient, a known lead, or a brand
 * new inquiry (captured on the spot). We never trust the model to persist a lead — there is
 * deliberately no lead-write tool. resolveContact's deps are injectable so the status/dedup
 * logic is unit-tested without a database.
 */

import { getProvider } from "@aivantis/booking-provider";
import { normalizePhone } from "./gating";
import { firstNameOnly } from "./redact";
import { findLead, createLead } from "./memory";

export type ContactStatus = "patient" | "existing_lead" | "new";

export interface ContactResolution {
  status: ContactStatus;
  phone: string; // normalized (0XXXXXXXXX)
  context: string; // Hebrew line injected into the agent turn
  name?: string;
}

/**
 * The Hebrew context injected into the agent turn so it never says "can't find you" and never
 * invents an explanation for system state. Pure — unit-tested.
 */
export function buildContactContext(status: ContactStatus, opts: { since?: string; name?: string } = {}): string {
  switch (status) {
    case "patient":
      return (
        `[זיהוי] הטלפון הזה שייך למטופלת רשומה במערכת${opts.name ? ` (${opts.name})` : ""}. ` +
        `אין צורך לבקש שוב את המספר; אפשר להשתמש ב-search_patient לפרטים.`
      );
    case "existing_lead":
      return (
        `[זיהוי] הטלפון הזה כבר נקלט אצלנו כפנייה${opts.since ? ` (מ-${opts.since})` : ""}. ` +
        `אל תבקשי שוב את המספר ואל תאמרי שאינך מוצאת אותו — הוא במערכת שלנו.`
      );
    case "new":
      return (
        `[זיהוי] פנייה חדשה — הטלפון עדיין אינו של מטופלת רשומה, אבל הפנייה כבר נשמרה אצלנו. ` +
        `אל תאמרי שאינך מוצאת אותו ואל תמציאי הסבר למה — פשוט אספי שם ותאום ראשוני.`
      );
  }
}

export interface ContactDeps {
  searchPatient: (phone: string) => Promise<{ fullName?: string }[]>;
  findLead: (businessId: string, phone: string) => Promise<{ created_at?: string } | null>;
  createLead: (businessId: string, phone: string) => Promise<unknown>;
}

/**
 * Registered patient → "patient"; known lead → "existing_lead"; otherwise capture a new lead
 * and return "new". Phone is normalized first so 05.../+9725... variants resolve to one identity.
 */
export async function resolveContact(
  rawPhone: string,
  businessId: string,
  deps: ContactDeps,
): Promise<ContactResolution> {
  const phone = normalizePhone(rawPhone);

  const patients = await deps.searchPatient(phone).catch(() => [] as { fullName?: string }[]);
  if (patients.length) {
    // Surname minimization (G1): only the first name is used for personal address; the surname
    // from the lookup never reaches the model. The full name stays available in code where needed.
    const name = firstNameOnly(patients[0]?.fullName);
    return { status: "patient", phone, name, context: buildContactContext("patient", { name }) };
  }

  const existing = await deps.findLead(businessId, phone);
  if (existing) {
    const since = existing.created_at?.slice(0, 10);
    return { status: "existing_lead", phone, context: buildContactContext("existing_lead", { since }) };
  }

  await deps.createLead(businessId, phone);
  return { status: "new", phone, context: buildContactContext("new", {}) };
}

/** Live wiring: provider patient search + Supabase lead table. resolveContact stays test-injectable. */
const booking = getProvider();
export const liveContactDeps: ContactDeps = {
  searchPatient: (phone) => booking.searchPatient(phone),
  findLead,
  createLead,
};
