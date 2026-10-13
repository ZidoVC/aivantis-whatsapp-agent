import { describe, it, expect, vi, afterEach } from "vitest";
import {
  escalationChannel,
  resolveEscalationPhone,
  formatEscalationMessage,
  notifyEscalation,
  twilioWhatsAppSender,
  checkEscalationChannelAtStartup,
  type EscalationEvent,
} from "../src/escalation-notify";

const AT = new Date("2026-07-25T09:30:00.000Z");

function event(
  category: EscalationEvent["category"],
  over: Partial<EscalationEvent> = {},
): EscalationEvent {
  return {
    category,
    customerMessage: "כואב לי אחרי הטיפול",
    customerPhone: "whatsapp:+972500000000",
    at: AT,
    ...over,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("escalationChannel — category -> staff channel", () => {
  it("routes medical_symptom to the medical channel", () => {
    expect(escalationChannel("medical_symptom")).toBe("medical");
  });
  it("routes every non-medical category to the service channel", () => {
    for (const c of [
      "general_complaint",
      "sales_inquiry",
      "staff_approval_needed",
      "reschedule_request",
      "late_cancellation",
    ] as const) {
      expect(escalationChannel(c)).toBe("service");
    }
  });
});

describe("resolveEscalationPhone — routing + fallback", () => {
  const FULL = {
    ESCALATION_PHONE_MEDICAL: "+972500000001",
    ESCALATION_PHONE_SERVICE: "+972500000002",
    ESCALATION_PHONE_DEFAULT: "+972500000009",
  };

  it("medical -> the medical number", () => {
    expect(resolveEscalationPhone("medical_symptom", FULL)).toBe("+972500000001");
  });

  it("service -> the service number", () => {
    expect(resolveEscalationPhone("general_complaint", FULL)).toBe("+972500000002");
    expect(resolveEscalationPhone("sales_inquiry", FULL)).toBe("+972500000002");
    expect(resolveEscalationPhone("late_cancellation", FULL)).toBe("+972500000002");
  });

  it("prefers the specific channel number over the default", () => {
    expect(resolveEscalationPhone("medical_symptom", FULL)).not.toBe(FULL.ESCALATION_PHONE_DEFAULT);
  });

  it("falls back to DEFAULT when the specific channel number is unset or empty", () => {
    expect(resolveEscalationPhone("medical_symptom", { ESCALATION_PHONE_DEFAULT: "+972500000009" })).toBe(
      "+972500000009",
    );
    expect(
      resolveEscalationPhone("general_complaint", {
        ESCALATION_PHONE_SERVICE: "",
        ESCALATION_PHONE_DEFAULT: "+972500000009",
      }),
    ).toBe("+972500000009");
  });

  it("returns undefined when nothing is configured for that channel", () => {
    expect(resolveEscalationPhone("medical_symptom", {})).toBeUndefined();
    // service unset and no default -> undefined, even though a medical number exists
    expect(
      resolveEscalationPhone("general_complaint", { ESCALATION_PHONE_MEDICAL: "+972500000001" }),
    ).toBeUndefined();
  });
});

describe("notifyEscalation — send + failure safety", () => {
  const ENV = { ESCALATION_PHONE_MEDICAL: "+972500000001", ESCALATION_PHONE_SERVICE: "+972500000002" };

  it("sends to the routed number and reports sent:true", async () => {
    const send = vi.fn(async () => {});
    const res = await notifyEscalation(event("medical_symptom"), { send, env: ENV });
    expect(res).toEqual({ sent: true, to: "+972500000001" });
    expect(send).toHaveBeenCalledOnce();
    const [to, body] = send.mock.calls[0] as [string, string];
    expect(to).toBe("+972500000001");
    expect(body).toContain("medical_symptom");
  });

  it("routes a service category to the service number", async () => {
    const send = vi.fn(async () => {});
    const res = await notifyEscalation(event("general_complaint"), { send, env: ENV });
    expect(res.sent).toBe(true);
    expect((send.mock.calls[0] as [string, string])[0]).toBe("+972500000002");
  });

  it("FAILURE PATH: a send error is caught, logged loudly, and never thrown", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const send = vi.fn(async () => {
      throw new Error("twilio 500");
    });
    const res = await notifyEscalation(event("general_complaint"), { send, env: ENV });
    expect(res.sent).toBe(false);
    expect(errSpy.mock.calls.flat().join(" ")).toContain("[escalation-notify-failed]");
  });

  it("no configured phone: logs [escalation-notify-failed] and never calls send", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const send = vi.fn(async () => {});
    const res = await notifyEscalation(event("medical_symptom"), { send, env: {} });
    expect(res.sent).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.flat().join(" ")).toContain("[escalation-notify-failed]");
  });
});

