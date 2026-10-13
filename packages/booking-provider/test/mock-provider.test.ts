import { describe, it, expect, beforeEach } from "vitest";
import { getProvider, BookingError, type BookingProvider } from "../src/index";

// Fixed future dates that never collide with the seeded (today-relative) appointments.
const D1 = "2030-03-06";
// An 8-day span guarantees every weekday appears, so consultation/botox shifts exist.
const RANGE_START = "2030-03-03";
const RANGE_END = "2030-03-10";

describe("MockProvider (clinic model)", () => {
  let booking: BookingProvider;
  beforeEach(() => {
    booking = getProvider({ provider: "mock" });
  });

  it("healthCheck reports mock", async () => {
    const h = await booking.healthCheck();
    expect(h.ok).toBe(true);
    expect(h.details?.provider).toBe("mock");
  });

  it("getDoctorsSites returns providers with role + treatments", async () => {
    const docs = await booking.getDoctorsSites();
    expect(docs).toHaveLength(7);
    const DemoA = docs.find((d) => d.doctorCode === "CONSULT_A");
    const anatoli = docs.find((d) => d.doctorCode === "DOCTOR_A");
    expect(DemoA?.role).toBe("consultation");
    expect(anatoli?.role).toBe("doctor");
    expect(anatoli?.treatments).toContain("botox");
    // all nurses perform the same set
    const nurses = docs.filter((d) => d.role === "nurse");
    expect(nurses).toHaveLength(4);
    expect(nurses.every((n) => n.treatments?.includes("morpheus8"))).toBe(true);
  });

  describe("searchPatient (phone is the primary key)", () => {
    it("finds by phone", async () => {
      const res = await booking.searchPatient("0529876543");
      expect(res[0]?.id).toBe("1002");
    });
    it("finds by partial phone digits", async () => {
      const res = await booking.searchPatient("050-123-4567");
      expect(res[0]?.id).toBe("1001");
    });
    it("still finds by name", async () => {
      const res = await booking.searchPatient("כהן");
      expect(res.map((p) => p.id)).toContain("1001");
    });
    it("returns all when query is empty, empty for no match", async () => {
      expect(await booking.searchPatient("")).toHaveLength(3);
      expect(await booking.searchPatient("זזזזז")).toEqual([]);
    });
  });

  describe("getAvailableSlots (schedule-driven)", () => {
    it("consultation slots come from DemoA/DemoB shifts", async () => {
      const slots = await booking.getAvailableSlots({
        start: RANGE_START,
        end: RANGE_END,
        treatmentCode: "consultation",
      });
      expect(slots.length).toBeGreaterThan(0);
      expect(slots.every((s) => s.role === "consultation")).toBe(true);
      expect(slots.every((s) => s.treatmentCode === "consultation")).toBe(true);
      expect(slots.every((s) => /^\d{2}:\d{2}:\d{2}$/.test(s.startTime))).toBe(true);
      expect(slots.every((s) => s.durationMinutes === 30)).toBe(true);
    });

    it("botox slots come from the injector doctor only", async () => {
      const slots = await booking.getAvailableSlots({
        start: RANGE_START,
        end: RANGE_END,
        treatmentCode: "botox",
      });
      expect(slots.length).toBeGreaterThan(0);
      expect(slots.every((s) => s.role === "doctor")).toBe(true);
      expect(slots.every((s) => s.doctorCode === "DOCTOR_A")).toBe(true);
    });

    it("unassigned filler treatments yield no self-service slots", async () => {
      const slots = await booking.getAvailableSlots({
        start: RANGE_START,
        end: RANGE_END,
        treatmentCode: "lips_filler",
      });
      expect(slots).toEqual([]);
    });

    it("never offers Saturday (no shifts)", async () => {
      const slots = await booking.getAvailableSlots({ start: RANGE_START, end: RANGE_END, treatmentCode: "consultation" });
      for (const s of slots) {
        expect(new Date(`${s.date}T00:00:00`).getDay()).not.toBe(6);
      }
    });

    it("provider_id filters to a single provider", async () => {
      const slots = await booking.getAvailableSlots({
        start: RANGE_START,
        end: RANGE_END,
        treatmentCode: "consultation",
        providerId: 1,
      });
      expect(slots.length).toBeGreaterThan(0);
      expect(slots.every((s) => s.doctorId === 1)).toBe(true);
    });
  });

  describe("getTreatments (catalog vs history)", () => {
    it("no patient id -> catalog with durations/roles", async () => {
      const catalog = await booking.getTreatments("");
      expect(catalog.length).toBeGreaterThanOrEqual(15);
      const botox = catalog.find((t) => t.code === "botox");
      const consult = catalog.find((t) => t.code === "consultation");
      expect(botox?.requiredRole).toBe("doctor");
      expect(botox?.durationMinutes).toBeGreaterThan(0);
      expect(consult?.requiredRole).toBe("consultation");
      // fillers are unassigned
      expect(catalog.find((t) => t.code === "lips_filler")?.requiredRole).toBeUndefined();
    });
    it("with patient id -> that patient's history", async () => {
      const hist = await booking.getTreatments("1001");
      expect(hist.map((t) => t.code).sort()).toEqual(["botox", "morpheus8"]);
    });
    it("unknown patient -> empty", async () => {
      expect(await booking.getTreatments("999999")).toEqual([]);
    });
  });

  describe("getPatientAppointments (active_series flag)", () => {
    it("returns the patient's appointments incl. type + active_series", async () => {
      const appts = await booking.getPatientAppointments("1001");
      expect(appts.length).toBeGreaterThanOrEqual(2);
      expect(appts.every((a) => a.patientId === "1001")).toBe(true);
      expect(appts.some((a) => a.activeSeries === true)).toBe(true);
      expect(appts.some((a) => a.type === "consultation" && a.completed === true)).toBe(true);
    });
  });

  describe("appointment write round-trip (mock store)", () => {
    it("create -> appears in list -> delete -> gone", async () => {
      const created = await booking.createAppointment({
        doctorCode: "CONSULT_A",
        date: D1,
        startTime: "11:00:00",
        durationMinutes: 30,
        type: "consultation",
        treatmentCode: "botox",
        cardId: "1002",
      });
      expect(created.ok).toBe(true);
      const listed = await booking.getAppointments(D1, D1);
      expect(listed.some((a) => a.id === created.id)).toBe(true);
      const del = await booking.deleteAppointment(created.id!);
      expect(del.ok).toBe(true);
      const after = await booking.getAppointments(D1, D1);
      expect(after.some((a) => a.id === created.id)).toBe(false);
    });

    it("modify/delete of a missing appointment throws BookingError", async () => {
      await expect(
        booking.modifyAppointment({ meetingId: "nope", date: D1, startTime: "10:00:00", durationMinutes: 30 }),
      ).rejects.toBeInstanceOf(BookingError);
      await expect(booking.deleteAppointment("nope")).rejects.toBeInstanceOf(BookingError);
    });
  });

  it("contacts + leads work; instances are isolated", async () => {
    const created = await booking.createContact({ firstName: "טל", lastName: "אבני", cellPhone: "0501110000" });
    expect((await booking.searchPatient("0501110000"))[0]?.id).toBe(created.id);
    expect((await booking.addLead({ name: "מתעניין", phone: "0500000000" })).ok).toBe(true);

    const other = getProvider({ provider: "mock" });
    expect(await other.searchPatient("0501110000")).toEqual([]);
  });
});
