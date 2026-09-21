# Before I Do — האתר

אתר סטטי רב-עמודי של המשחק "Before I Do" (Liver Production).
המקור הוא פרויקט Claude Design; כאן הוא בנוי לאתר אמיתי שרץ על
`beforeido.co.il` דרך Vercel.

## עדכון האתר אחרי שינוי עיצוב

כשמגיע ייצוא חדש מ-Claude Design (קובץ zip של הפרויקט):

```bash
unzip "Visual system board review.zip" -d /tmp/bid
node tools/build-site.js /tmp/bid
node tools/serve.js              # לבדוק על http://127.0.0.1:8099
git add -A && git commit -m "עדכון עיצוב" && git push
```

Vercel פורסת אוטומטית אחרי ה-push.

**חשוב:** הסקריפט מדפיס `ok` או `SKIPPED` לכל תיקון בכל עמוד.
`SKIPPED` אומר שהעיצוב השתנה באזור הזה — צריך להסתכל על העמוד לפני פרסום.

## עמודים

| כתובת | מקור | הערה |
|---|---|---|
| `/` | Opening Experience.dc.html | דף הבית |
| `/checkout` | Checkout.dc.html | טופס הזמנה, 3 שלבים. **הסליקה עוד לא מחוברת** |
| `/terms` | Terms.dc.html | תקנון, משלוחים, החזרות |
| `/privacy` | Privacy.dc.html | פרטיות, עוגיות, נגישות |
| `404.html` | 404.dc.html | Vercel מגישה אוטומטית |
| `/spec` | Design Spec.dc.html | פנימי, noindex |
| `/visual-dna` | Visual DNA.dc.html | פנימי, noindex |
| `/policies` | מדיניות.dc.html | פנימי, noindex |

## התראות על הזמנה, ונטישות בקופה

`api/order.js` מקבל שני סוגי הודעה מהקופה, ומבדיל ביניהם לפי `stage`:

| `stage` | מתי | לאן |
|---|---|---|
| `pay` | הלקוח לחץ "מעבר לתשלום מאובטח" | וואטסאפ ל-`WHATSAPP_CHAT_ID` + מייל |
| `abandoned` | הלקוח מילא פרטים ויצא בלי ללחוץ | וואטסאפ ל-`WHATSAPP_LEADS_CHAT_ID` בלבד |

העמוד שולח ב-`navigator.sendBeacon` — שורד את המעבר לעמוד של Grow,
בניגוד ל-fetch שהיה נקטע.

**ההתראה אומרת "התחילה הזמנה", לא "שולם".** התשלום עצמו מאושר מול Grow.

הודעת נטישה נשלחת רק אם הוקלד שם או טלפון, רק אחרי 5 שניות בעמוד,
ולעולם לא אחרי לחיצה על תשלום. מי שעבר ללשונית אחרת וחזר לקנות ייצור
אחת מכל סוג — ההזמנה היא זו שקובעת.

כל פנייה נרשמת גם ביומן הפונקציה בשורה אחת שמתחילה ב-`BID_LEAD`,
כך שאפשר לחזור אחורה ולייצא (Vercel → Logs → חיפוש `BID_LEAD`).

להגדרה ב-Vercel → Settings → Environment Variables. כל מה שחסר פשוט מדולג,
וכישלון בהתראה לעולם לא חוסם את התשלום:

