import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getProvider, type BookingProvider } from "@aivantis/booking-provider";
import { runWriteTool, WRITE_TOOLS, isWriteTool } from "../src/write-tools";
import { READ_TOOLS } from "../src/booking-tools";
import { israelInstant } from "../src/gating";

function parse(content: string): any {
  return JSON.parse(content);
}

describe("write tools through gating", () => {
  let provider: BookingProvider;
  beforeEach(() => {
    provider = getProvider({ provider: "mock" });
  });

  /* ---- registry safety: no compensation / no modify, escalate is the only human path ---- */
  it("registry has exactly the 4 write tools, no compensation/modify", () => {
    const names = WRITE_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(["cancel_appointment", "create_appointment", "escalate_to_human", "request_reschedule"]);
    const all = [...READ_TOOLS, ...WRITE_TOOLS].map((t) => t.name);
    expect(all).not.toContain("offer_compensation");
    expect(all).not.toContain("modify_appointment");
    expect(all.filter((n) => /refund|compensat|modify/i.test(n))).toEqual([]);
    expect(isWriteTool("escalate_to_human")).toBe(true);
    expect(isWriteTool("search_patient")).toBe(false);
  });

  /* ---- create: consultation always allowed ---- */
  it("new lead books a consultation → booked", async () => {
    const r = await runWriteTool(provider, "create_appointment", {
      type: "consultation",
      date: "2030-05-04",
      start_time: "12:00:00",
      provider_code: "CONSULT_A",
      first_name: "רון",
      phone: "0503334444",
    });
    expect(parse(r.content).ok).toBe(true);
  });

  /* ---- rule 1: new lead cannot book treatment ---- */
  it("new lead requesting treatment → blocked, book consultation first", async () => {
    const r = await runWriteTool(provider, "create_appointment", {
      type: "treatment",
      treatment_code: "botox",
      date: "2030-05-04",
      start_time: "10:00:00",
      provider_code: "DOCTOR_A",
      phone: "0505556666",
    });
    const data = parse(r.content);
    expect(data.blocked).toBe(true);
    expect(data.action_required).toBe("book_consultation_first");
  });

  /* ---- rule 2: active series → staff approval ---- */
  it("existing patient, next session of active series → staff_approval_needed", async () => {
    const r = await runWriteTool(provider, "create_appointment", {
      type: "treatment",
      treatment_code: "morpheus8",
      date: "2030-05-05",
      start_time: "15:00:00",
      provider_code: "NURSE_A",
      patient_id: "1001",
    });
    expect(parse(r.content).category).toBe("staff_approval_needed");
  });

  /* ---- rule 3: override allows direct treatment ---- */
  it("existing patient with clinic_override for botox → booked directly", async () => {
    const r = await runWriteTool(provider, "create_appointment", {
      type: "treatment",
      treatment_code: "botox",
      date: "2030-05-06",
      start_time: "10:30:00",
      provider_code: "DOCTOR_A",
      patient_id: "1001",
    });
    expect(parse(r.content).ok).toBe(true);
  });

  it("treatment without treatment_code → validation error", async () => {
    const r = await runWriteTool(provider, "create_appointment", {
      type: "treatment",
      date: "2030-05-06",
      start_time: "10:30:00",
      provider_code: "DOCTOR_A",
      patient_id: "1001",
    });
    expect(r.isError).toBe(true);
  });

  /* ---- rule 8: cancellation window ---- */
  it("cancel > 24h before → actually cancelled", async () => {
    const appt = (await provider.getPatientAppointments("1001")).find((a) => a.id === "9002")!;
    const now = new Date(israelInstant(appt.date, appt.startTime).getTime() - 48 * 3_600_000);
    const r = await runWriteTool(provider, "cancel_appointment", { appointment_id: "9002", patient_id: "1001" }, now);
    expect(parse(r.content).cancelled).toBe(true);
    expect((await provider.getPatientAppointments("1001")).some((a) => a.id === "9002")).toBe(false);
  });

  it("cancel < 24h before → escalated, NOT cancelled", async () => {
    const appt = (await provider.getPatientAppointments("1001")).find((a) => a.id === "9002")!;
    const now = new Date(israelInstant(appt.date, appt.startTime).getTime() - 12 * 3_600_000);
    const r = await runWriteTool(provider, "cancel_appointment", { appointment_id: "9002", patient_id: "1001" }, now);
    const data = parse(r.content);
    expect(data.category).toBe("late_cancellation");
    expect(data.status).toBe("pending"); // louder result: escalation is explicitly NOT done
    expect(data.done).toBe(false);
    expect((await provider.getPatientAppointments("1001")).some((a) => a.id === "9002")).toBe(true);
  });

  // The live-test scenario: a NEW lead (no patient_id, no verifiable booking) says "cancel".
  // Must fail-closed to an escalation and delete NOTHING — never claim/execute a cancellation.
  it("cancel an unverifiable booking (no patient_id / unknown id) → escalated, nothing deleted", async () => {
    const before = (await provider.getPatientAppointments("1001")).length;
    const r = await runWriteTool(provider, "cancel_appointment", { appointment_id: "does-not-exist" });
    const data = parse(r.content);
    expect(data.category).toBe("late_cancellation");
    expect(data.status).toBe("pending");
    expect(data.done).toBe(false);
    // seeded appointments are all still present — nothing was cancelled
    expect((await provider.getPatientAppointments("1001")).length).toBe(before);
  });

  /* ---- rule 4: reschedule never modifies ---- */
  it("reschedule → escalated to front desk, appointment untouched", async () => {
    const before = (await provider.getPatientAppointments("1001")).find((a) => a.id === "9002")!;
    const r = await runWriteTool(provider, "request_reschedule", {
      appointment_id: "9002",
      patient_id: "1001",
      requested_date: "2030-05-20",
    });
    const data = parse(r.content);
    expect(data.category).toBe("reschedule_request");
    expect(["within_48h", "standard"]).toContain(data.urgency);
    const after = (await provider.getPatientAppointments("1001")).find((a) => a.id === "9002")!;
    expect(after.date).toBe(before.date); // unchanged
    expect(after.startTime).toBe(before.startTime);
  });

  /* ---- rules 5/6/7: escalate_to_human ---- */
  it("escalate_to_human with valid category routes correctly", async () => {
    const r = await runWriteTool(provider, "escalate_to_human", {
      category: "medical_symptom",
      summary: "כאב ונפיחות",
    });
    const data = parse(r.content);
    expect(data.escalated).toBe(true);
    expect(data.status).toBe("pending");
    expect(data.done).toBe(false);
    expect(data.routed_to).toContain("דנה");
  });

  it("escalate_to_human rejects an invalid category (no compensation path)", async () => {
    const r = await runWriteTool(provider, "escalate_to_human", { category: "offer_compensation", summary: "x" });
    expect(r.isError).toBe(true);
  });
});

