# חיבור GitHub והעלאת snapshot

המהדורה הנוכחית Mock-only, ללא מפרט Optima או לקוח מג׳ונרט. להעלאה מה-PowerShell שבו התחברת:

```powershell
Set-Location -LiteralPath 'C:\Users\mqgam\Desktop\Aivantis-public-snapshot'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\UPLOAD_PUBLIC.ps1
```

ה-script בודק שהמקור פרטי, מריץ בדיקות/build ומבקש PUBLIC לפני יצירת repository ציבורי. המקור לא משתנה. אם שלב נכשל, עצרו ושלחו את השגיאה; אין להריץ שוב בעיוורון אחרי יצירת `.git`. ההנחיות הישנות לאישור זכויות Optima בהמשך אינן רלוונטיות למהדורה זו.

המסלול המומלץ כאן הוא GitHub CLI מקומי, כי הוא מאפשר ליצור repository חדש ולהעלות את כל החבילה. חיבור GitHub של ChatGPT/Codex וחיבור CLI הם הרשאות נפרדות.

ב-PowerShell רגיל של Windows, להריץ:

```powershell
gh auth login --hostname github.com --git-protocol https --web
gh auth setup-git
gh auth status
```

לאשר את ההתחברות בדפדפן לחשבון הרצוי. אין לשלוח token, סיסמה או קוד אימות בצ'אט. לא לבחור `--insecure-storage`; יש לוודא שימוש ב-Windows Credential Manager. חיבור CLI מעניק הרשאות לחשבון לפי ה-scopes של תהליך האימות — יש לסקור אותן ולהשתמש בחשבון המיועד לפרסום.

לאחר החיבור, לשלוח בצ'אט: "GitHub CLI מחובר; העלה ל-ZidoVC/aivantis-whatsapp-agent" (או שם/בעלים אחרים שבחרתם).

העלאה תבוצע מה-snapshot בלבד אחרי בדיקות, review וזכויות פרסום. אין להריץ פקודת שינוי visibility על ה-repository המקורי. המצב הפרטי שלו עדיין דורש אימות כשיש גישה לחשבון.

אם אין הרשאה ליצור repository בחשבון/ארגון, ליצור ב-GitHub repository חדש וריק, Public, ללא README/license/.gitignore אוטומטיים, ולשלוח את כתובתו. CLI עדיין צריך הרשאת push.

רישוי: לבחור האם זה קוד ציבורי לצורך מסירה בלבד ללא רישיון open-source, או לצרף רישיון מפורש שבעל הקוד מאשר. בנוסף יש לאשר זכויות פרסום למפרט Optima/לקוח המג'ונרט. אין לבחור רישיון בשם הבעלים באופן אוטומטי.
