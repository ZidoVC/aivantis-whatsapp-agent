import { describe, it, expect } from "vitest";
import {
  gateAppointment,
  gateReschedule,
  gateCancellation,
  classifyEscalation,
  hasNewBookingRequest,
  BOOKING_MENTION_RE,
  stripBookingPivot,
  redactInternalLeak,
  detectFalseCompletionClaim,
  normalizePhone,
  isDeadEndWait,
  hebrewLint,
  classifyPriceIntent,
  detectTreatmentPriceLeak,
  withinHours,
  CONSULTATION_PRICE_ILS,
  hasClinicOverride,
  israelInstant,
  isEscalationCategory,
  ESCALATION_ROUTING,
  type AppointmentGateContext,
} from "../src/gating";

const baseCtx: AppointmentGateContext = {
  requestedType: "treatment",
  patientId: "1001",
  treatmentCode: "botox",
  isNewLead: false,
  consultationCompleted: false,
  clinicOverride: false,
  activeSeries: false,
};

/* ---------- Group 1 + 3: consultation-before-treatment (rules 1,3) -------- */
describe("gating group 1/3 — consultation before treatment", () => {
  it("consultations are always allowed", () => {
    expect(gateAppointment({ ...baseCtx, requestedType: "consultation" }).allow).toBe(true);
  });

  it("new lead requesting treatment → forced to consultation (no exception)", () => {
    const r = gateAppointment({ ...baseCtx, isNewLead: true, patientId: undefined });
    expect(r.allow).toBe(false);
    expect(r.forceType).toBe("consultation");
    expect(r.escalate).toBeUndefined();
  });

  it("existing patient, treatment, no consultation & no override → consultation", () => {
    const r = gateAppointment(baseCtx);
    expect(r.allow).toBe(false);
    expect(r.forceType).toBe("consultation");
  });

  it("existing patient with a completed consultation for that treatment → allowed", () => {
    expect(gateAppointment({ ...baseCtx, consultationCompleted: true }).allow).toBe(true);
  });

  it("existing patient with clinic_override for that treatment → allowed", () => {
    expect(gateAppointment({ ...baseCtx, clinicOverride: true }).allow).toBe(true);
  });

  // edge: same treatment_code but NO override → still consultation
  it("edge: no override for this treatment → consultation", () => {
    expect(gateAppointment({ ...baseCtx, clinicOverride: false }).forceType).toBe("consultation");
  });
});

/* ---------------- Group 2: active-series staff approval (rule 2) ----------- */
describe("gating group 2 — active series needs staff approval", () => {
  it("active series next session → escalate staff_approval_needed (not booked)", () => {
    const r = gateAppointment({ ...baseCtx, activeSeries: true, treatmentCode: "morpheus8" });
    expect(r.allow).toBe(false);
    expect(r.escalate).toBe("staff_approval_needed");
  });

  it("active series takes priority even if a consultation was completed", () => {
    const r = gateAppointment({ ...baseCtx, activeSeries: true, consultationCompleted: true });
    expect(r.escalate).toBe("staff_approval_needed");
    expect(r.allow).toBe(false);
  });
});

/* ------------------ Group 3: clinic override granularity ------------------ */
describe("gating group 3 — clinic override is (patient, treatment) specific", () => {
  it("override exists for (1001, botox)", () => {
    expect(hasClinicOverride("1001", "botox")).toBe(true);
  });
  // edge: override exists but for a different treatment
  it("edge: override for botox does NOT apply to morpheus8", () => {
    expect(hasClinicOverride("1001", "morpheus8")).toBe(false);
  });
  it("no override for a different patient", () => {
    expect(hasClinicOverride("1002", "botox")).toBe(false);
  });
});

/* --------------------- Group 4: reschedule = escalate --------------------- */
describe("gating group 4 — reschedule is always escalated", () => {
  const now = new Date("2026-07-01T09:00:00Z");
  it("far-out reschedule → standard urgency", () => {
    const appt = new Date("2026-07-20T09:00:00Z");
    const r = gateReschedule(appt, now);
    expect(r.escalate).toBe("reschedule_request");
    expect(r.urgency).toBe("standard");
  });
  it("reschedule within 48h → within_48h urgency", () => {
    const appt = new Date("2026-07-02T09:00:00Z"); // 24h away
    expect(gateReschedule(appt, now).urgency).toBe("within_48h");
  });
});

