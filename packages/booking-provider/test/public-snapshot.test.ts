import { describe, expect, it } from "vitest";
import { getProvider } from "../src/index";

describe("public Mock-only snapshot", () => {
  it("creates a working Mock provider", async () => {
    expect((await getProvider({ provider: "mock" }).healthCheck()).ok).toBe(true);
  });
  it("refuses Optima even with credentials", () => {
    expect(() => getProvider({ provider: "optima", optima: {
      baseUrl: "https://example.invalid", username: "demo", password: "demo", company: "demo",
    } })).toThrow("excluded");
  });
});
