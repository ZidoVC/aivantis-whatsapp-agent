import { describe, it, expect, beforeEach } from "vitest";
import { getProvider, type BookingProvider } from "@aivantis/booking-provider";
import { runReadTool, READ_TOOLS } from "../src/booking-tools";

const RANGE = { start: "2030-03-03", end: "2030-03-10" };

function parse(content: string): any {
  return JSON.parse(content);
}

describe("read tools", () => {
  let provider: BookingProvider;
  beforeEach(() => {
    provider = getProvider({ provider: "mock" });
  });

  it("exposes exactly the 5 read tools", () => {
    expect(READ_TOOLS.map((t) => t.name).sort()).toEqual(
      ["get_available_slots", "get_doctors_sites", "get_patient_appointments", "get_treatments", "search_patient"],
    );
  });

  describe("search_patient", () => {
    it("finds by phone (valid)", async () => {
      const r = await runReadTool(provider, "search_patient", { query: "0529876543" });
      expect(r.isError).toBeFalsy();
      expect(parse(r.content)[0].id).toBe("1002");
    });
    it("empty query → friendly error", async () => {
      const r = await runReadTool(provider, "search_patient", { query: "" });
      expect(r.isError).toBe(true);
      expect(r.content).toContain("טלפון");
    });
  });

  describe("get_available_slots", () => {
    it("consultation slots (valid)", async () => {
      const r = await runReadTool(provider, "get_available_slots", { ...RANGE, treatment_type: "consultation" });
      const data = parse(r.content);
      expect(data.total).toBeGreaterThan(0);
      expect(data.slots.every((s: any) => s.role === "consultation")).toBe(true);
    });
    it("bad dates → friendly error", async () => {
      const r = await runReadTool(provider, "get_available_slots", { start: "nope", end: "x" });
      expect(r.isError).toBe(true);
      expect(r.content).toContain("YYYY-MM-DD");
    });
  });

  it("get_doctors_sites returns providers with role + no raw leakage", async () => {
    const r = await runReadTool(provider, "get_doctors_sites", {});
    expect(r.content).not.toContain('"raw"');
    const docs = parse(r.content);
    expect(docs).toHaveLength(7);
    expect(docs.some((d: any) => d.role === "doctor")).toBe(true);
  });

  describe("get_treatments", () => {
    it("catalog when no patient id", async () => {
      const r = await runReadTool(provider, "get_treatments", {});
      const cat = parse(r.content);
      expect(cat.find((t: any) => t.code === "botox").requiredRole).toBe("doctor");
    });
    it("history with patient id", async () => {
      const r = await runReadTool(provider, "get_treatments", { patient_id: "1001" });
      expect(parse(r.content).map((t: any) => t.code).sort()).toEqual(["botox", "morpheus8"]);
    });
  });

  describe("get_patient_appointments", () => {
    it("returns active_series flag (valid)", async () => {
      const r = await runReadTool(provider, "get_patient_appointments", { patient_id: "1001" });
      expect(parse(r.content).some((a: any) => a.activeSeries === true)).toBe(true);
    });
    it("missing patient id → friendly error", async () => {
      const r = await runReadTool(provider, "get_patient_appointments", {});
      expect(r.isError).toBe(true);
    });
  });

  it("unknown read tool → error (no crash)", async () => {
    const r = await runReadTool(provider, "delete_everything", {});
    expect(r.isError).toBe(true);
  });
});
