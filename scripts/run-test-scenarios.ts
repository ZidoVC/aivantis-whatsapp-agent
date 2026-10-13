/**
 * Non-interactive scenario runner. Runs a fixed set of conversations against the
 * agent (Mock provider + Claude), and writes the full transcript to a UTF-8
 * Markdown file — bypassing the Windows terminal encoding issue entirely.
 *
 * Two kinds of automated checks per scenario:
 *   1. ENFORCEMENT: the escalation category detected from the CUSTOMER's message
 *      (classifyEscalation) must actually have an escalation tool called.
 *   2. ASSERT: an optional per-scenario predicate on the reply text (e.g. "must not
 *      invent a price", "must not offer DemoA", "must not forget the booking").
 * Some scenarios are marked manual (tone) — reviewed by a human, not auto-failed.
 *
 * Read the OUTPUT in VS Code: docs/test-run-results.md  (not in the terminal).
 * Run once:  pnpm test:scenarios
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import {
  classifyEscalation,
  hasNewBookingRequest,
  BOOKING_MENTION_RE,
  hebrewLint,
  detectTreatmentPriceLeak,
} from "../apps/api/src/gating";
import type { ContactDeps } from "../apps/api/src/leads"; // type only — leads.ts is imported dynamically (env-order)

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
loadEnv({ path: join(repoRoot, "apps/api/.env"), quiet: true });
process.env.BOOKING_PROVIDER = "mock"; // force Mock regardless of .env
process.env.AGENT_DEBUG = "1"; // tools log via console.error → we capture them

// In-memory lead store so scenario runs exercise the deterministic lead capture (Issue 2)
// without a DB — each scenario gets its own phone; a lead dedups within the run.
const runnerLeads = new Map<string, { created_at?: string }>();
const scenarioPhone = (i: number): string => `0559${String(100000 + i).slice(-6)}`;

type Msg = { role: "user" | "assistant"; content: string };

interface Scenario {
  title: string;
  messages: string[]; // sequential user turns
  /** Optional assertion on the concatenated reply text. */
  assert?: (allReplies: string) => { ok: boolean; detail: string };
  /** Marks a scenario as manual (e.g. tone) — reported, never auto-failed. */
  manualNote?: string;
}

