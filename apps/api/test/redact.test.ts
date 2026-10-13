import { describe, it, expect } from "vitest";
import { redactPhone, redactId, redactForModel, firstNameOnly } from "../src/redact";

describe("redactPhone — Israeli phone formats → placeholder", () => {
  it("mobile 05x (with and without separators)", () => {
    expect(redactPhone("0501234567")).toBe("«טלפון»");
    expect(redactPhone("050-123-4567")).toBe("«טלפון»");
    expect(redactPhone("054 987 6543")).toBe("«טלפון»");
  });
  it("+972 / 972 international", () => {
    expect(redactPhone("+972501234567")).toBe("«טלפון»");
    expect(redactPhone("972-50-1234567")).toBe("«טלפון»");
  });
  it("whatsapp:+972 address", () => {
    expect(redactPhone("whatsapp:+972501234567")).toBe("«טלפון»");
  });
  it("embedded in a sentence — strips the number, keeps the words", () => {
    const out = redactPhone("תתקשרו אליי ל 054 9876543 בבוקר");
    expect(out).toContain("«טלפון»");
    expect(out).not.toMatch(/\d{5,}/);
    expect(out).toContain("תתקשרו אליי");
    expect(out).toContain("בבוקר");
  });

  // CRITICAL false positives — these must NOT be touched
  it("does NOT strip a time", () => {
    expect(redactPhone("בשעה 14:30")).toBe("בשעה 14:30");
    expect(redactPhone("09:00:00")).toBe("09:00:00");
    expect(redactPhone("00:15")).toBe("00:15");
  });
  it("does NOT strip a date", () => {
    expect(redactPhone("בתאריך 24/07/2026")).toBe("בתאריך 24/07/2026");
    expect(redactPhone("24.07")).toBe("24.07");
  });
  it("does NOT strip a price", () => {
    expect(redactPhone("המחיר 100 ₪")).toBe("המחיר 100 ₪");
    expect(redactPhone("350 שקל")).toBe("350 שקל");
  });
  it("does NOT strip a duration or small counts", () => {
    expect(redactPhone("משך 15 דקות")).toBe("משך 15 דקות");
    expect(redactPhone("תור ל-3 אנשים")).toBe("תור ל-3 אנשים");
  });
});

describe("redactId — Israeli ת.ז → placeholder", () => {
  it("labeled ID", () => {
    expect(redactId("ת.ז 305612349").includes("305612349")).toBe(false);
    expect(redactId("תעודת זהות 305612349").includes("305612349")).toBe(false);
    expect(redactId("מספר זהות 305612349")).toContain("«ת.ז»");
  });
  it("bare 9-digit ID", () => {
    expect(redactId("305612349")).toBe("«ת.ז»");
    expect(redactId("הזהות שלי היא 305612349, תודה").includes("305612349")).toBe(false);
  });
  it("does NOT strip times / dates / prices / durations", () => {
    expect(redactId("בשעה 14:30")).toBe("בשעה 14:30");
    expect(redactId("24/07/2026")).toBe("24/07/2026");
    expect(redactId("100 ₪")).toBe("100 ₪");
    expect(redactId("15 דקות")).toBe("15 דקות");
  });
});

describe("redactForModel — combined layer (content/name preserved)", () => {
  it("strips phone + ID but keeps the customer's words and first name", () => {
    const msg = "היי, קוראים לי דנה, הטלפון שלי 0501234567 והת.ז 305612349, רוצה תור";
    const out = redactForModel(msg);
    expect(out).not.toMatch(/\d{9,}/);
    expect(out).toContain("דנה"); // name in message body is content — NOT redacted
    expect(out).toContain("רוצה תור");
    expect(out).toContain("«טלפון»");
    expect(out).toContain("«ת.ז»");
  });
  it("leaves a normal medical/booking message untouched", () => {
    const msg = "עשיתי טיפול אתמול וכואב לי, אפשר תור ליום ראשון ב-14:30?";
    expect(redactForModel(msg)).toBe(msg);
  });
});

describe("firstNameOnly — surname minimization for the lookup context", () => {
  it("returns only the first token", () => {
    expect(firstNameOnly("דנה כהן")).toBe("דנה");
    expect(firstNameOnly("  רות  דמו ")).toBe("רות");
    expect(firstNameOnly("דנה")).toBe("דנה");
  });
  it("handles empty / undefined", () => {
    expect(firstNameOnly(undefined)).toBe("");
    expect(firstNameOnly("")).toBe("");
  });
});
