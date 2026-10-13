/**
 * Write tools (Stage 4) — every one routes through the deterministic Gating layer
 * (Stage 3) before it can reach the provider. Against MockProvider only.
 *
 *   create_appointment  → consultation-before-treatment + active-series gates
 *   request_reschedule  → NEVER modifies; stages + escalates (reschedule_request)
 *   cancel_appointment  → 24h window gate (late → escalate, no auto-cancel)
 *   escalate_to_human   → mandatory `category`; the ONLY escalation path
 *
 * There is deliberately NO compensation/refund tool anywhere in the registry.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Appointment, BookingProvider, AppointmentType } from "@aivantis/booking-provider";
import { ok, invalid, asString, isIsoDate, type ToolOutcome } from "./booking-tools";
import {
  gateAppointment,
  gateReschedule,
  gateCancellation,
  hasClinicOverride,
  israelInstant,
  isEscalationCategory,
  ESCALATION_ROUTING,
  ESCALATION_CATEGORIES,
  type AppointmentGateContext,
  type EscalationCategory,
} from "./gating";

export const WRITE_TOOLS: Anthropic.Tool[] = [
  {
    name: "create_appointment",
    description:
      'קביעת תור. חובה לעבור בדיקות: פונה חדש/ה או טיפול ללא ייעוץ קודם → המערכת תדרוש קודם "ייעוץ". סדרה פעילה → אישור צוות. type הוא "consultation" (ייעוץ) או "treatment" (טיפול); לטיפול חובה treatment_code. אם התוצאה חוסמת — הצע/י ללקוח/ה את הפעולה שהמערכת מחזירה (למשל לקבוע ייעוץ).',
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["consultation", "treatment"], description: "ייעוץ או טיפול" },
        treatment_code: { type: "string", description: 'קוד הטיפול (חובה לטיפול; גם לייעוץ עבור טיפול מסוים), למשל "botox"' },
        date: { type: "string", description: "YYYY-MM-DD" },
        start_time: { type: "string", description: "HH:MM:SS" },
        provider_code: { type: "string", description: "קוד נותן השירות (doctorCode מ-get_available_slots)" },
        patient_id: { type: "string", description: "מזהה מטופל/ת קיים/ת; השמט לפונה חדש/ה" },
        first_name: { type: "string" },
        last_name: { type: "string" },
        phone: { type: "string" },
      },
      required: ["type", "date", "start_time", "provider_code"],
    },
  },
  {
    name: "request_reschedule",
    description:
      "בקשת שינוי/דחיית תור קיים. אינו משנה תור בפועל — אוסף את הפרטים ומסלים לפקידה (תמיד ידני). מחזיר urgency לפי המרחק ממועד התור.",
    input_schema: {
      type: "object",
      properties: {
        appointment_id: { type: "string" },
        patient_id: { type: "string", description: "לאימות מועד התור" },
        requested_date: { type: "string", description: "YYYY-MM-DD מבוקש (אופציונלי)" },
        requested_time: { type: "string", description: "HH:MM:SS מבוקש (אופציונלי)" },
        note: { type: "string" },
      },
      required: ["appointment_id"],
    },
  },
  {
    name: "cancel_appointment",
    description:
      "ביטול תור קיים. ביטול פחות מ-24 שעות לפני התור אינו אוטומטי — מסלים לצוות ומיידע על חיוב אפשרי. מעל 24 שעות — מבטל.",
    input_schema: {
      type: "object",
      properties: {
        appointment_id: { type: "string" },
        patient_id: { type: "string", description: "לאימות מועד התור" },
      },
      required: ["appointment_id"],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "העברת פנייה לאדם מהצוות. חובה לציין category. medical_symptom (תלונה פיזית/רפואית → דנה/רות), general_complaint (תלונה שירותית → קבלה/עדי), sales_inquiry (מכירות → נציג), staff_approval_needed, reschedule_request, late_cancellation. זהו הכלי היחיד להסלמה — אין כלי לפיצוי/החזר.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ESCALATION_CATEGORIES, description: "קטגוריית ההסלמה" },
        summary: { type: "string", description: "תקציר קצר של הפנייה בעברית" },
        patient_phone: { type: "string" },
      },
      required: ["category", "summary"],
    },
  },
];

export const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((t) => t.name));
export function isWriteTool(name: string): boolean {
  return WRITE_TOOL_NAMES.has(name);
}

/** Tools that route a request to a human — used for deterministic escalation enforcement. */
export const ESCALATION_TOOL_NAMES = new Set([
  "escalate_to_human",
  "request_reschedule",
  "cancel_appointment",
]);
export function isEscalationTool(name: string): boolean {
  return ESCALATION_TOOL_NAMES.has(name);
}

