// Builds the blog from tools/blog-posts.js.
//
// These pages are written here rather than transformed out of a design export
// like the rest of the site, so they are plain static HTML: no page runtime,
// no hydration, nothing to boot. An article should render before a script has
// had a chance to run.
//
//   node tools/build-blog.js

const fs = require('fs');
const path = require('path');
const { POSTS } = require('./blog-posts.js');

const ROOT = path.join(__dirname, '..');
const SITE = 'https://www.beforeido.co.il';
const BLUE = '#4F6BA5';
const INK = '#2F3F63';
const RED = '#EF453D';

const HEART = '<svg width="20" height="17" viewBox="0 0 24 21" fill="#EF453D" aria-hidden="true" style="display:block"><path d="M12 20.4C12 20.4 1.2 13.3 1.2 7.1 1.2 3.7 3.9 1 7.1 1 9.2 1 11.1 2.1 12 3.8 12.9 2.1 14.8 1 16.9 1 20.1 1 22.8 3.7 22.8 7.1 22.8 13.3 12 20.4 12 20.4Z"></path></svg>';

const IG = '<a class="bid-f-ig" href="https://www.instagram.com/beforeido_wedding" target="_blank" rel="noopener" aria-label="Before I Do באינסטגרם">\n<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="2.4" y="2.4" width="19.2" height="19.2" rx="5.4"/><circle cx="12" cy="12" r="4.2"/><circle cx="17.5" cy="6.5" r="1.15" fill="currentColor" stroke="none"/></svg>\n</a>';

const hebDate = iso => {
  const [y, m, d] = iso.split('-');
  return `${+d}.${+m}.${y}`;
};

const header = `<header class="bl-top">
<div class="bl-top-in">
<a class="bl-brand" href="/">${HEART}<span>Before I Do</span></a>
<nav class="bl-top-nav">
<a href="/blog">הבלוג</a>
<a class="bl-cta" href="/checkout">אני רוצה את המשחק</a>
</nav>
</div>
</header>`;

const footer = `<footer id="bid-footer" dir="rtl">
<div class="bid-f-bar">
<div class="bid-f-brand">
<a class="bid-f-logo" href="/">
${HEART}
<span>Before I Do</span>
</a>
${IG}
</div>
<nav class="bid-f-links" aria-label="מידע ותקנון">
<a href="/terms#terms">תקנון האתר</a>
<a href="/#bid-faq-section">שאלות ותשובות</a>
<a href="/terms#returns">משלוחים והחזרות</a>
<a href="tel:0526604320">צור קשר</a>
</nav>
</div>
<div class="bid-f-fine">
<a href="/privacy#privacy">מדיניות פרטיות</a>
<a href="/privacy#accessibility">הצהרת נגישות</a>
<a href="/privacy#cookies">העדפות עוגיות</a>
</div>
</footer>`;

const CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  :root { color-scheme: light; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0; background: #fff; color: ${INK};
    font: 300 17px/1.85 Assistant, system-ui, sans-serif;
  }
  a { color: ${BLUE}; }
  a:focus-visible, button:focus-visible {
    outline: 3px solid ${RED}; outline-offset: 3px; border-radius: 4px;
  }
  img { max-width: 100%; height: auto; }

  /* ── header ───────────────────────────────────────────── */
  .bl-top { background: #fff; border-bottom: 1.5px solid rgba(79,107,165,.25); }
  .bl-top-in {
    max-width: 1180px; margin: 0 auto; padding: 12px clamp(20px,5vw,32px);
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px clamp(14px,3vw,26px); flex-wrap: wrap;
  }
  .bl-brand { display: inline-flex; align-items: center; gap: 11px; min-height: 44px; text-decoration: none; }
  .bl-brand span { font: 500 clamp(17px,2.94vw,26px)/1 Caveat, cursive; color: ${BLUE}; }
  .bl-top-nav { display: flex; align-items: center; gap: 10px clamp(14px,3vw,24px); flex-wrap: wrap; }
  .bl-top-nav > a {
    display: inline-flex; align-items: center; min-height: 44px;
    font: 400 16px/1 Assistant, sans-serif; color: ${BLUE};
    text-decoration: underline; text-underline-offset: 4px;
  }
  .bl-cta {
    text-decoration: none !important; color: #fff !important;
    background: #D63229; border: 1.5px solid #D63229; border-radius: 8px;
    padding: 0 22px; height: 44px; font-weight: 600 !important; white-space: nowrap;
    transition: transform 200ms cubic-bezier(.22,.8,.3,1), box-shadow 200ms ease;
  }
  @media (hover: hover) { .bl-cta:hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(31,44,74,.18); } }
  .bl-cta:active { transform: translateY(0); }

  /* ── shared shell ─────────────────────────────────────── */
  .bl-wrap { max-width: 720px; margin: 0 auto; padding: clamp(36px,6vw,68px) clamp(20px,5vw,32px); }
  .bl-eyebrow {
    margin: 0 0 14px; font: 400 12.5px/1 Assistant, sans-serif;
    letter-spacing: 3px; color: rgba(47,63,99,.5);
  }
  .bl-rule { display: block; width: 44px; height: 2px; background: ${RED}; margin: clamp(22px,3vw,30px) 0; }

  /* ── index ────────────────────────────────────────────── */
  .bl-index h1 {
    margin: 0; font: 700 clamp(30px,5vw,50px)/1.12 Heebo, sans-serif;
    letter-spacing: -1px; color: ${BLUE};
  }
  .bl-index > p.bl-dek {
    margin: clamp(18px,2.4vw,24px) 0 0; max-width: 46ch;
    font: 300 clamp(17px,2.1vw,19px)/1.8 Assistant, sans-serif; color: rgba(47,63,99,.85);
  }
  .bl-list { margin: clamp(34px,5vw,54px) 0 0; display: flex; flex-direction: column; gap: clamp(20px,3vw,26px); }
  .bl-card {
    display: block; text-decoration: none; background: #F7F6F3;
    border-radius: 14px; padding: clamp(24px,3.4vw,32px);
    transition: transform 220ms cubic-bezier(.22,.8,.3,1), box-shadow 220ms ease;
  }
  @media (hover: hover) { .bl-card:hover { transform: translateY(-3px); box-shadow: 0 16px 34px rgba(31,44,74,.12); } }
  .bl-card-meta { margin: 0 0 12px; font: 400 13px/1 Assistant, sans-serif; color: rgba(47,63,99,.55); }
  .bl-card h2 {
    margin: 0; font: 700 clamp(20px,2.8vw,26px)/1.35 Heebo, sans-serif; color: ${BLUE};
  }
  .bl-card p { margin: 12px 0 0; font: 300 16px/1.75 Assistant, sans-serif; color: rgba(47,63,99,.85); }
  .bl-card span.bl-more {
    display: inline-block; margin-top: 16px;
    font: 600 15px/1 Assistant, sans-serif; color: ${RED};
    border-bottom: 1.5px solid ${RED}; padding-bottom: 5px;
  }

  /* ── article ──────────────────────────────────────────── */
  .bl-post h1 {
    margin: 0; font: 700 clamp(28px,4.6vw,46px)/1.15 Heebo, sans-serif;
    letter-spacing: -.8px; color: ${BLUE};
  }
  .bl-lede {
    margin: clamp(20px,2.6vw,26px) 0 0;
    font: 300 clamp(18px,2.3vw,21px)/1.75 Assistant, sans-serif; color: rgba(47,63,99,.85);
  }
  .bl-body { margin-top: clamp(8px,1.4vw,14px); }
  .bl-body h2 {
    margin: clamp(38px,5vw,56px) 0 clamp(12px,1.6vw,18px);
    font: 700 clamp(22px,3vw,30px)/1.3 Heebo, sans-serif; color: ${BLUE}; letter-spacing: -.4px;
  }
  .bl-body h3 {
    margin: clamp(26px,3.4vw,34px) 0 clamp(8px,1.2vw,12px);
    font: 700 clamp(18px,2.2vw,21px)/1.4 Heebo, sans-serif; color: ${INK};
  }
  .bl-body p { margin: 0 0 clamp(14px,1.8vw,20px); }
  .bl-body strong { font-weight: 700; color: ${BLUE}; }
  .bl-body ul { margin: 0 0 clamp(16px,2vw,22px); padding-inline-start: 0; list-style: none; }
  .bl-body ul > li {
    position: relative; margin: 0 0 10px; padding-inline-start: 22px;
  }
  .bl-body ul > li::before {
    content: ""; position: absolute; inset-inline-start: 4px; top: .78em;
    width: 6px; height: 6px; border-radius: 50%; background: ${RED};
  }

  /* A two-column figure list. Real table semantics through roles, so it
     reads correctly to a screen reader without a <table> to wrangle in RTL. */
  .bl-table {
    margin: 0 0 clamp(18px,2.4vw,26px);
    border-block-start: 1px solid rgba(79,107,165,.22);
  }
  .bl-table > [role="row"] {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: 16px; padding: 14px 2px;
    border-block-end: 1px solid rgba(79,107,165,.22);
  }
  .bl-table [role="rowheader"] { font: 400 16px/1.4 Assistant, sans-serif; color: rgba(47,63,99,.85); }
  .bl-table [role="cell"] {
    font: 700 clamp(17px,2.1vw,19px)/1.2 Heebo, sans-serif; color: ${BLUE};
    white-space: nowrap; direction: ltr; unicode-bidi: isolate;
  }

  /* ── the product, once, at the end ────────────────────── */
  .bl-plug {
    margin: clamp(44px,6vw,68px) 0 0; background: ${BLUE}; border-radius: 16px;
    padding: clamp(28px,4vw,40px); color: #fff; text-align: center;
  }
  .bl-plug p.bl-plug-eye {
    margin: 0 0 12px; font: 400 12.5px/1 Assistant, sans-serif;
    letter-spacing: 3px; color: rgba(255,255,255,.6);
  }
  .bl-plug h2 { margin: 0; font: 700 clamp(21px,2.8vw,27px)/1.35 Heebo, sans-serif; color: #fff; }
  .bl-plug p.bl-plug-body {
    margin: 14px auto 0; max-width: 46ch;
    font: 300 16px/1.8 Assistant, sans-serif; color: rgba(255,255,255,.9);
  }
  .bl-plug a {
    display: inline-flex; align-items: center; justify-content: center;
    margin-top: 24px; min-height: 52px; padding: 0 34px; border-radius: 8px;
    background: #fff; color: ${BLUE}; border: 1.5px solid #fff;
    font: 600 17px/1 Assistant, sans-serif; text-decoration: none; white-space: nowrap;
    transition: transform 200ms cubic-bezier(.22,.8,.3,1), box-shadow 200ms ease;
  }
  @media (hover: hover) { .bl-plug a:hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(0,0,0,.2); } }
  .bl-plug a:active { transform: translateY(0); }

  .bl-back { margin: clamp(30px,4vw,44px) 0 0; font: 400 15px/1 Assistant, sans-serif; }
  .bl-back a { display: inline-flex; align-items: center; min-height: 44px; }

  /* ── footer (same bar the rest of the site carries) ───── */
  #bid-footer {
    background: #3E568A;
    padding: clamp(26px,3.6vw,34px) clamp(20px,5vw,32px) clamp(20px,3vw,26px);
    font-family: Assistant, system-ui, sans-serif;
  }
  .bid-f-bar {
    max-width: 1180px; margin: 0 auto;
    display: flex; flex-wrap: wrap; align-items: center;
    justify-content: space-between; gap: 2px clamp(18px,3vw,32px);
  }
  .bid-f-logo { display: inline-flex; align-items: center; gap: 10px; min-height: 44px; text-decoration: none; }
  .bid-f-logo span { font: 500 clamp(16px,2.4vw,21px)/1 Caveat, cursive; color: #fff; }
  .bid-f-links { display: flex; flex-wrap: wrap; align-items: center; gap: 0 clamp(16px,2.4vw,28px); }
  .bid-f-links > a {
    display: inline-flex; align-items: center; min-height: 44px;
    font: 400 15px/1.5 Assistant, sans-serif; color: #fff;
    text-decoration: underline; text-underline-offset: 3px;
  }
  .bid-f-fine {
    max-width: 1180px; margin: clamp(10px,1.4vw,14px) auto 0;
    padding-block-start: clamp(10px,1.4vw,14px);
    border-block-start: 1px solid rgba(255,255,255,.14);
    display: flex; flex-wrap: wrap; align-items: center; gap: 0 clamp(14px,2vw,22px);
  }
  .bid-f-fine > a {
    display: inline-flex; align-items: center; min-height: 36px;
    font: 400 13px/1.5 Assistant, sans-serif; color: rgba(255,255,255,.62);
    text-decoration: underline; text-underline-offset: 3px;
  }
  @media (hover: hover) { .bid-f-fine > a:hover { color: #fff; } }
  .bid-f-brand { display: inline-flex; align-items: center; gap: clamp(6px,1.4vw,12px); }
  .bid-f-ig {
    display: inline-flex; align-items: center; justify-content: center;
    width: 44px; height: 44px; color: rgba(255,255,255,.72); text-decoration: none;
    transition: color 200ms ease, transform 200ms cubic-bezier(.22,.8,.3,1);
  }
  .bid-f-ig svg { display: block; width: 21px; height: 21px; }
  @media (hover: hover) { .bid-f-ig:hover { color: #fff; transform: translateY(-2px); } }
  @media (max-width: 760px) {
    .bid-f-bar { justify-content: center; gap: 4px 0; }
    .bid-f-links { justify-content: center; gap: 0 20px; }
    .bid-f-fine { justify-content: center; gap: 0 18px; }
  }
  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; }
  }
`;

const shell = ({ title, desc, canonical, schema, main }) => `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${desc}">
<meta name="theme-color" content="#4F6BA5">
<link rel="canonical" href="${SITE}${canonical}">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/fonts.css">
<meta property="og:type" content="${canonical === '/blog' ? 'website' : 'article'}">
<meta property="og:locale" content="he_IL">
<meta property="og:site_name" content="Before I Do">
<meta property="og:url" content="${SITE}${canonical}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="${SITE}/assets/og-card.png">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${schema}</script>
<style>${CSS}</style>
<!-- Google tag (gtag.js) — denied until the cookie banner is answered -->
<script>
(function () {
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { dataLayer.push(arguments); };

  function state() {
    try {
      var raw = localStorage.getItem('bid-cookie-consent');
      return raw && JSON.parse(raw).value === 'all' ? 'granted' : 'denied';
    } catch (e) { return 'denied'; }
  }

  var v = state();
  gtag('consent', 'default', {
    ad_storage: v, ad_user_data: v, ad_personalization: v,
    analytics_storage: v, wait_for_update: 500
  });
  gtag('js', new Date());
  gtag('config', 'AW-18472514997');

  var last = v;
  setInterval(function () {
    var now = state();
    if (now === last) return;
    last = now;
    gtag('consent', 'update', {
      ad_storage: now, ad_user_data: now,
      ad_personalization: now, analytics_storage: now
    });
  }, 700);
})();
</script>
<script async src="https://www.googletagmanager.com/gtag/js?id=AW-18472514997"></script>
</head>
<body>
${header}
${main}
${footer}
</body>
</html>
`;

// ── the blog index ────────────────────────────────────────────────────────
function buildIndex(POSTS) {
  const schema = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Blog',
    '@id': SITE + '/blog#blog',
    name: 'הבלוג של Before I Do',
    inLanguage: 'he-IL',
    publisher: { '@id': SITE + '/#org' },
    blogPost: POSTS.map(p => ({
      '@type': 'BlogPosting',
      headline: p.title,
      datePublished: p.date,
      url: `${SITE}/blog/${p.slug}`,
    })),
  });

  const cards = POSTS.map(p => `<a class="bl-card" href="/blog/${p.slug}">
<p class="bl-card-meta">${hebDate(p.date)} · ${p.minutes} דקות קריאה · ${p.tag}</p>
<h2>${p.title}</h2>
<p>${p.lede}</p>
<span class="bl-more">לקריאה</span>
</a>`).join('\n');

  const main = `<main class="bl-wrap bl-index">
<p class="bl-eyebrow">הבלוג</p>
<h1>מה שכדאי לדעת לפני שמתחילים לתכנן.</h1>
<p class="bl-dek">כתבות מהצד השני של האירוע. מה שאני רואה חוזר על עצמו אצל זוגות, ומה אפשר לעשות עם זה מראש.</p>
<i class="bl-rule" aria-hidden="true"></i>
<div class="bl-list">
${cards}
</div>
</main>`;

  const out = path.join(ROOT, 'blog', 'index.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, shell({
    title: 'הבלוג — Before I Do',
    desc: 'כתבות על תכנון חתונה מהצד של המפיק: מאיפה מתחילים, איך מדברים על תקציב, ואיך עוברים את התהליך ביחד.',
    canonical: '/blog',
    schema, main,
  }));
  return 'blog/index.html';
}

// ── one article ───────────────────────────────────────────────────────────
function buildPost(p) {
  const schema = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BlogPosting',
        '@id': `${SITE}/blog/${p.slug}#post`,
        headline: p.title,
        description: p.metaDesc,
        inLanguage: 'he-IL',
        datePublished: p.date,
        dateModified: p.updated || p.date,
        wordCount: p.body.replace(/<[^>]*>/g, ' ').trim().split(/\s+/).length,
        image: [`${SITE}/assets/og-card.png`],
        mainEntityOfPage: { '@type': 'WebPage', '@id': `${SITE}/blog/${p.slug}` },
        author: {
          '@type': 'Person',
          name: 'ברק ליור',
          jobTitle: 'מפיק חתונות',
          url: SITE + '/#bid-barak',
        },
        publisher: { '@id': SITE + '/#org' },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'ראשי', item: SITE + '/' },
          { '@type': 'ListItem', position: 2, name: 'הבלוג', item: SITE + '/blog' },
          { '@type': 'ListItem', position: 3, name: p.title },
        ],
      },
    ],
  });

  const main = `<main class="bl-wrap bl-post">
<article>
<p class="bl-eyebrow">${p.tag}</p>
<h1>${p.title}</h1>
<p class="bl-lede">${p.lede}</p>
<p class="bl-card-meta" style="margin:18px 0 0">מאת ברק ליור, מפיק חתונות · <time datetime="${p.date}">${hebDate(p.date)}</time> · ${p.minutes} דקות קריאה</p>
<i class="bl-rule" aria-hidden="true"></i>
<div class="bl-body">${p.body.trim()}</div>
</article>

<aside class="bl-plug">
<p class="bl-plug-eye">מאותו מקום</p>
<h2>את השיחות האלה בניתי לקופסה.</h2>
<p class="bl-plug-body">70 קלפים עם השאלות שכדאי לשאול לפני שסוגרים את הדבר הראשון. ערב אחד, על הספה, בלי אקסלים ובלי ספק שמחכה על הקו.</p>
<a href="/">לעמוד המשחק</a>
</aside>

<p class="bl-back"><a href="/blog">חזרה לכל הכתבות</a></p>
</main>`;

  const out = path.join(ROOT, 'blog', p.slug + '.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, shell({
    title: p.metaTitle, desc: p.metaDesc,
    canonical: `/blog/${p.slug}`, schema, main,
  }));
  return `blog/${p.slug}.html`;
}

const live = POSTS.filter(p => !p.draft);
const held = POSTS.length - live.length;
const written = [buildIndex(live), ...live.map(buildPost)];
console.log('blog      ' + written.length + ' page(s)');
written.forEach(f => console.log('  ok      ' + f));
if (held) console.log('  held    ' + held + ' draft(s), not built and not in the sitemap');
