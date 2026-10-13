/**
 * Interactive terminal chat with the agent (Stage 2), against MockProvider.
 *
 * Uses the SAME agent as apps/api (same system prompt + tools), keeps the
 * conversation history in memory for the session, and prints both the reply and
 * which tools were called (the `[tool→]` lines, via AGENT_DEBUG) for debugging.
 *
 * READ-ONLY, BOOKING_PROVIDER=mock. Type "exit" (or "יציאה") to quit.
 *
 * Run:  pnpm chat:agent
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config as loadEnv } from "dotenv";
import * as readline from "node:readline";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(here, "..", "apps/api/.env"), quiet: true });
process.env.AGENT_DEBUG = process.env.AGENT_DEBUG ?? "1"; // show tool calls

type Msg = { role: "user" | "assistant"; content: string };

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("חסר ANTHROPIC_API_KEY ב-apps/api/.env — אי אפשר להריץ את הצ'אט.");
    process.exit(1);
  }

  // Import the agent only after env is loaded (it builds the Claude client at load).
  const { askAgent } = await import("../apps/api/src/agent");

  const history: Msg[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "👤 " });

  let closed = false;
  rl.on("close", () => {
    closed = true;
  });
  const prompt = (): void => {
    if (!closed) rl.prompt();
  };

  console.log("💬 צ'אט עם הסוכן (Mock, קריאה בלבד). הקלד/י הודעה, או 'exit' ליציאה.\n");
  prompt();

  // Async iteration serializes turns: readline pauses until each reply is done,
  // so this works both interactively and with piped input (no race on EOF).
  for await (const line of rl) {
    const text = line.trim();
    if (!text) {
      prompt();
      continue;
    }
    if (text === "exit" || text === "יציאה") break;

    history.push({ role: "user", content: text });
    try {
      const reply = await askAgent(history);
      history.push({ role: "assistant", content: reply });
      console.log(`🤖 ${reply}\n`);
    } catch (err) {
      console.log(`🤖 (שגיאה בקריאה ל-Claude: ${(err as Error).message})\n`);
    }
    prompt();
  }

  if (!closed) rl.close();
  console.log("\nלהתראות! 👋");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
