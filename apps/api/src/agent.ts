import Anthropic from "@anthropic-ai/sdk";
import { getProvider } from "@aivantis/booking-provider";
import { READ_TOOLS, runReadTool } from "./booking-tools";
import { WRITE_TOOLS, isWriteTool, isEscalationTool, runWriteTool } from "./write-tools";
import {
  classifyEscalation,
  hasNewBookingRequest,
  BOOKING_MENTION_RE,
  stripBookingPivot,
  redactInternalLeak,
  detectFalseCompletionClaim,
  isDeadEndWait,
  classifyPriceIntent,
  detectTreatmentPriceLeak,
  CONSULTATION_PRICE_ILS,
  isEscalationCategory,
  type EscalationCategory,
} from "./gating";
import { redactForModel } from "./redact";

const ALL_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS];

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// The agent talks ONLY to the BookingProvider contract. getProvider() resolves the
// implementation from BOOKING_PROVIDER (mock by default) — never a concrete provider.
const booking = getProvider();

const SYSTEM_PROMPT = `את העוזרת לקביעת תורים של קליניקה לרפואה אסתטית בישראל, ומדברת עם הלקוחות בוואטסאפ.
🗣️ הקול שלך — קראי את זה טוב, ככה את נשמעת ללקוחה:
• **ברירת מחדל: לשון נקבה.** רוב הפונות נשים — פני אליה בנקבה: "מצטערת", "אלייך", "תוכלי", "את". עברי ללשון זכר רק אם הלקוח כתב בבירור בלשון זכר (למשל "אני צריך", "רוצה" בצורת זכר).
• **כתיב נקבה נכון:** "אלייך" (עם שתי יודים!), "תוכלי", "את"; "שלך" ו"לך" תקינים. לעולם לא "אליך" — זו צורת זכר וזה צורם לאוזן של דוברת עברית.
• **אסור לחלוטין צורות לוכסן** בתשובה ללקוחה — לא "מעביר/ה", לא "לקבוע/לשנות", לא "את/ה". זה נשמע כמו טופס, לא כמו בן אדם. כתבי צורה אחת נקייה, בנקבה. גם לא לוכסן בין אפשרויות: כתבי "או", לא "בנקאית/אשראי".
• דברי **חם, אנושי וקצר** — כמו חברה בוואטסאפ, לא כמו נציגת שירות. תשובה רגילה: **2–4 שורות קצרות**, ואמרי כל דבר **פעם אחת** (אל תחזרי שלוש פעמים על "מעבירה לצוות").
• **בלי ניסוח תאגידי או רובוטי.** אסור: "הצוות המקצועי שלנו", "יידעו להתייחס לזה כמו שצריך", "אני מבינה שזה לא נוח". דברי פשוט וישר.
• עברית תקינה בלבד, בלי אנגלית ובלי מילים משובשות (אסור "בואנו" → כתבי "בואי"; אסור "בחכייה" → "מחכים לך"). פתחי בברכה רק בהודעה הראשונה בשיחה, אחר כך המשיכי טבעי בלי לפתוח שוב בשלום.

התפקיד שלך הוא אך ורק קביעה וניהול של תורים. את לא נותנת מידע רפואי, לא ממליצה על טיפולים, לא מאבחנת ולא מתחייבת על תוצאות.
כששואלים אותך שאלה רפואית או טיפולית (האם טיפול מתאים, התוויות, תופעות לוואי, מה כדאי לעשות וכד') — אל תעני לגופו של עניין. הסבירי בנימוס שזה נושא לצוות של הקליניקה, והציעי לקבוע פגישת ייעוץ.

כל פנייה לטיפול אסתטי מתחילה תמיד בקביעת פגישת *ייעוץ* — לא תור לטיפול. זה נכון גם לפונה חדשה וגם ללקוחה קיימת.
פונה חדשה שאינה רשומה במערכת — תמיד נקבעת לתור "ייעוץ".
החריג היחיד: לקוחה ותיקה שכבר עברה בעבר בדיוק את אותו הטיפול (למשל בוטוקס חוזר) יכולה להיקבע ישירות לטיפול — אבל רק כאשר הדבר מסומן ומאושר מראש על ידי הקליניקה. את לא מחליטה על כך בעצמך; אם אין אישור מפורש כזה, ברירת המחדל היא תמיד ייעוץ.

תלונות אינן בתחום הטיפול שלך. כל תלונה — כאב, חוסר שביעות רצון מהתוצאה, בקשה לביטול עסקה, או כל עניין רגיש אחר — מועברת מיד לאדם מהצוות. אל תנהלי את התלונה: אל תציעי פיצוי, החזר כספי או טיפול חוזר, ואל תקבלי החלטות. רק רשמי בקצרה מה קרה, ואמרי ללקוחה שמישהי מהצוות תחזור אלייך בהקדם. ואל תקראי לתלונה או לכאב "שאלה" — זו לא שאלה, זו תלונה. (ואם בכל זאת את כותבת "שאלה", זו מילה בנקבה: "זו שאלה", לא "זה שאלה".)

💙 כאב או סימפטום רפואי אחרי טיפול — כאן הטון הכי חשוב, ותשובה קצרה בת 2–3 שורות:
1. הגיבי קצר וחם, כמו בן אדם — "אוי, מצטערת לשמוע 💙".
2. אמרי **פעם אחת** שהעברת עכשיו לדנה ולורות ושהן יחזרו אלייך בהקדם (לא שלוש פעמים, לא "הצוות המקצועי").
3. שורת בטיחות: "אם זה מחמיר בינתיים — אל תחכי, תתקשרי אלינו."
**אל תציעי לקבוע תור ואל תשאלי "עוד משהו?" באותה תשובה — זה נשמע אטום מול כאב.** החריג היחיד: אם הלקוחה עצמה גם ביקשה לקבוע או לשנות תור — אז טפלי גם בזה, אחרי שהתייחסת לכאב.

ביטול או שינוי של תור אפשריים עד 24 שעות לפני המועד. אם הבקשה מגיעה פחות מ-24 שעות לפני התור — עדכני בעדינות שייתכן שהתור יחויב בהתאם לטופס ההסכמה, והעבירי את הבקשה לטיפול הצוות.

מחירים: מחיר ה*ייעוץ* הוא ${CONSULTATION_PRICE_ILS} ₪, בתשלום מראש בהעברה בנקאית, בכרטיס אשראי, או במזומן בקליניקה — מותר לך לומר זאת במפורש. אבל מחיר *טיפולים* לעולם לא נמסר בצ'אט: הוא נקבע בייעוץ אישי לפי הצורך — הסבירי זאת בנימוס והציעי לקבוע ייעוץ, בלי לנקוב במספר. מיקוח או בקשת הנחה ("יקר", "הנחה", "מבצע") מועברת לנציג אנושי — אל תבטיחי הנחה.

ייעוץ נערך אצל רות או אצל דנה. הציעי את המועד הפנוי הקרוב ביותר מבין השתיים, אלא אם הלקוחה ביקשה מטפלת מסוימת — אז חפשי זמינות רק לאותה מטפלת.

פנייה חדשה: כשאת אוספת פרטים (שם, טלפון, מה מבוקש) — בקשי דבר אחד בכל פעם, בשיחה טבעית, לא רשימה ולא בולטים. התחילי במספר הטלפון, ואחר כך המשיכי לשאר. אחרי איסוף הפרטים, עדכני שהפקידה תחזור לתיאום — "הפקידה תחזור אלייך לתיאום". הפנייה כבר נשמרה אצלנו, אין צורך לחפש אותה.

הכלים שברשותך:
- כלי קריאה: search_patient (חיפוש לפי טלפון בעיקר), get_available_slots (זמינות לפי סוג טיפול), get_doctors_sites, get_treatments (קטלוג או היסטוריה), get_patient_appointments. השתמשי בהם כדי לבדוק במקום לנחש, ואל תמציאי מידע.
- קביעת תור: create_appointment. תמיד צייני type ("consultation" או "treatment"). המערכת אוכפת את הכללים — אם היא מחזירה שצריך ייעוץ קודם, הציעי ללקוחה לקבוע ייעוץ; אם היא מחזירה שצריך אישור צוות, הסבירי שהעברת לאישור.
- שינוי או דחיית תור: request_reschedule בלבד — לעולם אינו משנה תור בפועל, אלא מעביר לפקידה.
- ביטול: cancel_appointment — ביטול פחות מ-24 שעות לא מבוצע אוטומטית אלא מוסלם.
- הסלמה לאדם: escalate_to_human עם category. השתמשי בו לתלונה פיזית או רפואית (category=medical_symptom), תלונה שירותית (general_complaint), פנייה מכירתית או רכישת חבילה (sales_inquiry). זהו הכלי היחיד להסלמה — אין ולא תהיה אפשרות להציע פיצוי, החזר או טיפול חוזר.

לזיהוי מטופלת קיימת בקשי מספר טלפון. אל תבצעי קביעה או ביטול על סמך ניחוש — הישעני על תוצאות הכלים.

סימוני פרטיות: אם בהודעה או בהקשר מופיע סימון כמו «טלפון» או «ת.ז», זהו מזהה שכבר קיים אצלנו במערכת והוסתר מטעמי פרטיות — **אל תבקשי מהלקוחה לשלוח אותו שוב, ואל תתייחסי אליו כשגיאה או כתו מיוחד.** הלקוחה כבר מזוהה לפי ההקשר; המשיכי לעזור באופן טבעי (למשל פני אליה בשמה הפרטי אם הוא ידוע).

חובת אכיפה — "לומר" בלי "לעשות" הוא כשל: בכל פעם שהתשובה שלך מזכירה העברה או הסלמה לאדם (תלונה רפואית או פיזית, תלונה שירותית, פנייה מכירתית, בקשת אישור, או כל ניסוח כמו "אעביר לצוות", "יחזרו אלייך", "אעדכן את הצוות", "אעביר את הפנייה") — את חייבת לקרוא בפועל, באותו תור, לכלי המתאים: escalate_to_human עם ה-category הנכון (medical_symptom, general_complaint, sales_inquiry או staff_approval_needed), או request_reschedule או cancel_appointment לפי העניין. לתאר הסלמה בטקסט בלי לקרוא לכלי = כשל, כי אף אדם לא יקבל את הפנייה בפועל.

לעולם אל תסיימי תור בלי טקסט ללקוחה: גם אחרי שקראת לכלי (במיוחד כלי הסלמה), כתבי תמיד משפט קצר שמאשר מה נעשה — למשל שהעברת את הפנייה לצוות ושיחזרו אלייך — ואם יש בקשת תור, המשיכי לקדם אותה.

אל תבקשי מהלקוחה להמתין: לעולם אל תסיימי תור במשפט כמו "רק רגע", "תמתיני", "שנייה", "כבר בודקת ואחזור". אם צריך לבדוק משהו (למשל זמינות) — בצעי את הבדיקה **עכשיו** באמצעות הכלים וספקי את התשובה המלאה **באותה הודעה**. הלקוחה לא אמורה להגיב "כן" כדי לקבל את מה שכבר הבטחת לבדוק.

הסלמה ≠ בוצע: אל תאמרי שתור נקבע, הוזז, שונה או בוטל אלא אם קיבלת מהכלי תוצאה עם הצלחה לאותה פעולה (למשל cancelled=true או ok=true). בקשת שינוי או ביטול שהוסלמה מקבלת status="pending" — נסחי "העברתי לצוות, הן יטפלו", לעולם לא "הזזתי", "ביטלתי" או "שיניתי". ואל תתייחסי בהמשך השיחה לשעה או לתור שקיימים רק כי הסלמת בקשה (למשל "התור החדש שלך ב-13:00") — הם עדיין לא קיימים עד שהצוות מאשר.

הודעה מרובת-בקשות: אם הודעה אחת מכילה יותר מעניין אחד (למשל תלונה רפואית או רגישה **וגם** בקשה לקבוע או לשנות תור) — טפלי בשני החלקים באותה תשובה. הסלימי את החלק הרגיש כנדרש (וקראי בפועל לכלי ההסלמה), **וגם** המשיכי לקדם את הבקשה השנייה: הציעי לקבוע פגישת ייעוץ ובקשי את הפרט הדרוש (למשל מספר טלפון). אסור "לנעול" רק על ההסלמה ולזנוח את שאר ההודעה — לקוחה ששאלה גם על תור צריכה לקבל התייחסות לתור, ולא רק "אעביר לצוות".

איסור המצאה: אל תמציאי תפקידים, שמות, או נותני שירות שלא הופיעו בפועל בנתונים (למשל אין "פיזיותרפיסט" בקליניקה). אם אינך יודעת מי מטפל במשהו — היעזרי ב-get_doctors_sites לנתונים האמיתיים, או הישארי כללית ("אחת מהצוות") או הסלימי. לעולם אל תנחשי תפקיד או שם.

איסור המצאת מצב-מערכת: לעולם אל תמציאי הסבר למה מישהו לא נמצא במערכת (למשל "הפנייה שלך בבדיקה ולכן אינך מופיעה במערכת") — זה אסור. אם חיפוש לא מצא, או שאינך יודעת מדוע — אמרי בפשטות שתבדקי מול הצוות, או המשיכי באיסוף הפרטים. ואל תבקשי פרט (טלפון או שם) שכבר נמסר קודם בשיחה או שמופיע בהקשר הזיהוי.`;

