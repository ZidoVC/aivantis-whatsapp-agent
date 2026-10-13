# Aivantis — מסירת פרויקט / DevOps Handoff

תאריך בדיקה: 13.10.2026. Baseline מקומי: `a48b2a7`.

מהדורת snapshot ציבורי: אין היסטוריית Git או מסמכי לקוח בחבילה. שמות צוות ומזהי דוגמאות בקוד הוחלפו. מסמך זה מתאר גם ממצאים מהמקור הפרטי; קבצים היסטוריים שמוזכרים בו אינם בהכרח כלולים. ראו `PUBLIC_RELEASE.md` לפירוט. תוצאות בדיקות היסטוריות אינן אימות של ה-snapshot המסונן.

## מהדורת מסירה ציבורית — Mock-only

אימות עדכני של ה-snapshot: build ללא cache עבר (4/4 tasks); 190 unit tests עברו — API: 170, BookingProvider: 20. לא בוצעה בדיקת deployment, תרחישי Claude חיים או WhatsApp חי.

Optima adapter, המפרט, הלקוח המג׳ונרט, schemas/mappers, בדיקות החבילה הקשורות ו-SQL ייעודי הוסרו. הגדרת Optima נכשלת במפורש. טיפוסי תאימות והגנות אפליקציה נשארו, אך אין חיבור חי. תיאורי Optima ובדיקותיו בהמשך הם רקע מהמקור הפרטי, לא יכולת הכלולה במסירה. כדי להחזיר אינטגרציה צריך adapter מורשה מחדש וסגירת חוסמי Go-Live; שינוי env אינו מספיק.

## Executive summary

זהו סוכן WhatsApp לתיאום תורים, לא מוצר Production-ready ולא סוכן רפואי. קיימים API, מנוע שיחה, כלי קריאה/כתיבה, כללים דטרמיניסטיים, זיכרון שיחה והסלמה לצוות. המסלול הפעיל מוגדר ל-Mock. אינטגרציית Optima קיימת; התיעוד מתאר בדיקות read/write חיות בעבר, אך הן לא הורצו בבדיקה זו ואינן אישור לפרודקשן.

אין להחליף ל-Optima אמיתי לפני סגירת חוסמי הבטיחות ואישור הקליניקה. פרסום קוד לצורך הורדה אינו אישור להפעלתו עם נתוני מטופלים.

## מה בנינו

- Monorepo: TypeScript, pnpm 9, Turborepo.
- API ב-Hono; WhatsApp Business דרך Twilio; Claude API עם tool-use; Supabase/Postgres לשיחות, לידים ותיעוד פעולות.
- `BookingProvider` מפריד בין לוגיקת הסוכן לבין Mock/Optima. לקוח Optima, מיפוי תגובות ו-Zod schemas נמצאים בחבילה עצמאית.
- Gating בקוד: ייעוץ לפני טיפול, ביטול בהתאם לחלון 24 שעות, שינוי תור דרך אדם, וסיווג הסלמות. חלון הביטול העסקי אינו חלון ההודעות של WhatsApp.
- אכיפת הסלמה לאחר לולאת המודל, תיקון תשובות ריקות וטיפול בהודעות עם כמה כוונות.
- Lead capture, pending actions, tool audit, התראות לצוות ורישום fallback להתראות שלא נמסרו.
- אימות חתימת Twilio בפרודקשן, rate limiting, הגבלת אורך קלט, סינון דליפת מזהים פנימיים ו-redaction של מזהים ישירים במסלול Claude.
- A5: חסימת יצירת תור ב-Optima ללא מזהה מטופל תקין בשתי שכבות. `card_id=0` אינו fallback בטוח.

## Data flow וגבולות אמון