describe("formatEscalationMessage", () => {
  it("includes category, customer phone (whatsapp: stripped), message and timestamp", () => {
    const body = formatEscalationMessage(event("medical_symptom"));
    expect(body).toContain("medical_symptom");
    expect(body).toContain("+972500000000");
    expect(body).not.toContain("whatsapp:");
    expect(body).toContain("כואב לי אחרי הטיפול");
    expect(body).toContain(AT.toISOString());
  });
});

describe("notifyEscalation — durable 'unnotified' hook (onUndelivered)", () => {
  const ENV = { ESCALATION_PHONE_MEDICAL: "+972500000001", ESCALATION_PHONE_SERVICE: "+972500000002" };

  it("invokes onUndelivered with reason 'send_error' when the send throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onUndelivered = vi.fn();
    const send = vi.fn(async () => {
      throw new Error("twilio down");
    });
    const res = await notifyEscalation(event("medical_symptom"), { send, env: ENV, onUndelivered });
    expect(res.sent).toBe(false);
    expect(onUndelivered).toHaveBeenCalledOnce();
    expect(onUndelivered.mock.calls[0][0]).toMatchObject({ category: "medical_symptom", reason: "send_error" });
  });

  it("invokes onUndelivered with reason 'no_phone' when nothing is configured, and never sends", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onUndelivered = vi.fn();
    const send = vi.fn(async () => {});
    await notifyEscalation(event("medical_symptom"), { send, env: {}, onUndelivered });
    expect(send).not.toHaveBeenCalled();
    expect(onUndelivered.mock.calls[0][0]).toMatchObject({ reason: "no_phone" });
  });

  it("invokes onUndelivered with reason 'sender_not_configured' when the sender is null", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onUndelivered = vi.fn();
    const res = await notifyEscalation(event("general_complaint"), { send: null, env: ENV, onUndelivered });
    expect(res.sent).toBe(false);
    expect(onUndelivered.mock.calls[0][0]).toMatchObject({ reason: "sender_not_configured" });
  });

  it("does NOT invoke onUndelivered on a successful send", async () => {
    const onUndelivered = vi.fn();
    const send = vi.fn(async () => {});
    const res = await notifyEscalation(event("medical_symptom"), { send, env: ENV, onUndelivered });
    expect(res.sent).toBe(true);
    expect(onUndelivered).not.toHaveBeenCalled();
  });

  it("never throws even if onUndelivered itself throws (last line of defense)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onUndelivered = vi.fn(() => {
      throw new Error("db down");
    });
    const send = vi.fn(async () => {
      throw new Error("twilio down");
    });
    const res = await notifyEscalation(event("medical_symptom"), { send, env: ENV, onUndelivered });
    expect(res.sent).toBe(false);
  });
});

describe("checkEscalationChannelAtStartup — boot-time channel health", () => {
  const FULL = {
    TWILIO_ACCOUNT_SID: "AC",
    TWILIO_AUTH_TOKEN: "t",
    TWILIO_WHATSAPP_FROM: "whatsapp:+1",
    ESCALATION_PHONE_DEFAULT: "+972500000009",
  };

  it("returns no problems when the sender and a phone are configured", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(checkEscalationChannelAtStartup(FULL)).toEqual([]);
  });

  it("flags a missing Twilio sender", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const problems = checkEscalationChannelAtStartup({ ESCALATION_PHONE_DEFAULT: "+9725" });
    expect(problems.join(" ")).toMatch(/twilio/i);
  });

  it("flags both channels when no escalation phone is set at all", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const problems = checkEscalationChannelAtStartup({
      TWILIO_ACCOUNT_SID: "AC",
      TWILIO_AUTH_TOKEN: "t",
      TWILIO_WHATSAPP_FROM: "whatsapp:+1",
    });
    expect(problems.join(" ")).toMatch(/medical/i);
    expect(problems.join(" ")).toMatch(/service/i);
  });

  it("a single ESCALATION_PHONE_DEFAULT satisfies both channels", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(checkEscalationChannelAtStartup(FULL).join(" ")).not.toMatch(/phone/i);
  });

  it("logs a loud [escalation-channel] warning when degraded", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkEscalationChannelAtStartup({});
    expect(warn.mock.calls.flat().join(" ")).toContain("[escalation-channel]");
  });
});

describe("twilioWhatsAppSender — config guard", () => {
  it("returns null unless account sid + auth token + from are all set", () => {
    expect(twilioWhatsAppSender({})).toBeNull();
    expect(twilioWhatsAppSender({ TWILIO_ACCOUNT_SID: "AC", TWILIO_AUTH_TOKEN: "t" })).toBeNull();
    expect(
      twilioWhatsAppSender({ TWILIO_ACCOUNT_SID: "AC", TWILIO_AUTH_TOKEN: "t", TWILIO_WHATSAPP_FROM: "whatsapp:+1" }),
    ).toBeTypeOf("function");
  });
});