export type Msg = { role: "user" | "assistant"; content: string };

/** A booking change (reschedule/cancel) escalated to staff but NOT executed — persisted on
 *  the conversation and injected into the NEXT turn so the agent never claims it happened. */
export interface PendingAction {
  type: "reschedule" | "cancellation";
  detail: string;
  at: string;
}

/** Durable, auditable record of a single tool call in a turn (see 004 migration / observability). */
export interface ToolCallLog {
  name: string;
  args_summary: string;
  status: string;
}

export interface AgentMeta {
  toolLog: ToolCallLog[];
  /** undefined = leave existing pending as-is; null = clear it; object = set/replace it. */
  nextPendingAction: PendingAction | null | undefined;
  /** non-null when the reply CLAIMS a booking change is done with no matching tool success. */
  falseClaim: string | null;
  /** Escalation categories that ACTUALLY fired this turn (model tool calls + code enforcement),
   *  deduped. The deterministic trigger for staff notifications — set from tool outcomes, never
   *  from the reply text. Empty when nothing escalated. */
  escalations: EscalationCategory[];
}

export interface AgentContext {
  /** Existing pending action to inject into this turn's context. */
  pendingAction?: PendingAction | null;
  /** Deterministic identity line (Issue 2): registered patient / known lead / new inquiry. */
  contactContext?: string;
  /** True when the message arrived outside clinic hours (Phase 2 §4) — add a "reception will
   *  get back to you during business hours" note where human follow-up is needed. */
  afterHours?: boolean;
  /** Called once (before returning) with this turn's audit metadata, for the caller to persist. */
  emit?: (meta: AgentMeta) => void;
}

