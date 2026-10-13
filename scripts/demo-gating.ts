/**
 * Stage 4 demo — write tools driven THROUGH the gating layer, against MockProvider.
 * Deterministic (no LLM): calls runWriteTool directly with a controlled `now` so the
 * actual enforcement result of each flow is unambiguous.
 *
 * Run:  pnpm demo:gating
 */

import { getProvider } from "../packages/booking-provider/src/index";
import { runWriteTool } from "../apps/api/src/write-tools";
import { classifyEscalation, israelInstant } from "../apps/api/src/gating";

const booking = getProvider({ provider: "mock" });

function iso(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function flow(title: string, name: string, input: unknown, now?: Date): Promise<void> {
  const r = await runWriteTool(booking, name, input, now);
  console.log(`\n### ${title}`);
  console.log(`   ${name}(${JSON.stringify(input)})`);
  console.log(`   → ${r.content}${r.isError ? "   [rejected]" : ""}`);
}

async function main(): Promise<void> {
  // Seeded appt 9002 (patient 1001, morpheus8 active series) is at today+2 15:00.
  // Put "now" ~19h before it to exercise the <24h and <48h windows.
  const apptStart = israelInstant(iso(2), "15:00:00");
  const nowLate = new Date(apptStart.getTime() - 19 * 3_600_000);

  console.log("=================== STAGE 4 — 6 FLOWS THROUGH GATING ===================");

  // 1) New lead books a CONSULTATION → allowed + booked.
  await flow(
    "1. לקוח חדש קובע ייעוץ → נקבע",
    "create_appointment",
    { type: "consultation", treatment_code: "botox", date: iso(7), start_time: "12:00:00", provider_code: "CONSULT_A", first_name: "רון", last_name: "שגב", phone: "0503334444" },
  );

  // 2) Existing patient asks for the NEXT session of an active series → staff approval.
  await flow(
    "2. אישור טיפול המשך (סדרה פעילה) → אישור צוות",
    "create_appointment",
    { type: "treatment", treatment_code: "morpheus8", date: iso(9), start_time: "15:00:00", provider_code: "NURSE_A", patient_id: "1001" },
  );

  // 3) Cancel < 24h before the appointment → late_cancellation escalation (not cancelled).
  await flow(
    "3. ביטול בתוך 24 שעות → הסלמה (לא מבוטל)",
    "cancel_appointment",
    { appointment_id: "9002", patient_id: "1001" },
    nowLate,
  );

  // 4) Reschedule the day before → escalation to front desk, urgency within_48h.
  await flow(
    "4. שינוי תור יום לפני → הסלמה לפקידה (urgency)",
    "request_reschedule",
    { appointment_id: "9002", patient_id: "1001", requested_date: iso(10), requested_time: "16:00:00" },
    nowLate,
  );

  // 5) Physical/medical complaint → medical_symptom → DemoA/DemoB.
  console.log(`\n   classifyEscalation("יש לי כאב ונפיחות אחרי הטיפול") = ${classifyEscalation("יש לי כאב ונפיחות אחרי הטיפול")}`);
  await flow(
    "5. תלונה פיזית → הסלמה לדנה/רות",
    "escalate_to_human",
    { category: "medical_symptom", summary: "כאב ונפיחות באזור הטיפול", patient_phone: "0501234567" },
  );

  // 6) Sales inquiry → sales_inquiry → human rep.
  console.log(`\n   classifyEscalation("אני רוצה לקנות עוד סדרה") = ${classifyEscalation("אני רוצה לקנות עוד סדרה")}`);
  await flow(
    "6. פנייה מכירתית → הסלמה לנציג",
    "escalate_to_human",
    { category: "sales_inquiry", summary: "רוצה לרכוש חבילת טיפולים נוספת" },
  );

  // 7) General/service complaint (NOT medical) → general_complaint → reception (Adi).
  console.log(`\n   classifyEscalation("אני מאוד לא מרוצה מהשירות") = ${classifyEscalation("אני מאוד לא מרוצה מהשירות")}`);
  await flow(
    "7. תלונה כללית/שירותית → הסלמה לקבלה (עדי)",
    "escalate_to_human",
    { category: "general_complaint", summary: "מאוד לא מרוצה מהשירות שקיבלתי" },
  );

  console.log("\n=================== BONUS — rule guards ===================");
  // New lead cannot book a treatment directly → forced to consultation.
  await flow(
    "בונוס: ליד חדש מבקש בוטוקס → נחסם, צריך ייעוץ",
    "create_appointment",
    { type: "treatment", treatment_code: "botox", date: iso(7), start_time: "10:00:00", provider_code: "DOCTOR_A", first_name: "דנה", phone: "0505556666" },
  );
  // Existing patient with clinic_override for botox → allowed direct.
  await flow(
    "בונוס: לקוחה ותיקה עם אישור לבוטוקס חוזר → נקבע ישירות",
    "create_appointment",
    { type: "treatment", treatment_code: "botox", date: iso(8), start_time: "10:30:00", provider_code: "DOCTOR_A", patient_id: "1001" },
  );
  // No compensation path — escalate rejects an invalid category.
  await flow(
    "בונוס: category לא תקין (offer_compensation) → נדחה",
    "escalate_to_human",
    { category: "offer_compensation", summary: "רוצה החזר" },
  );

  console.log("\nDONE");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
