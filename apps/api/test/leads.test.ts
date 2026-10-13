import { describe, it, expect, vi } from "vitest";
vi.mock("../src/db", () => ({ supabase: {} }));
import { resolveContact, buildContactContext, type ContactDeps } from "../src/leads";

const BIZ = "biz-1";

/** In-memory deps so the status/dedup logic is unit-tested WITHOUT a database. */
function makeDeps(seedPatients: { fullName?: string }[] = []) {
  const leads = new Map<string, { created_at?: string }>();
  const createCalls: string[] = [];
  const deps: ContactDeps = {
    searchPatient: async () => seedPatients,
    findLead: async (_biz, phone) => leads.get(phone) ?? null,
    createLead: async (_biz, phone) => {
      createCalls.push(phone);
      leads.set(phone, { created_at: "2026-07-25T10:00:00Z" });
    },
  };
  return { deps, createCalls };
}

describe("resolveContact — deterministic identity + lead capture", () => {
  it("new phone → status 'new', a lead is created exactly once", async () => {
    const { deps, createCalls } = makeDeps();
    const r = await resolveContact("whatsapp:+972559415600", BIZ, deps);
    expect(r.status).toBe("new");
    expect(r.phone).toBe("0559415600"); // normalized
    expect(createCalls).toEqual(["0559415600"]);
  });

  it("same person, DIFFERENT formats → ONE lead, second is 'existing_lead' (dedup)", async () => {
    const { deps, createCalls } = makeDeps();
    await resolveContact("whatsapp:+972559415600", BIZ, deps);
    const second = await resolveContact("0559415600", BIZ, deps); // same number, local format
    expect(second.status).toBe("existing_lead");
    expect(createCalls).toEqual(["0559415600"]); // created only once
  });

  it("registered patient → status 'patient', FIRST NAME ONLY (surname minimized), NO lead created", async () => {
    const { deps, createCalls } = makeDeps([{ fullName: "מאיה כהן" }]);
    const r = await resolveContact("0501234567", BIZ, deps);
    expect(r.status).toBe("patient");
    expect(r.name).toBe("מאיה"); // G1: only the first name is used for personal address
    expect(r.context).not.toContain("כהן"); // surname never reaches the model context
    expect(createCalls).toEqual([]);
  });
});

describe("buildContactContext — injection strings", () => {
  it("new → says the inquiry is already saved and forbids inventing an explanation", () => {
    const s = buildContactContext("new");
    expect(s).toContain("פנייה חדשה");
    expect(s).toContain("כבר נשמרה");
    expect(s).toMatch(/אל תמציא|אל תאמר/);
  });
  it("existing_lead → don't re-ask / don't say not-found, includes the since date", () => {
    const s = buildContactContext("existing_lead", { since: "2026-07-20" });
    expect(s).toContain("כבר נקלט");
    expect(s).toContain("2026-07-20");
    expect(s).toMatch(/אל תבקש/);
  });
  it("patient → names the patient and says don't re-ask for the number", () => {
    const s = buildContactContext("patient", { name: "נועה" });
    expect(s).toContain("נועה");
    expect(s).toContain("מטופלת רשומה");
  });
});
