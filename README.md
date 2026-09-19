# Before I Do — אתר השיווק

אתר סטטי של המשחק "Before I Do" (Liver Production).
המקור הוא עיצוב שנבנה ב-Claude Design ויוצא כקובץ bundle יחיד;
כאן הוא פרוס לאתר אמיתי שאפשר לארח על דומיין משלנו.

## מבנה

```
index.html                 הדף עצמו (רכיב x-dc + התוכן)
assets/js/app.js           מנוע ה-rendering של Claude Design (dc-runtime)
assets/js/react*.js        React 18 — מוגש מהאתר, לא מ-unpkg
assets/img/                תמונות (PNG/JPG)
assets/fonts/              Assistant / Heebo / Caveat (woff2, מוטמעות)
assets/favicon.svg         אייקון הלב
```

אין שלב build ואין תלויות. זה HTML סטטי — כל שרת סטטי יגיש אותו.

## הרצה מקומית

```bash
python3 -m http.server 8099
# → http://127.0.0.1:8099
```

חובה להגיש דרך שרת (`http://`) ולא לפתוח את הקובץ ישירות (`file://`),
כי ה-runtime טוען את `app.js` ואת הגופנים כמשאבים יחסיים.

## הערות תחזוקה

- **הערות העיצוב הפנימיות** (המקטע "Gift route — three opening lines"
  וכו') מוסתרות: `showVoiceNotes` הוגדר `false` גם ב-`data-props` וגם
  בברירת המחדל בקוד הרכיב. כדי להחזיר אותן — להפוך את שניהם ל-`true`.
- **React מוגש מקומית** דרך `window.__resources` ב-`<head>`, כדי שלא
  תהיה תלות ב-CDN חיצוני וכדי שה-runtime לא ימשוך מחדש את מקור הדף.
- **כפתורי ה-CTA** ("אני רוצה את המשחק", "מצאתי מתנה") הם עדיין
  `<button>` בלי פעולה — הם ממתינים לחיבור הסליקה.