```text
Customer → WhatsApp/Meta → Twilio → Hono /whatsapp
                                  ├─ Supabase: conversation/message/lead/audit
                                  ├─ redaction → Claude → tools → Gating → BookingProvider
                                  │                                      ├─ Mock
                                  │                                      └─ Optima (לא מאושר ל-Go-Live)
                                  └─ Twilio: תשובה + הסלמה לצוות
```

Supabase, Twilio, Anthropic, Meta ו-Optima הם גבולות עיבוד נפרדים. יש למפות עבור כל ספק את המידע המועבר, ההרשאות, מיקום העיבוד, השמירה וההסכם הרלוונטי.

## מצב מאומת מול מצב מתועד

- נבדקו הקוד, manifests, migrations ותיעוד handoff. HEAD המקומי הוא `a48b2a7`; origin מצביע ל-repository שסופק.
- נמצאה תיקיית `src/` לא-מנוהלת ב-Git. היא לא נכללה אוטומטית במסירה.
- ה-handoff האחרון מדווח על 246 unit tests ו-12/12 scenarios. אלה תוצאות היסטוריות, לא אישור להרצה נוכחית.
- `STATUS.md` וחלקים מה-knowledge graph מיושנים. אין להסתמך על ספירות הבדיקות או סטטוס Optima/RLS שבהם ללא בדיקה.
- קיום SQL בקוד אינו הוכחה שה-migration הורץ בסביבה. הפעלת RLS בעבר מדווחת בתיעוד, אך מצב DB חי לא אומת כאן.
- GitHub CLI אינו מאומת; connector מחזיר 404. לא אומתו visibility או HEAD מרוחק, ולא בוצעו push או שינוי ל-public.

## חוסמי Go-Live

| Gate | פער | Acceptance criteria |
|---|---|---|
| A5b | BLOCKED עלול עדיין להוביל לאישור תור שגוי; הזיהוי הנוכחי telemetry-only | תשובת holding/reconciliation דטרמיניסטית + wiring tests, כולל שילוב תלונה רפואית |
| A5c | SUCCESS ו-BLOCKED באותו turn | מניעת מצב כתיבה מעורב או reconciliation מוכח מול הספק |
| A5d | יותר מיצירת תור מוצלחת אחת | idempotency, זיהוי כפילויות ומסלול תיקון ללא אישור-שווא |
| A4 | timeout אינו בהכרח כישלון פעולה | SUCCESS/FAILED/UNKNOWN מפורשים; read-back לפני retry של כתיבה |
| A3 | אין dedup מתמשך לפי MessageSid | unique key מתמשך + replay/concurrency tests + atomic state transitions |
| A2 | אין emergency kill switch מלא | כיבוי כתיבות/AI והעברה לאדם, עם תרגיל הפעלה ו-rollback |
| A1 | deployment פרודקשן לא הושלם | TLS, secret manager, process supervision, probes, deploy/rollback runbook |

בנוסף: tenant routing לפי מספר היעד, provider פר-tenant, מיפוי רופאים, credentials/company מאושרים, reconciliation של migrations ואימות ערוץ הסלמה אמיתי.

## סיכוני אמינות ותפעול

- ה-webhook ממתין ל-debounce, DB ו-LLM; צריך למדוד end-to-end latency מול מגבלות Twilio. יעד מומלץ: durable enqueue ואז ACK מהיר, worker ותשובה אסינכרונית.
- coalescer ו-rate limiter הם בזיכרון פר-תהליך. restart מאבד state; horizontal scaling אינו בטוח ללא state/locks משותפים.
- `getConversation` משתמש select-then-insert: race אפשרי. יש לאמת unique constraint ואז upsert.
- rate-limit מחזיר 200 לפני שמירת הודעה; לקוח יכול להישאר ללא מענה וללא תיעוד. יש להוסיף durable intake/backpressure ומענה fallback.
- הודעה שמגיעה במהלך עיבוד עשויה להמתין לתור הבא. יש להבטיח drain של backlog גם אם אין הודעה נוספת.
- lead persistence הוא best-effort; אין להבטיח ללקוח שהליד נשמר או שאדם קיבל התראה בלי receipt מאומת.
- התראות fire-and-forget מחייבות durable outbox, retries ו-dead-letter/reconciliation; עצם ניסיון השליחה אינו delivery receipt.
- `/health` הוא liveness בסיסי, לא readiness של DB/queue/sפקים. אין לפתוח בדיקת ספק כותבת ב-health check.
- חסרים CI/CD ו-gates אוטומטיים. יש לבצע build ללא cache, unit tests, replay tests, migration checks, secret scan ו-dependency audit בכל release.

