/**
 * Demo of the agent wired to the booking-provider (READ-ONLY, MockProvider).
 *
 * Part A: deterministic tool-layer run (no LLM) — proves each tool works + the
 *         friendly validation/error handling, free and offline.
 * Part B: a real WhatsApp-style conversation through askAgent (uses the Claude API
 *         via ANTHROPIC_API_KEY). Skipped automatically if the key is absent.
 *
 * BOOKING_PROVIDER stays mock; no write tools exist.
 *
 * Run:  pnpm demo:agent
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config as loadEnv } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
loadEnv({ path: join(repoRoot, "apps/api/.env"), quiet: true });
process.env.AGENT_DEBUG = process.env.AGENT_DEBUG ?? "1"; // show tool calls in this demo

import { getProvider } from "../packages/booking-provider/src/index";
import { runReadTool } from "../apps/api/src/booking-tools";

type Msg = { role: "user" | "assistant"; content: string };

function isoPlus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)} …(truncated)` : s;
}

async function toolLayerDemo(): Promise<void> {
  console.log("\n########## DEMO A — tool layer vs MockProvider (no LLM) ##########");
  const mock = getProvider({ provider: "mock" });
  const calls: Array<[string, unknown]> = [
    ["get_doctors_sites", {}],
    ["search_patient", { query: "0501234567" }], // phone-first lookup
    ["get_treatments", {}], // catalog (durations / required_role)
    ["get_available_slots", { start: isoPlus(1), end: isoPlus(7), treatment_type: "consultation" }],
    ["get_available_slots", { start: isoPlus(1), end: isoPlus(7), treatment_type: "botox" }],
    ["get_available_slots", { start: isoPlus(1), end: isoPlus(7), treatment_type: "lips_filler" }], // unassigned → []
    ["get_patient_appointments", { patient_id: "1001" }], // includes active_series
    ["get_available_slots", { start: "bad-date", end: "x" }], // validation → friendly error
  ];
  for (const [name, input] of calls) {
    const r = await runReadTool(mock, name, input);
    console.log(`\n• ${name}(${JSON.stringify(input)})${r.isError ? "  [friendly error]" : ""}`);
    console.log(`  → ${truncate(r.content, 700)}`);
  }
}

async function conversationDemo(): Promise<void> {
  console.log("\n\n########## DEMO B — real conversation vs Mock (Claude tool-use) ##########");
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("(skipped — no ANTHROPIC_API_KEY in apps/api/.env)");
    return;
  }

  let askAgent: (history: Msg[]) => Promise<string>;
  try {
    ({ askAgent } = await import("../apps/api/src/agent"));
  } catch (err) {
    console.log(`(skipped — could not load agent: ${(err as Error).message})`);
    return;
  }

  const history: Msg[] = [];
  const turns = [
    "היי! אני מעוניינת בבוטוקס. אילו תורים פנויים יש לייעוץ בימים הקרובים?",
    "תודה! ואילו רופאים יש אצלכם? וגם — למטופלת בשם כהן יש כבר תור קיים?",
  ];

  for (const userMsg of turns) {
    history.push({ role: "user", content: userMsg });
    console.log(`\n👤 ${userMsg}`);
    try {
      const reply = await askAgent(history);
      history.push({ role: "assistant", content: reply });
      console.log(`🤖 ${reply}`);
    } catch (err) {
      console.log(`🤖 (שגיאה בקריאה ל-Claude: ${(err as Error).message})`);
      return;
    }
  }
}

async function main(): Promise<void> {
  await toolLayerDemo();
  await conversationDemo();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