/* ---- A5a: Optima cardId application guard (optima-gated) ---- */
describe("create_appointment — Optima cardId guard", () => {
  let provider: BookingProvider;
  const ORIG = process.env.BOOKING_PROVIDER;
  const base = { type: "consultation", date: "2030-05-04", start_time: "12:00:00", provider_code: "CONSULT_A" };

  beforeEach(() => {
    provider = getProvider({ provider: "mock" });
  });
  afterEach(() => {
    if (ORIG === undefined) delete process.env.BOOKING_PROVIDER;
    else process.env.BOOKING_PROVIDER = ORIG;
  });

  it("Optima active + no patient_id → BLOCKED, provider NOT invoked", async () => {
    process.env.BOOKING_PROVIDER = "optima";
    const spy = vi.spyOn(provider, "createAppointment");
    const r = await runWriteTool(provider, "create_appointment", { ...base, phone: "0503334444" });
    const d = parse(r.content);
    expect(d.ok).toBe(false);
    expect(d.blocked).toBe(true);
    expect(d.booked).toBe(false);
    expect(d.action_required).toBe("capture_as_lead");
    expect(d.reason).toBe("no_verified_patient_id");
    expect(r.isError).toBeUndefined(); // controlled block, not a transport error
    expect(spy).not.toHaveBeenCalled();
  });

  it("Optima active + patient_id '0' → BLOCKED, provider NOT invoked", async () => {
    process.env.BOOKING_PROVIDER = "optima";
    const spy = vi.spyOn(provider, "createAppointment");
    const r = await runWriteTool(provider, "create_appointment", { ...base, patient_id: "0" });
    expect(parse(r.content).blocked).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("Optima active + valid patient_id → booking proceeds with the exact id", async () => {
    process.env.BOOKING_PROVIDER = "optima";
    const spy = vi.spyOn(provider, "createAppointment");
    const r = await runWriteTool(provider, "create_appointment", { ...base, patient_id: "1001" });
    expect(parse(r.content).ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0][0] as { cardId?: string }).cardId).toBe("1001");
  });

  it("mock mode + no patient_id → UNCHANGED (books anonymously, by design)", async () => {
    process.env.BOOKING_PROVIDER = "mock";
    const r = await runWriteTool(provider, "create_appointment", { ...base, phone: "0503334444" });
    expect(parse(r.content).ok).toBe(true);
  });
});
