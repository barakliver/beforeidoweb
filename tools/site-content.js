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

  // Which picture WhatsApp and Facebook show for a link. Filenames are content
  // hashes, so a page's images are chosen by a piece of their alt text.
  // Empty picks the first photo in the design.
  socialImageAlt: '',

  // One entry per page of the site, keyed by its file. The key is also the
  // name you pass to the importer:
  //
  //   node tools/import-design.js ~/Downloads/Terms.html terms   → terms.html
  //
  // A page missing from here still imports — it just gets the default title
  // and stays out of sitemap.xml, and the importer says so.
  pages: {
    'index.html': {
      path: '/',
      sections: true,   // שאלות נפוצות, לכידת מיילים ושיתוף — רק בדף המכירה
      product: true,    // נתוני Product/Offer לגוגל — רק איפה שבאמת מוכרים
    },

    // עמודים שייווצרו בהמשך. בטלו את ההערה כשהעמוד מיובא:
    //
    // 'terms.html': {
    //   path: '/terms',
    //   title: 'תקנון ותנאי שימוש — Before I Do',
    //   description: 'תנאי הרכישה, האחריות והשימוש באתר Before I Do.',
    // },
    // 'privacy.html': {
    //   path: '/privacy',
    //   title: 'מדיניות פרטיות — Before I Do',
    //   description: 'איזה מידע נאסף באתר, לשם מה, ואיך מבקשים למחוק אותו.',
    // },
    // 'returns.html':     { path: '/returns',     title: 'ביטול עסקה והחזרות — Before I Do' },
    // 'accessibility.html': { path: '/accessibility', title: 'הצהרת נגישות — Before I Do' },
    // '404.html':         { path: '/404', sitemap: false },
  },

  product: {
    name: 'Before I Do — קופסת השיחות לזוגות לפני החתונה',
    description:
      'חמישים כרטיסיות עם השאלות שכל זוג מאורס צריך לשאול לפני החתונה. ' +
      'ערב אחד, שיחה אמיתית, בלי שיפוטיות.',
    price: '129',
    currency: 'ILS',
    // 'InStock' | 'PreOrder' | 'OutOfStock' — must match reality, it shows in Google.
    availability: 'InStock',
    // Fallback only. The live value is whatever the importer wrote into
    // og:image, so the preview picture and the structured data cannot drift.
    image: 'assets/social.jpg',
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

  // ── משלוחים והחזרות ───────────────────────────────────────────────────────
  // פאנל שנפתח בלחיצה, מעל השאלות הנפוצות. כל עוד intro, bullets ו-note
  // ריקים — הפאנל כולו לא מופיע בדף. אל תמלאו פרטים שאינם נכונים: כתובת
  // איסוף ושעות פתיחה הן הבטחה שאנשים מגיעים לפיה פיזית.
  shipping: {
    heading: 'משלוחים והחזרות',

    // שורת הפתיחה. לדוגמה:
    // 'משלוחים לכל הארץ בין 2-4 ימי עסקים. ליישובים מרוחקים עד 7 ימי עסקים.'
    intro: '',

    // כל נקודה היא שורה נפרדת. אפשר להדגיש את תחילת השורה עם **כוכביות**.
    // לדוגמה:
    // '**איסוף עצמי** מרחוב … בימים א׳-ה׳ בין 10:00-15:00, בתיאום מראש.',
    // '**החזרות** — עד 14 יום מקבלת המוצר, כל עוד הקופסה לא נפתחה.',
    bullets: [],

    // הערת שוליים קטנה בתחתית, לדוגמה על השארת חבילה ליד הדלת.
    note: '',

    // הסיום מקשר לוואטסאפ שלכם. ריק = לא מוצג.
    askText: 'יש לכם שאלה?',
    askLabel: 'דברו איתנו',
  },

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
    shareText: 'ראיתי את זה וחשבתי עלייך — חמישים שאלות לזוג לפני החתונה. {url}',
  },

  // ── יצירת קשר ─────────────────────────────────────────────────────────────
  // כל שדה שנשאר ריק פשוט לא מוצג. אין פלייסהולדרים על דף מכירה.
  contact: {
    heading: 'דברו איתנו',
    body: 'שאלה על הקופסה, הזמנה בכמויות, או סתם רצון לדבר עם בן אדם.',

    // רוב העסקים מקבלים וואטסאפ על אותו מספר שבו עונים לטלפון, ולכן מספיק
    // למלא את phone למטה — הוואטסאפ ייגזר ממנו אוטומטית. מלאו כאן רק אם
    // הוואטסאפ הוא מספר אחר, בפורמט בינלאומי: '972541234567'.
    whatsappNumber: '',
    whatsappLabel: 'וואטסאפ',
    // ההודעה שתיפתח כבר מוכנה אצל מי שלוחץ. {qty} מוחלף בכמות שנבחרה בדף.
    whatsappMessage: 'היי! ראיתי את Before I Do ואני רוצה להזמין {qty} קופסאות.',
    whatsappMessageGeneral: 'היי! יש לי שאלה על Before I Do.',

    // כשיש מספר וואטסאפ, כפתורי "אני רוצה את המשחק" ו"מצאתי מתנה" פותחים
    // אותו עם ההודעה למעלה. זה הנתיב לרכישה עד שתהיה סליקה.
    // false משאיר אותם כפי שהם היום — בלי יעד.
    ctaOpensWhatsapp: true,

    // המספר היחיד שצריך: כפי שהוא יוצג בדף. '054-1234567'
    phone: '052-6604320',
    email: '',
    instagram: 'https://www.instagram.com/beforeido_wedding/',
    instagramLabel: '@beforeido_wedding',
  },
};
