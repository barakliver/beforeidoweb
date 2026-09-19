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

## מבנה

```
index.html, checkout.html, ...   העמודים הבנויים (לא לערוך ביד)
assets/js/app.js                 מנוע ה-rendering של Claude Design
assets/js/react*.js              React 18 — מוגש מהאתר, לא מ-unpkg
assets/fonts.css + fonts/        Assistant / Heebo / Caveat
assets/img/                      תמונות, ממוזערות לפי תוכן
assets/og-card.png               תמונת השיתוף (וואטסאפ/פייסבוק)
assets/favicon.svg               אייקון הלב
tools/build-site.js              בונה את האתר מייצוא הפרויקט
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