/** Dispatch a write tool through the gating layer. `now` is injectable for tests. */
export async function runWriteTool(
  provider: BookingProvider,
  name: string,
  input: unknown,
  now: Date = new Date(),
): Promise<ToolOutcome> {
  if (process.env.AGENT_DEBUG) {
    console.error(`  [write→] ${name} ${JSON.stringify(input)}`);
  }
  const args = (input ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "create_appointment":
        return await createAppointment(provider, args);
      case "request_reschedule":
        return await requestReschedule(provider, args, now);
      case "cancel_appointment":
        return await cancelAppointment(provider, args, now);
      case "escalate_to_human":
        return escalateToHuman(args);
      default:
        return { content: `כלי כתיבה לא מוכר: ${name}`, isError: true };
    }
  } catch (err) {
    console.error(`[write-tool ${name}] error:`, err);
    return {
      content: "מצטער/ת, יש כרגע תקלה זמנית. אעביר את הבקשה לצוות שיטפל בה.",
      isError: true,
    };
  }
}

/* ------------------------------ create ------------------------------------ */

/** Card id absent or the "0" sentinel — never book against it (A5a; same rule as OptimaProvider). */
function isBlankOrZeroCardId(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  const s = String(value).trim();
  return s === "" || s === "0";
}

async function createAppointment(
  provider: BookingProvider,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const type = asString(args.type) as AppointmentType | undefined;
  if (type !== "consultation" && type !== "treatment") {
    return invalid('type חייב להיות "consultation" או "treatment".');
  }
  const date = asString(args.date);
  const startTime = asString(args.start_time);
  const providerCode = asString(args.provider_code);
  if (!isIsoDate(date)) return invalid("date חייב להיות בפורמט YYYY-MM-DD.");
  if (!startTime) return invalid("חסר start_time (HH:MM:SS).");
  if (!providerCode) return invalid("חסר provider_code.");

  const treatmentCode = asString(args.treatment_code);
  const patientId = asString(args.patient_id);
  if (type === "treatment" && !treatmentCode) {
    return invalid("לטיפול חובה treatment_code.");
  }

  const ctx = await buildAppointmentContext(provider, {
    requestedType: type,
    patientId,
    treatmentCode,
  });
  const decision = gateAppointment(ctx);

  if (!decision.allow) {
    if (decision.escalate) {
      return escalation(decision.escalate, { reason: decision.reason, treatment_code: treatmentCode });
    }
    // Forced consultation — do NOT auto-book; tell the agent to offer a consultation.
    return ok({
      blocked: true,
      reason: decision.reason,
      action_required: "book_consultation_first",
      suggested_type: decision.forceType ?? "consultation",
    });
  }

  // Application guard (A5a): against the REAL Optima provider, never book without a verified
  // patient card_id — an anonymous booking emits card_id="0" and creates an undeletable junk
  // patient card. Fail closed to a machine-readable BLOCKED result, BEFORE any provider call.
  // Mock keeps its anonymous-card behavior (this guard is optima-gated).
  if (process.env.BOOKING_PROVIDER === "optima" && isBlankOrZeroCardId(patientId)) {
    console.warn("[booking-blocked-no-cardid]");
    return ok({
      ok: false,
      blocked: true,
      booked: false,
      action_required: "capture_as_lead",
      reason: "no_verified_patient_id",
    });
  }

  // Allowed → book via provider.
  const duration = await treatmentDuration(provider, treatmentCode, type);
  const catalogName = treatmentCode ? (await treatmentName(provider, treatmentCode)) : undefined;
  const res = await provider.createAppointment({
    doctorCode: providerCode,
    date,
    startTime,
    durationMinutes: duration,
    type,
    treatmentCode,
    cardId: patientId,
    firstName: asString(args.first_name),
    lastName: asString(args.last_name),
    cellPhone: asString(args.phone),
    subject: type === "consultation" ? `ייעוץ${catalogName ? ` - ${catalogName}` : ""}` : catalogName,
  });
  return ok({
    ok: true,
    appointment_id: res.id,
    booked: { type, treatment_code: treatmentCode, date, start_time: startTime, provider_code: providerCode },
  });
}