| משתנה | לְמה | ברירת מחדל |
|---|---|---|
| `RESEND_API_KEY` | מייל דרך resend.com | בלעדיו אין מייל |
| `ORDER_EMAIL_TO` | לאן לשלוח | barakliver@gmail.com |
| `ORDER_EMAIL_FROM` | שולח מאומת | onboarding@resend.dev |
| `GREENAPI_ID` | וואטסאפ דרך green-api.com — מזהה המופע | בלעדיו אין וואטסאפ |
| `GREENAPI_TOKEN` | הטוקן של אותו מופע | בלעדיו אין וואטסאפ |
| `GREENAPI_URL` | ה-apiUrl של המופע, כפי שמופיע בקונסולה | https://api.green-api.com |
| `WHATSAPP_WEBHOOK` | חלופה: כתובת משלך שמקבלת `{phone, message}` | — |
| `WHATSAPP_TO` | מספר היעד, בפורמט בינלאומי | 972526604320 |
| `WHATSAPP_CHAT_ID` | או מזהה צ'אט מלא, גובר על `WHATSAPP_TO`. קבוצה (`…@g.us`) נותנת התראה רגילה, בניגוד לצ'אט "הודעה לעצמי" | — |
| `WHATSAPP_LEADS_CHAT_ID` | קבוצה נפרדת לנטישות בקופה. בלעדיו הן מגיעות לקבוצת ההזמנות, מסומנות | `WHATSAPP_CHAT_ID` |

### חיבור וואטסאפ דרך Green API

1. להירשם ב-green-api.com ליצור Instance
2. לסרוק את ה-QR מהוואטסאפ בטלפון (הגדרות ← מכשירים מקושרים)
3. להעתיק `idInstance` ו-`apiTokenInstance` למשתנים למעלה ב-Vercel, ולעשות Redeploy

הטלפון שסרק צריך להישאר מחובר לאינטרנט — זה חיבור של "מכשיר מקושר",
בדיוק כמו וואטסאפ ווב.

לבדיקה מקומית: `node tools/serve.js` מריץ גם את `/api` ומדפיס כל קריאה.

## מבנה

```
index.html, checkout.html, ...   העמודים הבנויים (לא לערוך ביד)
assets/js/app.js                 מנוע ה-rendering של Claude Design
assets/js/react*.js              React 18 — מוגש מהאתר, לא מ-unpkg
assets/fonts.css + fonts/        Assistant / Heebo / Caveat
assets/img/                      תמונות, ממוזערות לפי תוכן
assets/og-card.png               תמונת השיתוף (וואטסאפ/פייסבוק)
assets/favicon.svg               אייקון הלב
api/order.js                     התראת הזמנה במייל ובוואטסאפ
tools/build-site.js              בונה את האתר מייצוא הפרויקט
tools/optimize-images.js         ממיר את התמונות ל-WebP ומעדכן את העמודים
tools/og-card.html               המקור של תמונת השיתוף
vercel.json                      כתובות נקיות (/terms ולא /terms.html)
robots.txt, sitemap.xml          נוצרים על ידי הסקריפט
```

אין שלב build ואין תלויות — פלט הסקריפט הוא HTML סטטי.

## מה הסקריפט מוסיף מעבר לייצוא

הייצוא הוא קוד מקור של כלי העיצוב. הסקריפט הופך אותו לאתר:

- **runtime ותמונות משותפים** לכל העמודים במקום עותק לכל עמוד
- **גופנים מקומיים** במקום Google Fonts, כולל טווחי היוניקוד לעברית
- **React מהאתר** דרך `window.__resources`, שחייב להיטען *לפני* ה-runtime
- **קישורים פנימיים** מומרים משמות קבצים (`Terms.dc.html#terms`) לכתובות (`/terms#terms`)
- **מטא-דאטה** לכל עמוד: כותרת, תיאור, canonical, noindex לפנימיים, og לדף הבית
- **תיקוני מפרט** כרשת ביטחון: clamp לטיפוגרפיה מעל 21px, `min()` בגריד,
  שוליים גמישים, מסגרת focus 3px, ואזור מגע 44px. העיצוב הנוכחי כבר עומד
  ברובם — לכן חלקם מדווחים `SKIPPED`, וזה תקין.

## עדכון תמונת השיתוף

`tools/og-card.html` הוא המקור. לערוך, לצלם ב-1200x630, לשמור כ-`assets/og-card.png`.
וואטסאפ שומרת תצוגות במטמון — לבדיקה מיידית להוסיף `?v=N` לקישור.