/* ------------------------ Group 5: sales detection ------------------------ */
describe("gating group 5 — sales intent", () => {
  it("detects buy-more phrasing", () => {
    expect(classifyEscalation("אני רוצה לקנות עוד סדרה")).toBe("sales_inquiry");
    expect(classifyEscalation("יש לכם שדרוג לחבילה?")).toBe("sales_inquiry");
  });
  // edge: ambiguous — "עוד מידע" is not a purchase
  it("edge: ambiguous 'עוד מידע' is NOT classified as sales", () => {
    expect(classifyEscalation("אפשר עוד מידע על הטיפולים?")).not.toBe("sales_inquiry");
  });
});

/* ---------------- Group 6 + 7: complaint split (rules 6,7) ---------------- */
describe("gating group 6/7 — complaint routing", () => {
  it("physical symptom → medical_symptom (routed to DemoA/DemoB)", () => {
    expect(classifyEscalation("יש לי כאב ונפיחות באזור הטיפול")).toBe("medical_symptom");
    expect(ESCALATION_ROUTING.medical_symptom.to).toContain("דנה");
  });
  it("service complaint → general_complaint (routed to reception)", () => {
    expect(classifyEscalation("אני מאוכזבת מהשירות")).toBe("general_complaint");
    expect(ESCALATION_ROUTING.general_complaint.to).toContain("קבלה");
  });
  it("medical takes priority over general when both present", () => {
    expect(classifyEscalation("אני מאוכזבת וגם כואב לי")).toBe("medical_symptom");
  });
  it("escalate category validation", () => {
    expect(isEscalationCategory("medical_symptom")).toBe(true);
    expect(isEscalationCategory("offer_compensation")).toBe(false);
  });
});

/* ------- Group 5b: intent detection for deterministic escalation ---------- */
describe("classifyEscalation — customer-message intent (single, prioritized)", () => {
  it("medical symptom", () => {
    expect(classifyEscalation("כואב לי קצת מאתמול")).toBe("medical_symptom");
  });
  it("cancellation intent (cancel verb + appointment noun)", () => {
    expect(classifyEscalation("אני צריך לבטל את התור שלי")).toBe("late_cancellation");
  });
  it("reschedule intent (non-adjacent verb + noun)", () => {
    expect(classifyEscalation("אפשר להעביר לי את התור ליום חמישי?")).toBe("reschedule_request");
  });
  it("discount / price counts as a sales inquiry", () => {
    expect(classifyEscalation("זה ממש יקר, אפשר הנחה?")).toBe("sales_inquiry");
  });
  it("undefined when there is no escalation intent", () => {
    expect(classifyEscalation("אני רוצה לקבוע בוטוקס")).toBeUndefined();
    expect(classifyEscalation("אפשר לוותר על הייעוץ?")).toBeUndefined();
  });
  it("single category per message — medical wins over sales (no double alert)", () => {
    expect(classifyEscalation("כואב לי, ואולי כדאי שאקנה עוד סדרה")).toBe("medical_symptom");
  });
  it("a reschedule verb without an appointment noun is NOT a reschedule", () => {
    expect(classifyEscalation("אני רוצה לשנות את השם שלי")).not.toBe("reschedule_request");
  });
});

/* ----------- Group 9: new-booking intent (enforcement gate) -------------- */
describe("hasNewBookingRequest — new booking vs reschedule/cancel", () => {
  it("detects a new booking (create verb + appointment noun)", () => {
    expect(hasNewBookingRequest("אפשר גם לקבוע תור להמשך?")).toBe(true);
    expect(hasNewBookingRequest("אשמח לתאם פגישה")).toBe(true);
  });
  it("reschedule phrasing is NOT a new booking", () => {
    expect(hasNewBookingRequest("אפשר להעביר לי את התור ליום חמישי?")).toBe(false);
  });
  it("cancellation phrasing is NOT a new booking", () => {
    expect(hasNewBookingRequest("אני צריך לבטל את התור שלי")).toBe(false);
  });
  it("a create verb without an appointment noun is NOT counted ('לקבוע בוטוקס')", () => {
    expect(hasNewBookingRequest("אני רוצה לקבוע בוטוקס")).toBe(false);
  });
  it("no booking intent at all", () => {
    expect(hasNewBookingRequest("זה לוקח יותר מדי זמן, תזרז")).toBe(false);
  });
});