const MODEL = "claude-haiku-4-5";
const MAX_TOOL_ROUNDS = 6;

/** Redact model-bound text blocks (phones/IDs). Applied to inputs sent TO the model only. */
function redactBlocksForModel(blocks: Anthropic.ContentBlockParam[]): Anthropic.ContentBlockParam[] {
  return blocks.map((b) => (b.type === "text" ? { ...b, text: redactForModel(b.text) } : b));
}

/** Compact, non-PII-expanding status of a tool outcome for the audit log. */
function toolStatus(content: string): string {
  try {
    const d = JSON.parse(content) as { cancelled?: boolean; escalated?: boolean; category?: string; ok?: boolean };
    if (d.cancelled) return "cancelled";
    if (d.escalated) return `escalated:${d.category ?? "?"}`;
    if (d.ok) return "ok";
  } catch {
    /* non-JSON outcome (e.g. a validation-error string) */
  }
  return "done";
}

export async function askAgent(history: Msg[], ctx: AgentContext = {}): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  let system = `${SYSTEM_PROMPT}\n\nלידיעתך, התאריך היום הוא ${today}.`;
  if (ctx.contactContext) {
    system += `\n\n${ctx.contactContext}`;
  }
  if (ctx.afterHours) {
    system +=
      `\n\n[מחוץ לשעות הפעילות] כרגע מחוץ לשעות הפעילות של הקליניקה. עני כרגיל, אבל כשנדרש מעקב אנושי ` +
      `(תיאום פקידה או הסלמה) הוסיפי שהמזכירות יחזרו אלייך בשעות הפעילות.`;
  }
  if (ctx.pendingAction) {
    const kind = ctx.pendingAction.type === "cancellation" ? "ביטול" : "שינוי מועד";
    system +=
      `\n\n[מצב ממתין] קיימת בקשת ${kind} שהוסלמה לצוות בשיחה קודמת ו**טרם בוצעה** ` +
      `(מה שביקשה הלקוחה: "${ctx.pendingAction.detail}"). התייחסי אליה כ*ממתינה לאישור הצוות* — ` +
      `אל תאמרי שהיא בוצעה, ואל תמציאי תור או שעה שנובעים ממנה.`;
  }

  // G1 — PII redaction at the MODEL boundary (only the Claude path). Strips phone/ID digits from
  // the system context (surname is already minimized in leads.ts) and from the customer messages.
  // Never applied to the reply returned to the customer, nor to the DB / clinic-escalation paths.
  // Content/intent is preserved — the agent still sees the words it needs to classify and escalate.
  system = redactForModel(system);

  const messages: Anthropic.MessageParam[] = history.map((m) => ({
    role: m.role,
    content: redactForModel(m.content),
  }));

  // Deterministic escalation: detect intent from the CUSTOMER's latest message.
  const latestUser = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  const requiredCategory = classifyEscalation(latestUser);
  let escalationCalled = false;
  let modelEscalationCategory: EscalationCategory | undefined;
  let createdAppt = false;
  let cancelledAppt = false;
  let modelProducedText = false;
  let lastStopReason = "";
  let toolRounds = 0;
  const toolLog: ToolCallLog[] = [];
  let rescheduleEscalated = false;
  let cancelEscalated = false;
  let waitNudges = 0;
  let finalText = "מצטערת, נתקלתי בקושי לעבד את הבקשה. אפשר לנסות שוב, או שאעביר אותך לצוות.";

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system,
      tools: ALL_TOOLS,
      messages,
    });

    lastStopReason = response.stop_reason ?? "";

    if (response.stop_reason === "tool_use") {
      toolRounds++;
      const toolUses = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
      );

      // Echo the assistant turn (incl. the tool_use blocks) back into the conversation (redacted).
      messages.push({
        role: "assistant",
        content: redactBlocksForModel(response.content as unknown as Anthropic.ContentBlockParam[]),
      });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const call of toolUses) {
        const outcome = isWriteTool(call.name)
          ? await runWriteTool(booking, call.name, call.input)
          : await runReadTool(booking, call.name, call.input);
        if (isEscalationTool(call.name)) escalationCalled = true;
        if (call.name === "escalate_to_human") {
          const c = (call.input as { category?: unknown })?.category;
          if (isEscalationCategory(c)) modelEscalationCategory = c;
        }
        if (!outcome.isError && call.name === "create_appointment") {
          try {
            if ((JSON.parse(outcome.content) as { ok?: boolean })?.ok) createdAppt = true;
          } catch {
            /* non-JSON outcome — ignore */
          }
        }
        if (!outcome.isError && call.name === "cancel_appointment") {
          try {
            if ((JSON.parse(outcome.content) as { cancelled?: boolean })?.cancelled) cancelledAppt = true;
          } catch {
            /* non-JSON outcome — ignore */
          }
        }
        // Durable tool-call audit (persisted with the outbound message) + pending-change tracking.
        const status = outcome.isError ? "error" : toolStatus(outcome.content);
        toolLog.push({ name: call.name, args_summary: JSON.stringify(call.input ?? {}).slice(0, 200), status });
        if (call.name === "request_reschedule") rescheduleEscalated = true;
        if (call.name === "cancel_appointment" && status.startsWith("escalated")) cancelEscalated = true;
        // Redact PII (patient phones from search results etc.) before the result goes to the model.
        // The code-side reads of outcome.content above use the ORIGINAL — only the model copy is redacted.
        toolResults.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: redactForModel(outcome.content),
          ...(outcome.isError ? { is_error: true } : {}),
        });
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    // Dead-end wait (Issue 3): the model promised to check and asked the customer to hold,
    // then ended the turn. Don't return that — nudge it to do the check and answer in the
    // SAME turn, and continue the loop. Capped so we can never spin.
    if (text && isDeadEndWait(text) && waitNudges < 2 && round < MAX_TOOL_ROUNDS - 1) {
      waitNudges++;
      if (process.env.AGENT_DEBUG) console.error("  [dead-end-wait] nudging model to answer in-turn");
      messages.push({ role: "assistant", content: text });
      messages.push({
        role: "user",
        content:
          "בצעי עכשיו את הבדיקה וספקי את התשובה המלאה באותה הודעה. אל תבקשי מהלקוחה להמתין ואל תסיימי את התור בהבטחה לבדוק.",
      });
      continue;
    }

    modelProducedText = text.length > 0;
    finalText = text || "מצטערת, לא הצלחתי להבין. אפשר לנסות שוב?";
    break;
  }

  // Enforcement (the reverse direction of the Gating layer): if the customer's message
  // shows an escalation intent and the model did NOT call an escalation tool, the code
  // calls escalate_to_human itself — a human must actually be notified, not merely
  // promised in the reply text. One escalation per turn (highest-priority category).
  let enforcementCategory: EscalationCategory | undefined;
  if (requiredCategory && !escalationCalled) {
    const outcome = await runWriteTool(booking, "escalate_to_human", {
      category: requiredCategory,
      summary: latestUser,
    });
    escalationCalled = true; // an escalation has now actually happened this turn
    enforcementCategory = requiredCategory;
    // Record the code-initiated escalation in the durable audit too, so an enforcement
    // escalation is never invisible in the tool log.
    toolLog.push({
      name: "escalate_to_human",
      args_summary: JSON.stringify({ category: requiredCategory, enforced: true }).slice(0, 200),
      status: outcome.isError ? "error" : toolStatus(outcome.content),
    });
  }

  const bookingFollowUp =
    "\n\nולגבי קביעת התור — אשמח לעזור, רק אצטרך את מספר הטלפון שלך כדי להתחיל.";
  const wantsBooking = hasNewBookingRequest(latestUser);

  if (!modelProducedText) {
    // The model returned no usable text. Observed pattern (see root-cause analysis): haiku
    // sometimes ends the turn empty right after a terminal escalate_to_human. Rebuild the
    // reply from what the loop ACTUALLY did — so the customer never gets a bare "לא הבנתי"
    // when work was done, and we never append a dangling "ולגבי" onto the error fallback.
    if (process.env.AGENT_DEBUG) {
      console.error(`  [empty-reply] stop_reason=${lastStopReason} toolRounds=${toolRounds}`);
    }
    const cat = modelEscalationCategory ?? requiredCategory;
    let rebuilt = "";
    if (escalationCalled) {
      if (cat === "medical_symptom") {
        // Warm feminine ack + escalate ONCE + safety line. No booking offer unless she asked.
        rebuilt =
          "אוי, מצטערת לשמוע 💙 העברתי עכשיו לדנה ולורות והן יחזרו אלייך בהקדם. " +
          "אם זה מחמיר בינתיים — אל תחכי, תתקשרי אלינו.";
      } else {
        rebuilt = "העברתי עכשיו לצוות ונחזור אלייך בהקדם.";
      }
      if (wantsBooking) rebuilt += bookingFollowUp;
    } else if (createdAppt) {
      rebuilt = "קבעתי לך את התור — נשלח אישור בהקדם. אפשר לעזור בעוד משהו?";
    } else if (cancelledAppt) {
      rebuilt = "ביטלתי לך את התור. אם תרצי לקבוע מועד חדש, אני כאן.";
    }
    if (rebuilt) {
      if (process.env.AGENT_DEBUG) {
        console.error(`  [reply-rebuild] cat=${cat ?? "none"} booking=${wantsBooking}`);
      }
      finalText = rebuilt;
    }
    // else: no composable action happened → keep the honest "לא הבנתי" fallback.
  } else if (wantsBooking && !BOOKING_MENTION_RE.test(finalText)) {
    // Booking enforcement (Case A): the model produced a real reply but dropped the booking
    // half — the "complaint + booking" message where it locks onto the escalation. Continue
    // naturally from its own text. No-op when the reply already advances the booking.
    if (process.env.AGENT_DEBUG) console.error("  [booking-net] append (model dropped booking)");
    finalText += bookingFollowUp;
  }

  // Pure-medical booking suppressor (the deterministic INVERSE of the Case-A net): when this turn
  // escalated a medical_symptom and the customer did NOT ask to book, strip any booking pivot the
  // model tacked on. Offering a תור next to a fresh pain complaint reads tone-deaf; the prompt says
  // not to, but the model still does ~1/3 of the time — so we enforce it in code, not just prompt.
  const medicalEscalated =
    modelEscalationCategory === "medical_symptom" || enforcementCategory === "medical_symptom";
  if (medicalEscalated && !wantsBooking) {
    const suppressed = stripBookingPivot(finalText);
    if (suppressed !== finalText) {
      if (process.env.AGENT_DEBUG) console.error("  [booking-suppressed] pure-medical reply dropped a booking pivot");
      finalText = suppressed;
    }
  }

  // Cross-turn pending state (Issue 1): an escalated reschedule/cancel is PENDING (staff will
  // act), never done. Persist it so the NEXT turn's context stops the model from claiming it
  // happened. An actual create/cancel clears it; anything else leaves the existing state as-is.
  let nextPendingAction: PendingAction | null | undefined;
  if (createdAppt || cancelledAppt) {
    nextPendingAction = null;
  } else if (cancelEscalated || requiredCategory === "late_cancellation") {
    nextPendingAction = { type: "cancellation", detail: latestUser, at: today };
  } else if (rescheduleEscalated || requiredCategory === "reschedule_request") {
    nextPendingAction = { type: "reschedule", detail: latestUser, at: today };
  } else {
    nextPendingAction = undefined;
  }

  // False "it's done" claim telemetry (Issue 1, #5): LOG only — do not rewrite the reply yet.
  const falseClaim = detectFalseCompletionClaim(finalText, { created: createdAppt, cancelled: cancelledAppt });
  if (falseClaim && process.env.AGENT_DEBUG) console.error(`  [false-claim] ${falseClaim}`);

  // Rule 10 guardrail (telemetry-only): a treatment-price question answered with a concrete price.
  if (detectTreatmentPriceLeak(finalText, classifyPriceIntent(latestUser)) && process.env.AGENT_DEBUG) {
    console.error("  [price-leak] named a treatment price");
  }

  // Escalation categories that actually fired this turn — model tool calls + code enforcement.
  // Deduped, order-preserving. index.ts turns each into a staff WhatsApp notification.
  const escalations: EscalationCategory[] = [];
  const addEscalation = (c?: EscalationCategory) => {
    if (c && !escalations.includes(c)) escalations.push(c);
  };
  addEscalation(modelEscalationCategory);
  if (rescheduleEscalated) addEscalation("reschedule_request");
  if (cancelEscalated) addEscalation("late_cancellation");
  addEscalation(enforcementCategory);

  // Final security gate (last line before send): never let an internal identifier — a tool or
  // escalation-category name, a config/secret key, or the system prompt — reach the customer, even
  // if the model was coaxed into disclosing it. Deterministic; replaces the whole reply on a hit.
  const leak = redactInternalLeak(finalText);
  if (leak.leaked.length > 0) {
    if (process.env.AGENT_DEBUG) console.error(`  [leak-blocked] ${leak.leaked.join(",")}`);
    finalText = leak.text;
  }

  ctx.emit?.({ toolLog, nextPendingAction, falseClaim, escalations });

  return finalText;
}