## אבטחה ופרטיות — residual risks

1. Redaction אינו אנונימיזציה: תוכן רפואי, שם שנכתב ב-free text והקשר מזהה עדיין יכולים להגיע למודל. אחסון DB וערוץ ההסלמה אינם עוברים אותה הסרה.
2. הקוד מדפיס מספר שולח ותוכן הודעה ל-stdout, וכן חתימת Twilio ופרטי debug. נדרש structured logging עם masking; אין לרכז לוגים גולמיים בטרם ניקוי.
3. `/db-test` חושף `business` אם env flag מופעל. מומלץ להסיר מפרודקשן או לחסום ברמת build/network/auth; default-off אינו בקרת גישה מלאה.
4. Supabase service-role עוקף RLS. בידוד tenant תלוי גם בסינון backend; RLS אינו מגן מפני באג בשרת privileged. נדרשים negative tests בין tenants ו-least privilege.
5. אימות חתימת webhook אינו מאמת בעלות של המטופל על כל תור שהמודל מבקש לשנות. יש לבדוק authorization לכל פעולה, בצד השרת, מול מזהה מאומת.
6. reverse proxy headers צריכים trust boundary מוגדר; עדיף URL ציבורי קבוע לחתימה ולחסום גישה ישירה לשרת. לא להריץ production עם `NODE_ENV=development`.
7. סינון prompt leakage הוא mitigation, לא הוכחה לחסינות. יש לבדוק tool arguments, data exfiltration ו-cross-tenant access, לא רק טקסט תשובה.
8. סודות Optima דורשים Vault/secret manager או הצפנה מתאימה, rotation והפרדה מסביבת בדיקה. אין להעביר `.env` לחברים.
9. MFA, access roster, backup/restore, incident response, retention/deletion ו-DPA עם ספקים דורשים אישור תפעולי; אי אפשר להסיק אותם מהקוד.
10. המספר של WhatsApp אינו פתרון מלא לאימות זהות רפואית. אין להציג מידע רפואי רגיש רק על בסיס טלפון ללא הערכת הרשאה וסיכון.

## מדיניות ורגולציה — נבדק 13.10.2026, לא חוות דעת משפטית

### WhatsApp / Twilio

נדרשים opt-in מתאים, טיפול ב-opt-out ואכיפת חלון שירות: free-form replies בתוך 24 שעות מהודעת המשתמש האחרונה; מחוץ לחלון נדרשת תבנית מאושרת לפי סוג ההודעה. יש לבדוק זאת בנפרד גם להתראות לצוות, לא רק לשיחת המטופל. נדרש מסלול מעבר ברור לאדם בהפעלת אוטומציה.