/* ---------- Group 10: false "it's done" claim detection (Issue 1) --------- */
describe("detectFalseCompletionClaim — telemetry for lied-about booking state", () => {
  const none = { created: false, cancelled: false };
  it("flags a claim that a reschedule/move happened (reschedule never executes)", () => {
    expect(detectFalseCompletionClaim("הזזתי את התור שלך ל-13:00", none)).not.toBeNull();
    expect(detectFalseCompletionClaim("העברתי את התור ליום חמישי", none)).not.toBeNull();
  });
  it("flags a cancellation claim when no cancel succeeded", () => {
    expect(detectFalseCompletionClaim("ביטלתי את התור שלך", none)).not.toBeNull();
  });
  it("does NOT flag a cancellation claim when a cancel actually succeeded", () => {
    expect(detectFalseCompletionClaim("ביטלתי את התור שלך", { created: false, cancelled: true })).toBeNull();
  });
  it("does NOT flag a legitimate escalation ack", () => {
    expect(detectFalseCompletionClaim("העברתי את הפנייה לצוות, הם יחזרו אליך בהקדם", none)).toBeNull();
    expect(detectFalseCompletionClaim("אשמח לעזור לך לקבוע תור — רק אצטרך את מספר הטלפון", none)).toBeNull();
  });
  it("flags a booking claim when no create succeeded", () => {
    expect(detectFalseCompletionClaim("קבעתי לך תור ליום ראשון", none)).not.toBeNull();
  });
});

/* ------------- Group 14: rule 10 pricing (Phase 2) ------------------------ */
describe("rule 10 — pricing intent + treatment-price guardrail", () => {
  it("treatment price question → treatment_price", () => {
    expect(classifyPriceIntent("כמה עולה בוטוקס?")).toBe("treatment_price");
    expect(classifyPriceIntent("מה המחיר של מילוי שפתיים")).toBe("treatment_price");
  });
  it("consultation price question → consultation_price", () => {
    expect(classifyPriceIntent("כמה עולה ייעוץ?")).toBe("consultation_price");
    expect(classifyPriceIntent("מה המחיר של הייעוץ")).toBe("consultation_price");
  });
  it("non-price / discount message → null (not a price question)", () => {
    expect(classifyPriceIntent("אני רוצה לקבוע תור")).toBeNull();
    expect(classifyPriceIntent("אפשר הנחה?")).toBeNull();
  });
  it("discount/haggle still escalates as sales_inquiry (rule 5)", () => {
    expect(classifyEscalation("זה יקר, אפשר הנחה?")).toBe("sales_inquiry");
  });
  it("a plain treatment-price question no longer escalates as sales", () => {
    expect(classifyEscalation("כמה עולה בוטוקס?")).toBeUndefined();
  });
  it("guardrail: a treatment reply naming a non-consultation price is flagged", () => {
    expect(detectTreatmentPriceLeak("בוטוקס עולה 800 ₪", "treatment_price")).toBe(true);
  });
  it("guardrail: mentioning only the 100₪ consultation price on a treatment question is NOT a leak", () => {
    expect(detectTreatmentPriceLeak("המחיר נקבע בייעוץ; הייעוץ עולה 100 ₪", "treatment_price")).toBe(false);
  });
  it("guardrail: no flag for consultation-price / non-price intents", () => {
    expect(detectTreatmentPriceLeak("הייעוץ עולה 100 ₪", "consultation_price")).toBe(false);
    expect(detectTreatmentPriceLeak("בוטוקס עולה 800 ₪", null)).toBe(false);
  });
  it("consultation price constant is 100", () => {
    expect(CONSULTATION_PRICE_ILS).toBe(100);
  });
});

/* ------------- Group 15: business hours (Phase 2) ------------------------- */
describe("withinHours — provisional clinic hours", () => {
  it("Wed noon → open", () => expect(withinHours(3, 12)).toBe(true));
  it("Wed 20:00 → closed", () => expect(withinHours(3, 20)).toBe(false));
  it("Fri 10:00 → open; Fri 15:00 → closed", () => {
    expect(withinHours(5, 10)).toBe(true);
    expect(withinHours(5, 15)).toBe(false);
  });
  it("Saturday → closed all day", () => expect(withinHours(6, 12)).toBe(false));
  it("before opening (08:00) → closed", () => expect(withinHours(1, 8)).toBe(false));
});