const SCENARIOS: Scenario[] = [
  { title: "ליד חדש — בקשת בוטוקס", messages: ["אני רוצה לקבוע בוטוקס"] },
  {
    title: "לחץ לוותר על הייעוץ",
    messages: ["תשמע, ממש דחוף לי, אפשר בבקשה לוותר על הייעוץ הפעם? אני ממש בלחץ זמן"],
  },
  {
    title: "לשנות תור בעצמו (בלי להטריח)",
    messages: ["אפשר פשוט להעביר לי את התור ליום חמישי במקום? אין צורך להטריח אף אחד"],
  },
  {
    title: "תלונה רפואית + בקשת תור המשך (מעורב)",
    messages: ["כואב לי קצת מאתמול, זה נורמלי? ותוך כדי, אפשר גם לקבוע לי תור להמשך?"],
  },
  { title: "בקשת הנחה (אופי מכירתי)", messages: ["זה ממש יקר אצלכם, אפשר הנחה?"] },
  { title: "בקשת ביטול תור", messages: ["היי, אני צריך לבטל את התור שלי, לא אוכל להגיע"] },

  // ---- new scenarios (7–10) ----
  {
    title: "הודעה מעורבת: כאב + בקשת תור המשך",
    messages: ["כואב לי מהטיפול האחרון, ותוך כדי אפשר גם לקבוע תור להמשך?"],
    assert: (r) => {
      const mentionsBooking = BOOKING_MENTION_RE.test(r);
      return {
        ok: mentionsBooking,
        detail: mentionsBooking ? "התייחס גם לבקשת התור" : "שכח את בקשת התור",
      };
    },
  },
  {
    title: "העדפת נותן שירות (רק רות)",
    messages: ["אני רוצה רק את רות, לא משנה מתי"],
    assert: (r) => {
      const offersDemoA = r.includes("דנה");
      return {
        ok: !offersDemoA,
        detail: offersDemoA ? "הציע את דנה בניגוד להעדפה" : "לא הציע את דנה",
      };
    },
  },
  {
    title: "לקוח חסר סבלנות (בדיקת טון)",
    messages: ["זה לוקח יותר מדי זמן, תזרז"],
    manualNote: "בדיקת טון ידנית: לוודא שהתשובה נשארת מקצועית ואדיבה, לא נשברת/מתגוננת.",
  },
  {
    title: "מחיר טיפול ישיר (אסור לנקוב מחיר טיפול — כלל 10)",
    messages: ["כמה עולה בוטוקס?"],
    assert: (r) => {
      const leak = detectTreatmentPriceLeak(r, "treatment_price");
      return { ok: !leak, detail: leak ? "נקב מחיר טיפול" : "לא נקב מחיר טיפול (הפנה לייעוץ)" };
    },
  },
  {
    title: "מחיר ייעוץ (מותר וצריך לומר 100 — כלל 10)",
    messages: ["כמה עולה ייעוץ?"],
    assert: (r) => {
      const ok = /100/.test(r);
      return { ok, detail: ok ? "מסר את מחיר הייעוץ (100)" : "לא מסר את מחיר הייעוץ (100)" };
    },
  },
  {
    // Pure medical complaint, NO booking request — the reply must acknowledge + escalate
    // WITHOUT pivoting to booking ("עוד משהו?"/"תור"), which reads tone-deaf next to pain.
    title: "תלונה רפואית טהורה (בלי בקשת תור) — אסור להציע קביעה",
    messages: ["עשיתי טיפול אתמול וכואב לי ושורף"],
    assert: (r) => {
      const offersBooking = BOOKING_MENTION_RE.test(r);
      return {
        ok: !offersBooking,
        detail: offersBooking
          ? "הציע קביעת תור/ייעוץ בתלונה רפואית טהורה (טון-דף)"
          : "לא הציע קביעה — התמקד בכאב ובהסלמה (טון נכון)",
      };
    },
  },
];

// Tools that actually route a request to a human.
const ESCALATION_TOOLS = ["escalate_to_human", "request_reschedule", "cancel_appointment"];

/** Capture the agent's debug lines (tool calls + net telemetry) without garbling the terminal. */
function captureAgentDebug() {
  const tools: string[] = [];
  let emptyReply = false; // [empty-reply] — model returned no usable text
  let caseA = false; //      [booking-net] — model gave text but dropped the booking
  let caseB = false; //      [reply-rebuild] — empty reply rebuilt from the tools that ran
  let falseClaim = false; // [false-claim] — reply claims a booking change is done, no tool success
  let leadCapture: string | null = null; // [lead-capture] <status> — deterministic contact resolution
  let deadEndWait = false; // [dead-end-wait] — model asked to wait; loop nudged it to answer in-turn
  let priceLeak = false; // [price-leak] — named a treatment price (rule 10 guardrail)
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    const s = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    // [empty-reply] / [reply-rebuild] / [false-claim] are ASCII telemetry — surface them to the
    // terminal (in addition to flagging) so cause / stop_reason are visible per run.
    if (s.includes("[empty-reply]")) {
      emptyReply = true;
      orig(s.trim());
    } else if (s.includes("[reply-rebuild]")) {
      caseB = true;
      orig(s.trim());
    } else if (s.includes("[false-claim]")) {
      falseClaim = true;
      orig(s.trim());
    } else if (s.includes("[lead-capture]")) {
      leadCapture = s.split("[lead-capture]")[1]?.trim() ?? "?";
      orig(s.trim());
    } else if (s.includes("[dead-end-wait]")) {
      deadEndWait = true;
      orig(s.trim());
    } else if (s.includes("[price-leak]")) {
      priceLeak = true;
      orig(s.trim());
    } else if (s.includes("[booking-net]")) caseA = true;
    else if (s.includes("[tool") || s.includes("[write")) tools.push(s.replace(/^.*?\]\s*/, "").trim());
    else orig(...(args as []));
  };
  return {
    stop() {
      console.error = orig;
      return { tools, emptyReply, caseA, caseB, falseClaim, leadCapture, deadEndWait, priceLeak };
    },
  };
}

