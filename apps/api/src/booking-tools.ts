/**
 * Read-only booking tools exposed to the agent (Stage 1).
 *
 * Each tool is a thin, validated wrapper over a `BookingProvider` method. Only the
 * clean domain types (from the package's public surface) are returned — the
 * provider-specific `raw` payload is stripped before anything reaches the model,
 * and nothing from Optima's internal types is referenced here.
 *
 * NO write tools (create / modify / delete) are defined here — those live behind
 * the gating layer (Stages 3–4).
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { BookingProvider } from "@aivantis/booking-provider";
import { normalizePhone } from "./gating";

export const READ_TOOLS: Anthropic.Tool[] = [
  {
    name: "search_patient",
    description:
      "חיפוש מטופל/ת קיים/ת. מפתח החיפוש הראשי הוא מספר טלפון (כמו באופטימה); אפשר גם חלק משם. מחזיר מזהה (id), שם מלא וטלפון. השתמש/י בזה כדי לזהות לקוח/ה קיים/ת לפי הטלפון לפני שמושכים תורים/טיפולים.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "מספר טלפון (עדיף) או שם/חלק משם" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_available_slots",
    description:
      "מציאת תורים פנויים לטווח תאריכים. הזמינות מחושבת מלוח המשמרות בפועל (מי עובד ומתי), לפי סוג הטיפול. אפשר לסנן לנותן שירות מסוים.",
    input_schema: {
      type: "object",
      properties: {
        start: { type: "string", description: "תאריך התחלה בפורמט YYYY-MM-DD" },
        end: { type: "string", description: "תאריך סיום בפורמט YYYY-MM-DD" },
        treatment_type: {
          type: "string",
          description:
            'קוד הטיפול (למשל "consultation" לייעוץ, "botox", "morpheus8"). קובע את המשך ואת מי מוסמך לבצע. אם לא יודעים — השתמש/י ב-get_treatments לקבלת הרשימה.',
        },
        provider_id: { type: "integer", description: "אופציונלי: הגבלה לנותן שירות מסוים לפי מזהה" },
        min_duration_minutes: { type: "integer", description: "אופציונלי: משך מינימלי כשאין קוד טיפול" },
      },
      required: ["start", "end"],
    },
  },
  {
    name: "get_doctors_sites",
    description:
      "רשימת נותני השירות והסניפים, כולל התפקיד (role: ייעוץ / אחות / רופא) והטיפולים שכל אחד מבצע. שימושי כדי לדעת מי מוסמך לאיזה טיפול.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_treatments",
    description:
      "רשימת הטיפולים. ללא patient_id — מחזיר את קטלוג הטיפולים עם משך (duration_minutes), מרווח (buffer_minutes) ומי מוסמך לבצע (required_role). עם patient_id — מחזיר את היסטוריית הטיפולים של אותו/ה מטופל/ת.",
    input_schema: {
      type: "object",
      properties: {
        patient_id: {
          type: "string",
          description: "אופציונלי: מזהה מטופל/ת להיסטוריה; השמט לקבלת הקטלוג",
        },
      },
    },
  },
  {
    name: "get_patient_appointments",
    description:
      "התורים הקיימים של מטופל/ת קיים/ת לפי מזהה (id/CardID). כולל שדה active_series שמסמן אם התור הוא חלק מסדרת טיפולים פעילה.",
    input_schema: {
      type: "object",
      properties: {
        patient_id: { type: "string", description: "מזהה המטופל/ת (id מ-search_patient)" },
      },
      required: ["patient_id"],
    },
  },
];

/** Backwards-compatible alias (read tools were previously exported as BOOKING_TOOLS). */
export const BOOKING_TOOLS = READ_TOOLS;

export interface ToolOutcome {
  content: string;
  isError?: boolean;
}

/** Dispatch a single READ tool call against the provider, with validation + friendly errors. */
export async function runReadTool(
  provider: BookingProvider,
  name: string,
  input: unknown,
): Promise<ToolOutcome> {
  if (process.env.AGENT_DEBUG) {
    console.error(`  [tool→] ${name} ${JSON.stringify(input)}`);
  }
  const args = (input ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "search_patient": {
        const query = asString(args.query);
        if (!query) return invalid("צריך/ה מספר טלפון (או שם) כדי לחפש.");
        // Canonicalize phone-like queries (05.../+9725...) so the same person matches; leave
        // name queries untouched (normalizing a name would strip it to nothing).
        const q = query.replace(/\D/g, "").length >= 3 ? normalizePhone(query) : query;
        return ok((await provider.searchPatient(q)).slice(0, 10));
      }
      case "get_available_slots": {
        const start = asString(args.start);
        const end = asString(args.end);
        if (!isIsoDate(start) || !isIsoDate(end)) {
          return invalid("צריך תאריך התחלה ותאריך סיום בפורמט YYYY-MM-DD.");
        }
        const slots = await provider.getAvailableSlots({
          start,
          end,
          treatmentCode: asString(args.treatment_type),
          providerId: asInt(args.provider_id),
          minDurationMinutes: asInt(args.min_duration_minutes),
        });
        return ok({ total: slots.length, slots: slots.slice(0, 20) });
      }
      case "get_doctors_sites":
        return ok(await provider.getDoctorsSites());
      case "get_treatments": {
        // No patient_id -> catalog; with patient_id -> that patient's history.
        const patientId = asString(args.patient_id) ?? "";
        return ok(await provider.getTreatments(patientId));
      }
      case "get_patient_appointments": {
        const patientId = asString(args.patient_id);
        if (!patientId) return invalid("צריך מזהה מטופל/ת (אפשר לקבל אותו מחיפוש מטופל).");
        return ok(await provider.getPatientAppointments(patientId));
      }
      default:
        return { content: `כלי קריאה לא מוכר: ${name}`, isError: true };
    }
  } catch (err) {
    console.error(`[read-tool ${name}] error:`, err);
    return {
      content:
        "מצטער/ת, יש כרגע תקלה זמנית בגישה למערכת. אפשר לנסות שוב בעוד רגע, ואם זה ממשיך — אעביר לצוות.",
      isError: true,
    };
  }
}

/* ------------------------------- shared utils ----------------------------- */

/** Serialize only clean domain data; drop the optional provider-specific `raw`. */
export function ok(data: unknown): ToolOutcome {
  return { content: JSON.stringify(data, (key, value) => (key === "raw" ? undefined : value)) };
}

export function invalid(message: string): ToolOutcome {
  return { content: message, isError: true };
}

export function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  return undefined;
}

export function isIsoDate(value: string | undefined): value is string {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function asInt(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
