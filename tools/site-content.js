// Everything the design tool does not own: the facts, the FAQ and the copy for
// the sections we append after it. Edit this file, then run:
//
//   node tools/site-fixes.js
//
// A FAQ answer left empty is NOT published — not on the page and not in the
// structured data. Placeholder text on a live sales page costs more than a
// missing question, so the script prints what is still empty instead.

module.exports = {
  // Change this the day a custom domain goes live. It is the single source for
  // canonical, og:url, sitemap.xml and the share links.
  siteUrl: 'https://beforeidoweb.vercel.app',

  brand: 'Before I Do',
  legalName: 'Liver Production',

  product: {
    name: 'Before I Do — קופסת השיחות לזוגות לפני החתונה',
    description:
      'חמישים כרטיסיות עם השאלות שכל זוג מאורס צריך לשאול לפני החתונה. ' +
      'ערב אחד, שיחה אמיתית, בלי שיפוטיות.',
    price: '129',
    currency: 'ILS',
    // 'InStock' | 'PreOrder' | 'OutOfStock' — must match reality, it shows in Google.
    availability: 'InStock',
    image: 'assets/img/img-2.jpg',
  },

  faq: [
    {
      q: 'מה בדיוק מקבלים בקופסה?',
      a: 'קופסה אחת עם חמישים כרטיסיות. בכל כרטיסייה שאלה שנוגעת בחתונה שאתם מתכננים — ובזוגיות שמאחוריה. בלי הוראות מסובכות ובלי ניקוד.',
    },
    {
      q: 'כמה זמן לוקח לשחק?',
      a: 'בערך שעה. אין חובה לסיים את כל החמישים בערב אחד — הרבה זוגות עוברים עשר שאלות, נתקעים על אחת, ומדברים עליה חצי שעה. זה בסדר גמור, זו בעצם המטרה.',
    },
    {
      q: 'מתי הכי כדאי לשחק?',
      a: 'בחודש הראשון אחרי האירוסין, כשההתרגשות בשיאה וההחלטות עוד פתוחות. אחרי שכבר סגרתם אולם, תאריך וקייטרינג, חלק מהשיחות כבר נסגרו בלעדיכם.',
    },
    {
      q: 'זה לא יהיה מביך?',
      a: 'השאלות לא נכתבו כדי לתפוס אתכם. הן נכתבו כדי לשאול עכשיו דברים שממילא יעלו — רק מאוחר יותר, ובדרך כלל בתזמון פחות נוח. אם שאלה לא מתאימה לכם הערב, מניחים אותה בצד ועוברים לבאה.',
    },
    {
      q: 'כבר דיברנו על הכל. זה עדיין רלוונטי לנו?',
      a: 'ברוב הזוגות מסתבר שדיברתם על הלוגיסטיקה ולא על מה שמתחתיה. מי מוזמן זו לוגיסטיקה. מי ייעלב אם לא יוזמן זו שיחה אחרת לגמרי.',
    },
    {
      q: 'זה ייעוץ זוגי?',
      a: 'לא. זו קופסת שאלות שנועדה לפתוח שיחה בין שניכם, ואינה תחליף לייעוץ או לטיפול זוגי מקצועי.',
    },

    // ── ממתין לתשובות שלכם ────────────────────────────────────────────────
    // מלאו את a ושמרו. מה שנשאר ריק פשוט לא יפורסם.
    { q: 'כמה עולה המשלוח וכמה זמן הוא לוקח?', a: '' },
    { q: 'אפשר לשלוח את הקופסה ישירות לזוג כמתנה?', a: '' },
    { q: 'אפשר להחזיר או להחליף?', a: '' },
    { q: 'מי כתב את חמישים השאלות?', a: '' },
  ],

  faqHeading: 'שאלות שנשאלנו',

  // הסקשן שסוגר את הדף: לכידת מי שלא קונה היום, ושיתוף למי שקונה למישהו אחר.
  closing: {
    heading: 'עוד לא הרגע הנכון?',
    body: 'השאירו מייל ונזכיר לכם כשתתקרבו לתאריך. בלי הצפה, בלי ספאם.',
    placeholder: 'המייל שלך',
    submit: 'שלחו לי תזכורת',
    consent: 'אני מאשר/ת קבלת עדכונים במייל. אפשר להסיר את עצמכם מכל הודעה.',
    thanks: 'נרשמתם. נזכיר לכם בזמן.',
    error: 'משהו לא עבד. נסו שוב עוד רגע.',
    shareHeading: 'מכירים זוג שמתחתן?',
    shareBody: 'שלחו להם את זה. זו בדיוק המתנה שאף אחד לא חושב עליה בזמן.',
    shareWhatsapp: 'שיתוף בוואטסאפ',
    shareCopy: 'העתקת קישור',
    shareCopied: 'הקישור הועתק',
    // הטקסט שנשלח בוואטסאפ. {url} מוחלף בכתובת האתר.
    shareText: 'ראיתי את זה וחשבתי עליכם — חמישים שאלות לזוג לפני החתונה. {url}',
  },
};