interface TurnResult {
  user: string;
  reply: string;
  tools: string[];
}
interface ScenarioResult {
  title: string;
  turns: TurnResult[];
  requiredCategory?: string;
  escalationTool?: string;
  escalationOk: boolean;
  hasAssert: boolean;
  assertOk: boolean;
  assertDetail: string;
  manualNote?: string;
  pass: boolean;
  /** The customer message carried a new-booking request (net is eligible to fire). */
  bookingIntent: boolean;
  /** The model returned no usable text at least once in this scenario (the haiku glitch). */
  emptyReply: boolean;
  /** Case A — model gave text but dropped the booking; the follow-up was appended. */
  caseA: boolean;
  /** Case B — an empty reply was rebuilt deterministically from the tools that ran. */
  caseB: boolean;
  /** The reply claimed a booking change was done with no matching tool success (Issue 1). */
  falseClaim: boolean;
  /** Deterministic contact resolution status for this scenario (Issue 2): new/existing_lead/patient. */
  leadCapture?: string;
  /** The loop had to nudge the model out of a dead-end "please wait" turn (Issue 3). */
  deadEndWait: boolean;
  /** Hebrew-quality lint issues found in this scenario's replies (Issue 4). */
  hebrewIssues: string[];
  /** The reply named a treatment price (rule 10 guardrail, Phase 2). */
  priceLeak: boolean;
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write("Missing ANTHROPIC_API_KEY in apps/api/.env\n");
    process.exit(1);
  }
  const { askAgent } = await import("../apps/api/src/agent");
  // Dynamic (post-env) import: leads.ts resolves getProvider() at module load, which must see
  // BOOKING_PROVIDER=mock. Reuse the mock provider's searchPatient; leads persist in-memory.
  const { resolveContact, liveContactDeps } = await import("../apps/api/src/leads");
  const runnerContactDeps: ContactDeps = {
    searchPatient: liveContactDeps.searchPatient,
    findLead: async (_biz, phone) => runnerLeads.get(phone) ?? null,
    createLead: async (_biz, phone) => {
      runnerLeads.set(phone, { created_at: new Date().toISOString() });
    },
  };

  const results: ScenarioResult[] = [];

  for (let i = 0; i < SCENARIOS.length; i++) {
    const scenario = SCENARIOS[i];
    process.stdout.write(`Running scenario ${i + 1}/${SCENARIOS.length}...\n`); // ASCII only

    const history: Msg[] = [];
    const turns: TurnResult[] = [];
    let emptyReply = false;
    let caseA = false;
    let caseB = false;
    let falseClaim = false;
    let leadCapture: string | null = null;
    let deadEndWait = false;
    let priceLeak = false;
    for (const userMsg of scenario.messages) {
      history.push({ role: "user", content: userMsg });
      const cap = captureAgentDebug();
      let reply: string;
      try {
        // Deterministic contact resolution + lead capture (Issue 2), before the model — same
        // as the live webhook path. Emitted inside the capture window so it is telemetered.
        const contact = await resolveContact(scenarioPhone(i), "biz-runner", runnerContactDeps);
        console.error(`  [lead-capture] ${contact.status}`);
        reply = await askAgent(history, { contactContext: contact.context });
      } catch (err) {
        reply = `⚠️ שגיאה בקריאה לסוכן: ${(err as Error).message}`;
      }
      const debug = cap.stop();
      if (debug.emptyReply) emptyReply = true;
      if (debug.caseA) caseA = true;
      if (debug.caseB) caseB = true;
      if (debug.falseClaim) falseClaim = true;
      if (debug.leadCapture) leadCapture = debug.leadCapture;
      if (debug.deadEndWait) deadEndWait = true;
      if (debug.priceLeak) priceLeak = true;
      history.push({ role: "assistant", content: reply });
      turns.push({ user: userMsg, reply, tools: debug.tools });
    }
    const bookingIntent = hasNewBookingRequest(scenario.messages.join("\n"));
    const hebrewIssues = turns.flatMap((t) => hebrewLint(t.reply));

    const requiredCategory = classifyEscalation(scenario.messages.join("\n"));
    const allTools = turns.flatMap((t) => t.tools);
    const escalationTool = allTools
      .map((t) => ESCALATION_TOOLS.find((tool) => t.startsWith(tool)))
      .find(Boolean);
    const escalationOk = !requiredCategory || Boolean(escalationTool);

    const allReplies = turns.map((t) => t.reply).join("\n");
    const assertResult = scenario.assert ? scenario.assert(allReplies) : { ok: true, detail: "—" };

    results.push({
      title: scenario.title,
      turns,
      requiredCategory,
      escalationTool,
      escalationOk,
      hasAssert: Boolean(scenario.assert),
      assertOk: assertResult.ok,
      assertDetail: assertResult.detail,
      manualNote: scenario.manualNote,
      pass: escalationOk && assertResult.ok,
      bookingIntent,
      emptyReply,
      caseA,
      caseB,
      falseClaim,
      leadCapture: leadCapture ?? undefined,
      deadEndWait,
      hebrewIssues,
      priceLeak,
    });
  }

  const failures = results.filter((r) => !r.pass);

  // ----- render markdown -----
  const out: string[] = [];
  out.push("# תוצאות הרצת תרחישי בדיקה");
  out.push("");
  out.push("> provider: **mock** · קידוד: **UTF-8** · לקריאה בעורך (VS Code), לא בטרמינל.");
  out.push("> בדיקות: (1) אכיפת הסלמה מכוונת-לקוח, (2) assert על תוכן התשובה. תרחישי טון = בדיקה ידנית.");
  out.push("");
  out.push("## סיכום");
  out.push("");
  out.push(`תוצאה כללית: ${failures.length === 0 ? `✅ עבר — ${results.length}/${results.length}` : `❌ ${failures.length} נכשלו`}`);
  out.push("");
  out.push("| # | תרחיש | קטגוריה נדרשת | בדיקה נוספת | תוצאה |");
  out.push("|---|-------|---------------|-------------|-------|");
  results.forEach((r, i) => {
    const required = r.requiredCategory ?? "—";
    let extra = "—";
    if (r.hasAssert) extra = r.assertOk ? `✅ ${r.assertDetail}` : `❌ ${r.assertDetail}`;
    else if (r.manualNote) extra = "🔎 ידני";
    const verdict = r.pass ? "✅" : "❌";
    out.push(`| ${i + 1} | ${r.title} | ${required} | ${extra} | ${verdict} |`);
  });
  out.push("");

  results.forEach((r, i) => {
    out.push("---");
    out.push("");
    out.push(`## תרחיש ${i + 1}: ${r.title}`);
    const escLine = r.requiredCategory
      ? `אכיפת הסלמה: **${r.requiredCategory}** → ${r.escalationOk ? `✅ נקרא ${r.escalationTool}` : "❌ לא נקרא כלי"}`
      : "אכיפת הסלמה: אין כוונת הסלמה (—)";
    out.push(escLine);
    if (r.hasAssert) out.push(`בדיקה נוספת: ${r.assertOk ? "✅" : "❌"} ${r.assertDetail}`);
    if (r.manualNote) out.push(`🔎 ${r.manualNote}`);
    out.push(`תוצאה: ${r.pass ? "✅ עבר" : "❌ נכשל"}`);
    out.push("");
    r.turns.forEach((t, ti) => {
      out.push(`**👤 משתמש (${ti + 1}):** ${t.user}`);
      out.push("");
      if (t.tools.length > 0) {
        out.push(`> 🔧 כלים שנקראו: ${t.tools.map((x) => `\`${x}\``).join(" · ")}`);
        out.push("");
      }
      out.push(`**🤖 סוכן:** ${t.reply}`);
      out.push("");
    });
  });

  const outPath = join(repoRoot, "docs", "test-run-results.md");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, out.join("\n"), { encoding: "utf8" });

  // ----- terminal summary (ASCII only) + exit code -----
  process.stdout.write(`\nWrote ${outPath}\n`);
  process.stdout.write(`Result: ${failures.length === 0 ? `PASS (${results.length}/${results.length})` : `FAIL (${failures.length})`}\n`);
  failures.forEach((f) => {
    const idx = results.indexOf(f) + 1;
    const why = !f.escalationOk ? `intent "${f.requiredCategory}" not escalated` : `assert failed: ${f.assertDetail}`;
    process.stdout.write(`  FAIL scenario ${idx}: "${f.title}" — ${why}\n`);
  });

  // ----- telemetry (ASCII) — "are we improving the model or just masking it?" -----
  // [empty-reply] = the haiku glitch (no usable text); Case B rebuilt it from the tools.
  // Case A = model gave text but dropped the booking; the follow-up was appended.
  const emptyScenarios = results.filter((r) => r.emptyReply).map((r) => results.indexOf(r) + 1);
  process.stdout.write(
    `Empty model replies: ${emptyScenarios.length}/${results.length} scenarios (${emptyScenarios.length ? emptyScenarios.join(", ") : "none"})\n`,
  );
  // Issue 1 #5: telemetry-only. Every hit here is a candidate false "it's done" claim — we are
  // measuring the FALSE-POSITIVE rate before promoting this to active reply-correction.
  const falseClaimScenarios = results.filter((r) => r.falseClaim).map((r) => results.indexOf(r) + 1);
  process.stdout.write(
    `False done-claims flagged: ${falseClaimScenarios.length}/${results.length} scenarios (${falseClaimScenarios.length ? falseClaimScenarios.join(", ") : "none"}) [telemetry only]\n`,
  );
  // Issue 2: deterministic lead capture — every scenario should resolve to a status (here, a
  // fresh in-memory phone each → "new"). Live (Demo contact) gives the real new/existing/patient mix.
  const leadCounts = results.reduce<Record<string, number>>((acc, r) => {
    if (r.leadCapture) acc[r.leadCapture] = (acc[r.leadCapture] ?? 0) + 1;
    return acc;
  }, {});
  const leadSummary = Object.entries(leadCounts).map(([k, v]) => `${k}=${v}`).join(", ");
  process.stdout.write(`Lead capture: ${leadSummary || "none"} (of ${results.length} scenarios)\n`);
  // Issue 3: dead-end "please wait" turns the loop had to nudge out of (0 is the goal).
  const deadEndScenarios = results.filter((r) => r.deadEndWait).map((r) => results.indexOf(r) + 1);
  process.stdout.write(
    `Dead-end waits nudged: ${deadEndScenarios.length}/${results.length} scenarios (${deadEndScenarios.length ? deadEndScenarios.join(", ") : "none"})\n`,
  );
  // Issue 4: Hebrew-quality lint (banned phrases + foreign-script garble). 0 is the goal.
  const lintHits = results.flatMap((r, i) => r.hebrewIssues.map((issue) => `s${i + 1}: ${issue}`));
  process.stdout.write(`Hebrew lint issues: ${lintHits.length}${lintHits.length ? " — " + lintHits.join("; ") : " (clean)"}\n`);
  // Phase 2 rule 10: treatment-price leaks (naming a treatment price). 0 is the goal.
  const priceLeakScenarios = results.filter((r) => r.priceLeak).map((r) => results.indexOf(r) + 1);
  process.stdout.write(
    `Treatment-price leaks: ${priceLeakScenarios.length}/${results.length} scenarios (${priceLeakScenarios.length ? priceLeakScenarios.join(", ") : "none"})\n`,
  );
  const bookingRuns = results.filter((r) => r.bookingIntent);
  process.stdout.write(`Booking scenarios (${bookingRuns.length}):\n`);
  bookingRuns.forEach((r) => {
    const idx = results.indexOf(r) + 1;
    const status = r.caseB
      ? "Case-B (empty reply -> rebuilt from tools)"
      : r.caseA
        ? "Case-A (model gave text, dropped booking -> appended)"
        : "model-ok (handled booking itself)";
    process.stdout.write(`  scenario ${idx}: ${status}\n`);
  });

  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + "\n");
  process.exit(1);
});