מקורות: [Twilio best practices](https://www.twilio.com/docs/whatsapp/best-practices-and-faqs), [WhatsApp Messaging Policy](https://business.whatsapp.com/policy).

תנאי WhatsApp מבחינים בין AI שהוא המוצר העיקרי לבין AI כתמיכה נלווית לשירות עסקי. ההערכה כאן: סוכן מוגבל לתיאום תורים עשוי להשתייך לקטגוריית תמיכה עסקית, אך זו פרשנות ולא אישור של Meta. אין להסיק שהפרויקט מאושר רק מפני שהוא משתמש ב-Twilio; נדרש sign-off על ה-use case והחשבון. אין להסתמך על חריגים אזוריים שלא חלים על משתמשים בישראל.

מקור: [WhatsApp Business Solution Terms](https://www.whatsapp.com/legal/business-solution-terms).

המדיניות גם מגבילה בקשת מזהים רגישים ושימוש במידע רפואי כאשר הדין מחייב מערכות עם דרישות מוגברות שאינן מתקיימות. לכן הסוכן צריך להיות scheduling-only, ללא אבחון, מרשם או ייעוץ רפואי; הודעת תסמין לאדם אינה כשלעצמה הוכחת compliance.

### Anthropic

מדיניות API מתארת מחיקה בתוך 30 ימים כברירת מחדל, עם חריגים; תנאים מסחריים אינם שקולים לאפס שמירה. ZDR תלוי בהסכם, feature/model eligibility ובהגדרות workspace. אין להצהיר ZDR בלי ראיה מהחשבון וההסכם, ואין להעביר מידע לצורכי training דרך opt-in/feedback ללא בחינה נפרדת.

מקורות: [Organization retention](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data), [API retention/eligibility](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention), [Commercial Terms](https://www.anthropic.com/legal/commercial-terms).

### ישראל

יש לבחון את חוק הגנת הפרטיות לאחר תיקון 13, תקנות אבטחת מידע, שימוש בספק חיצוני והעברת מידע לחו"ל. מידע על תסמינים מחייב טיפול כמידע רגיש, גם אם הסוכן אינו נותן רפואה מרחוק. נדרשים מיפוי מאגר ועיבוד, הודעת פרטיות, בסיס חוקי/הסכמה כנדרש, הסכם עיבוד, הרשאות, מינימיזציה ומדיניות שמירה. חובת DPO/רישום/הודעה תלויה במאפייני הגוף והעיבוד, לא עצם שימוש ב-AI.

מקורות: [תיקון 13 — הרשות להגנת הפרטיות](https://govextra.gov.il/privacy-protection-regulations/privacy-protection-regulations/), [שאלות ותשובות אבטחת מידע](https://www.gov.il/he/pages/data_security_fqa?chapterIndex=1).

## Bootstrap למקבלי הפרויקט

1. clone או Download ZIP לאחר release מאושר. להשתמש בנתוני demo בלבד.
2. להתקין Node LTS נתמך לאחר אימות תאימות ו-pnpm 9 לפי manifest; להריץ `pnpm install --frozen-lockfile`.
3. להריץ `pnpm --filter @aivantis/booking-provider test`, `pnpm --filter api test`, `pnpm exec turbo build --force`.
4. ליצור `apps/api/.env` מתוך `.env.example` עם credentials חדשים של סביבת dev בלבד. לא להעתיק credentials של הקליניקה.
5. להכין Supabase dev ולסקור SQL בסדר מאושר; לא להריץ אוטומטית rollback/preflight או את כל קבצי SQL יחד. לוודא schema, constraints ו-RLS בפועל.
6. להשאיר `BOOKING_PROVIDER=mock`, `OPTIMA_LIVE`/`OPTIMA_WRITE` לא מוגדרים, debug routes כבויים. mock אינו מבטל תעבורה ל-Claude/Twilio/Supabase.
7. להריץ `pnpm --filter api dev` ולבדוק `/health`. demo/scenario scripts עשויים לקרוא Claude אמיתי ולעלות כסף; לסקור לפני הפעלה.
8. לא להריץ `optima-write-cycle`, delete scripts או probes מול מערכת אמיתית. כל בדיקת כתיבה דורשת tenant בדיקה והרשאה מפורשת.

## Production runbook מינימלי

- Secrets שונים ל-dev/staging/prod, MFA ו-rotation; deploy עם `NODE_ENV=production`, URL webhook קבוע ו-TLS.
- migrations מבוקרים עם backup, rehearsal ו-rollback; בדיקות deny ל-anon ובידוד tenants ב-backend.
- durable ingress/outbox, idempotency keys, bounded retries ו-circuit breakers; אין retry עיוור של יצירת תור לאחר timeout.
- Metrics: webhook ACK/p95 latency, queue age, reply failures, UNKNOWN writes, duplicate attempts, escalation delivery, lead failures, rate-limit drops ועלות/turn.
- Alerts עם owner ו-SLO מאושר; restore drill ותרגיל kill switch. יעד ראשוני: אפס אישורי-שווא ואפס UNKNOWN ללא reconciliation.
- pilot מוגבל בהיקף עם צוות זמין; רק לאחר review של תוצאות להרחיב. לא להוסיף replicas לפני פתרון state משותף.

## הערכת זמן — engineering estimate, לא התחייבות

הנחות: מפתח backend/DevOps מנוסה במשרה מלאה, גישה לספקים וסביבת בדיקה, ללא UI חדש; אין שינוי API מהותי ב-Optima.

| חבילה | Effort משוער |
|---|---|
| Public release נקי, סריקת history, ניקוי נתוני לקוח ותיעוד | 1–3 ימי עבודה |
| A5b ותיקוני תשובה בטוחה + regression tests | 1–2 ימים |
| Idempotency, A5c/A5d/A4, replay/concurrency/reconciliation | 5–10 ימים |
| Kill switch, durable intake/outbox, deployment ו-CI/CD | 4–8 ימים |
| Tenant routing, Optima secrets/migrations ו-integration validation | 3–6 ימים |
| Observability, security hardening ו-pilot acceptance | 3–5 ימים |

סדר גודל לפיילוט אמין: 3–6 שבועות עבודה, בתוספת זמני המתנה לאישורים/credentials/תבניות. SLA production או SaaS רב-דיירי מלא: 6–10+ שבועות, לפי scope. ההערכות כוללות חפיפות אפשריות ואינן סכימה מכנית של כל השורות. שינויי ספק או דרישות משפטיות יכולים להרחיב אותן משמעותית.

## Public-release gate

אין לפרסם את כל תיקיית Desktop כפי שהיא. ב-release package יש לכלול source, lockfile, migrations מאושרים, env example ותיעוד; לא `node_modules`, `.env`, runtime logs, חשבונות, exports או session/auth material.

- סריקה ראשונית של tracked text לא מצאה secret patterns שנבדקו; זו אינה סריקת history מלאה ואינה בדיקת מסמכים בינאריים.
- קיימים שמות קליניקה, אנשי קשר, פרטי אינטגרציה ותוצאות בדיקות חיות בתיעוד; יש לאשר זכויות פרסום ולהחליף בדוגמאות ניטרליות.
- `Aivantis_Agent_Build_Plan.docx` לא נבדק למסירה ציבורית. מומלץ להשאירו מחוץ ל-release עד review.
- יש לסרוק את כל היסטוריית Git, branches/tags ו-binary assets. מחיקת סוד ב-HEAD אינה מסירה אותו מההיסטוריה; אם נמצא סוד נדרש rotation.
- יש לבדוק רישוי של קוד וספקים, OpenAPI ו-skills שהועתקו. Public visibility אינו רישיון open-source; לא נבחר כאן רישיון בשם הבעלים.
- אפשר לשמר repository פרטי כארכיון ולפרסם snapshot מסונן ב-repository ציבורי חדש, אם הבעלים בוחר בכך. אין לשכתב history או לשנות יעד אוטומטית.

## המלצה לצוות המקבל

להתחיל מ-release נקי ב-Mock, להריץ בדיקות מחדש, ולסגור את A5b → בטיחות write/idempotency → deployment/privacy gates → pilot. להשתמש בתיעוד ההיסטורי כרקע, ולא כהוכחת הפעלה נוכחית או כהוראה להריץ פעולות על מערכת חיה.
