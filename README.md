# Before I Do — אתר השיווק

אתר סטטי של המשחק "Before I Do" (Liver Production).
המקור הוא עיצוב שנבנה ב-Claude Design ויוצא כקובץ bundle יחיד;
כאן הוא פרוס לאתר אמיתי שאפשר לארח על דומיין משלנו.

## עדכון האתר אחרי שינוי עיצוב

כשמגיע ייצוא חדש מ-Claude Design (קובץ HTML אחד, "Bundled Page"):

```bash
node tools/import-design.js ~/Downloads/Before_I_Do.html
python3 -m http.server 8099     # לבדוק שהכל נראה טוב
git add -A && git commit -m "עדכון עיצוב" && git push
```

Vercel פורסת אוטומטית אחרי ה-push.

הסקריפט מפרק את ה-bundle לקבצים ומחיל מחדש את כל מה ש-Claude Design
לא מייצאת בעצמה: `lang="he" dir="rtl"`, כותרת ותגיות שיתוף, פאביקון,
React מקומי, הסתרת הערות העיצוב, וכותרות שמתכווצות במסך צר.
הוא מדפיס `ok` או `SKIPPED` לכל תיקון — **`SKIPPED` אומר שהעיצוב השתנה
באזור הזה וצריך להסתכל על הדף לפני פרסום.**

## מבנה

```
index.html                 הדף עצמו (רכיב x-dc + התוכן)
assets/js/app.js           מנוע ה-rendering של Claude Design (dc-runtime)
assets/js/react*.js        React 18 — מוגש מהאתר, לא מ-unpkg
assets/img/                תמונות (PNG/JPG)
assets/fonts/              Assistant / Heebo / Caveat (woff2, מוטמעות)
assets/favicon.svg         אייקון הלב
assets/og-card.png         תמונת השיתוף (וואטסאפ/פייסבוק), 1200x630
tools/import-design.js     ממיר ייצוא של Claude Design לאתר הזה
tools/og-card.html         המקור של תמונת השיתוף
```

### עדכון תמונת השיתוף

`tools/og-card.html` הוא המקור. לערוך אותו, ואז לצלם ב-1200x630 ולשמור
כ-`assets/og-card.png`. הגופנים נטענים מ-`assets/fonts/`.

אין שלב build ואין תלויות. זה HTML סטטי — כל שרת סטטי יגיש אותו.

## הרצה מקומית

```bash
python3 -m http.server 8099
# → http://127.0.0.1:8099
```

חובה להגיש דרך שרת (`http://`) ולא לפתוח את הקובץ ישירות (`file://`),
כי ה-runtime טוען את `app.js` ואת הגופנים כמשאבים יחסיים.

## הערות תחזוקה

כל התיקונים האלה מוחלים על ידי `tools/import-design.js`, לא ביד —
לערוך שם, אחרת הם ייעלמו בייצוא הבא.

- **הערות העיצוב הפנימיות** (המקטע "Gift route — three opening lines"
  וכו') מוסתרות דרך `showVoiceNotes`, גם ב-`data-props` וגם בברירת
  המחדל בקוד הרכיב.
- **כותרות מעל 32px** מקבלות `font-size:clamp(...)` אחרי ה-shorthand,
  כך שבטלפון הן מתכווצות ובדסקטופ הגודל המקורי נשמר.
- **React מוגש מקומית** דרך `window.__resources` ב-`<head>`, כדי שלא
  תהיה תלות ב-CDN חיצוני וכדי שה-runtime לא ימשוך מחדש את מקור הדף.
- **כפתורי ה-CTA** ("אני רוצה את המשחק", "מצאתי מתנה") הם עדיין
  `<button>` בלי פעולה — הם ממתינים לחיבור הסליקה.