/* ------------- Group 13: Hebrew lint (Issue 4) ---------------------------- */
describe("hebrewLint — banned phrases + foreign-script garble", () => {
  it("flags banned 'בואנו'", () => {
    expect(hebrewLint("בואנו נבדוק את הזמינות")).toHaveLength(1);
    expect(hebrewLint("בואנו נבדוק")[0]).toContain("בוא");
  });
  it("flags banned 'בחכייה'", () => {
    expect(hebrewLint("אנחנו בחכייה לך")).toHaveLength(1);
  });
  it("flags foreign-script garble (e.g. stray CJK/Hangul)", () => {
    expect(hebrewLint("בוטוקס זה טיפול멋진")).toContain("foreign-script garble");
  });
  it("clean, correct Hebrew → no issues", () => {
    expect(hebrewLint("בוא נבדוק את הזמינות, מחכים לך ביום ראשון 🙂")).toEqual([]);
  });

  it("flags a slash gender form like 'מעביר/ה'", () => {
    expect(hebrewLint("אני מעביר/ה את זה לצוות").some((i) => i.includes("slash"))).toBe(true);
  });
  it("flags the 'לקבוע/לשנות' slash form", () => {
    expect(hebrewLint("יש תור שתרצי לקבוע/לשנות?").some((i) => i.includes("slash"))).toBe(true);
  });
  it("does NOT treat a date or space-separated names as a slash form", () => {
    expect(hebrewLint("נדבר ב-12/2026")).toEqual([]);
    expect(hebrewLint("דנה / רות יחזרו אלייך")).toEqual([]);
  });
  it("flags banned corporate phrasing", () => {
    expect(hebrewLint("הצוות המקצועי שלנו יטפל בזה").some((i) => i.includes("הצוות המקצועי"))).toBe(true);
    expect(hebrewLint("הם יידעו להתייחס לזה כמו שצריך").length).toBeGreaterThan(0);
    expect(hebrewLint("אני מבין שזה לא נוח").length).toBeGreaterThan(0);
  });
  it("flags an overly long reply (>5 non-empty lines)", () => {
    const long = ["שורה 1", "שורה 2", "שורה 3", "שורה 4", "שורה 5", "שורה 6"].join("\n");
    expect(hebrewLint(long).some((i) => i.includes("too long"))).toBe(true);
  });
  it("a short warm reply (feminine, no slashes, ≤5 lines) → no issues", () => {
    const ok =
      "אוי, מצטערת לשמוע 💙\nהעברתי עכשיו לדנה ולורות והן יחזרו אלייך בהקדם.\nאם זה מחמיר בינתיים — אל תחכי, תתקשרי אלינו.";
    expect(hebrewLint(ok)).toEqual([]);
  });
  it("flags masculine spelling 'אליך' (feminine is 'אלייך'), but not 'אלייך' itself", () => {
    expect(hebrewLint("הן יחזרו אליך בהקדם").some((i) => i.includes("אלייך"))).toBe(true);
    expect(hebrewLint("הן יחזרו אלייך בהקדם")).toEqual([]);
  });
});

/* ------------- Group 14: pure-medical booking suppressor ----------------- */
describe("stripBookingPivot — drop a booking pivot from a pure-medical reply", () => {
  it("removes a trailing booking-pivot paragraph, keeps ack + escalation + safety", () => {
    const reply =
      "אוי, מצטערת לשמוע 💙\n\nהעברתי עכשיו לדנה ולורות, הן יחזרו אלייך בהקדם. אם זה מחמיר בינתיים — אל תחכי, תתקשרי אלינו.\n\nבואי נתייחסו גם לתור שלך — מה הטלפון שלך?";
    const out = stripBookingPivot(reply);
    expect(BOOKING_MENTION_RE.test(out)).toBe(false);
    expect(out).toContain("מצטערת לשמוע");
    expect(out).toContain("דנה ולורות");
    expect(out).toContain("אל תחכי, תתקשרי אלינו");
  });
  it("removes a booking sentence embedded in a single-line reply", () => {
    const reply = "אוי, מצטערת לשמוע 💙 העברתי לדנה ולורות, יחזרו אלייך. בואי נקבע גם תור, מה הטלפון?";
    const out = stripBookingPivot(reply);
    expect(BOOKING_MENTION_RE.test(out)).toBe(false);
    expect(out).toContain("מצטערת לשמוע");
  });
  it("is a no-op when there is no booking language", () => {
    const reply = "אוי, מצטערת לשמוע 💙\nהעברתי לדנה ולורות, יחזרו אלייך בהקדם.";
    expect(stripBookingPivot(reply)).toBe(reply);
  });
  it("never returns empty, even if the whole reply is booking language", () => {
    expect(stripBookingPivot("לקבוע תור לייעוץ?").length).toBeGreaterThan(0);
  });
});