async function buildAppointmentContext(
  provider: BookingProvider,
  input: { requestedType: AppointmentType; patientId?: string; treatmentCode?: string },
): Promise<AppointmentGateContext> {
  const isNewLead = !input.patientId;
  let consultationCompleted = false;
  let activeSeries = false;
  if (input.patientId) {
    const appts = await provider.getPatientAppointments(input.patientId);
    consultationCompleted = appts.some(
      (a) => a.type === "consultation" && a.completed === true && a.treatmentCode === input.treatmentCode,
    );
    activeSeries = appts.some((a) => a.activeSeries === true && a.treatmentCode === input.treatmentCode);
  }
  const clinicOverride =
    input.patientId && input.treatmentCode ? hasClinicOverride(input.patientId, input.treatmentCode) : false;
  return {
    requestedType: input.requestedType,
    patientId: input.patientId,
    treatmentCode: input.treatmentCode,
    isNewLead,
    consultationCompleted,
    clinicOverride,
    activeSeries,
  };
}

/* ---------------------------- reschedule ---------------------------------- */

async function requestReschedule(
  provider: BookingProvider,
  args: Record<string, unknown>,
  now: Date,
): Promise<ToolOutcome> {
  const appointmentId = asString(args.appointment_id);
  if (!appointmentId) return invalid("חסר appointment_id.");
  const appt = await findAppointment(provider, appointmentId, asString(args.patient_id));

  // Never modifies — always staged + escalated to the front desk.
  const startInstant = appt ? israelInstant(appt.date, appt.startTime) : now;
  const { urgency } = gateReschedule(startInstant, now);
  return escalation("reschedule_request", {
    appointment_id: appointmentId,
    requested_date: asString(args.requested_date),
    requested_time: asString(args.requested_time),
    urgency,
    note: asString(args.note),
    verified: Boolean(appt),
  });
}

/* ------------------------------ cancel ------------------------------------ */

async function cancelAppointment(
  provider: BookingProvider,
  args: Record<string, unknown>,
  now: Date,
): Promise<ToolOutcome> {
  const appointmentId = asString(args.appointment_id);
  if (!appointmentId) return invalid("חסר appointment_id.");
  const appt = await findAppointment(provider, appointmentId, asString(args.patient_id));

  // Fail-closed: if we can't verify the appointment time, escalate rather than cancel blindly.
  if (!appt) {
    return escalation("late_cancellation", {
      appointment_id: appointmentId,
      reason: "לא ניתן לאמת את מועד התור — מועבר לצוות.",
    });
  }

  const decision = gateCancellation(israelInstant(appt.date, appt.startTime), now);
  if (!decision.allow) {
    const message = "message" in decision ? decision.message : undefined;
    return escalation("late_cancellation", { appointment_id: appointmentId, message });
  }
  const res = await provider.deleteAppointment(appointmentId);
  return ok({ ok: true, cancelled: true, appointment_id: res.id });
}

/* ---------------------------- escalate ------------------------------------ */

function escalateToHuman(args: Record<string, unknown>): ToolOutcome {
  const category = asString(args.category);
  if (!isEscalationCategory(category)) {
    return invalid(`category לא תקין. ערכים אפשריים: ${ESCALATION_CATEGORIES.join(", ")}.`);
  }
  const summary = asString(args.summary);
  if (!summary) return invalid("חסר summary (תקציר הפנייה).");
  return escalation(category, { summary, patient_phone: asString(args.patient_phone) });
}

/* ------------------------------- helpers ---------------------------------- */

function escalation(category: EscalationCategory, extra: Record<string, unknown> = {}): ToolOutcome {
  const route = ESCALATION_ROUTING[category];
  // status/done are deliberately explicit so the model cannot read an escalation as a
  // completed action: the request was handed to a human and is PENDING, never executed here.
  return ok({
    escalated: true,
    status: "pending",
    done: false,
    pending_note: "הבקשה הועברה לגורם אנושי — טרם בוצעה; אל תאמר/י שהיא בוצעה.",
    category,
    routed_to: route.to,
    note: route.note,
    ...extra,
  });
}

async function findAppointment(
  provider: BookingProvider,
  appointmentId: string,
  patientId?: string,
): Promise<Appointment | undefined> {
  if (!patientId) return undefined;
  const appts = await provider.getPatientAppointments(patientId);
  return appts.find((a) => a.id === appointmentId);
}

async function treatmentDuration(
  provider: BookingProvider,
  treatmentCode: string | undefined,
  type: AppointmentType,
): Promise<number> {
  if (type === "consultation" || !treatmentCode) return 30;
  const catalog = await provider.getTreatments("");
  return catalog.find((t) => t.code === treatmentCode)?.durationMinutes ?? 30;
}

async function treatmentName(provider: BookingProvider, treatmentCode: string): Promise<string | undefined> {
  const catalog = await provider.getTreatments("");
  return catalog.find((t) => t.code === treatmentCode)?.name;
}