/* ------------- Group 15: internal-leak output filter (security) ----------- */
describe("redactInternalLeak — block prompt/tool/config disclosure in a reply", () => {
  it("replaces a reply that names internal tools + escalation categories", () => {
    const leaky = "הכללים שלי: אני קוראת ל-escalate_to_human עם category medical_symptom כשיש כאב, ו-create_appointment לקביעה.";
    const out = redactInternalLeak(leaky);
    expect(out.leaked.length).toBeGreaterThan(0);
    expect(out.text).not.toContain("escalate_to_human");
    expect(out.text).not.toContain("medical_symptom");
    expect(out.text).not.toContain("create_appointment");
  });
  it("catches the 'system prompt' phrase and config keys", () => {
    expect(redactInternalLeak("ה-system prompt שלי סודי").leaked.length).toBeGreaterThan(0);
    expect(redactInternalLeak("אני עובדת עם BOOKING_PROVIDER=mock").leaked.length).toBeGreaterThan(0);
  });
  it("passes a normal warm reply through unchanged", () => {
    const ok = "אוי, מצטערת לשמוע 💙 העברתי עכשיו לצוות, הן יחזרו אלייך בהקדם.";
    expect(redactInternalLeak(ok)).toEqual({ leaked: [], text: ok });
  });
  it("the safe replacement is a warm redirect, not empty", () => {
    const out = redactInternalLeak("search_patient get_available_slots");
    expect(out.text.length).toBeGreaterThan(0);
    expect(out.text).not.toContain("search_patient");
  });
});

/* ------------- Group 12: dead-end wait detection (Issue 3) ---------------- */
describe("isDeadEndWait — the agent asking the customer to hold, then stopping", () => {
  it("flags 'please wait' style promises", () => {
    expect(isDeadEndWait("תוכל להמתין רגע? אני בודק")).toBe(true);
    expect(isDeadEndWait("רק רגע ואחזור אליך")).toBe(true);
    expect(isDeadEndWait("שנייה אחת בבקשה")).toBe(true);
    expect(isDeadEndWait("תכף אחזור עם התשובה")).toBe(true);
  });
  it("does NOT flag an escalation ack or a real answer", () => {
    expect(isDeadEndWait("אחד/ת מהצוות יחזרו אליך בהקדם")).toBe(false);
    expect(isDeadEndWait("יש תור פנוי ביום ראשון ב-12:00")).toBe(false);
    expect(isDeadEndWait("רגע, הבנתי — אשמח לעזור")).toBe(false); // bare "רגע" isn't a wait promise
  });
});

/* ------------- Group 11: phone normalization (Issue 2) -------------------- */
describe("normalizePhone — all inbound formats collapse to local 0XXXXXXXXX", () => {
  it("whatsapp:+972 form", () => {
    expect(normalizePhone("whatsapp:+972559415600")).toBe("0559415600");
  });
  it("+972 international form", () => {
    expect(normalizePhone("+972559415600")).toBe("0559415600");
  });
  it("bare 972 form", () => {
    expect(normalizePhone("972559415600")).toBe("0559415600");
  });
  it("already-local form is unchanged", () => {
    expect(normalizePhone("0559415600")).toBe("0559415600");
  });
  it("strips separators (dashes/spaces)", () => {
    expect(normalizePhone("055-941-5600")).toBe("0559415600");
    expect(normalizePhone("whatsapp:+972 55 941 5600")).toBe("0559415600");
  });
  it("all four formats of ONE number resolve equal", () => {
    const forms = ["whatsapp:+972559415600", "+972559415600", "972559415600", "0559415600"];
    const normalized = forms.map(normalizePhone);
    expect(new Set(normalized).size).toBe(1);
  });
  it("edge: empty / non-numeric", () => {
    expect(normalizePhone("")).toBe("");
    expect(normalizePhone("שלום")).toBe("");
  });
  it("edge: non-IL number is left as-is (no 972 prefix)", () => {
    expect(normalizePhone("+1-415-555-0000")).toBe("14155550000");
  });
});

/* -------------------- Group 8: 24h cancellation (rule 8) ------------------ */
describe("gating group 8 — 24h cancellation window", () => {
  const now = new Date("2026-07-01T09:00:00Z");
  it("more than 24h before → allowed", () => {
    expect(gateCancellation(new Date("2026-07-03T09:00:00Z"), now).allow).toBe(true);
  });
  // edge: exactly 24h → allowed (>= 24)
  it("edge: exactly 24h before → allowed", () => {
    expect(gateCancellation(new Date("2026-07-02T09:00:00Z"), now).allow).toBe(true);
  });
  it("edge: just under 24h → escalate late_cancellation", () => {
    const r = gateCancellation(new Date("2026-07-02T08:59:00Z"), now);
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.escalate).toBe("late_cancellation");
  });
  it("israelInstant produces a comparable UTC instant", () => {
    // 2026-07-06 is summer (IDT = UTC+3), so 12:00 local == 09:00Z.
    expect(israelInstant("2026-07-06", "12:00:00").toISOString()).toBe("2026-07-06T09:00:00.000Z");
  });
});
