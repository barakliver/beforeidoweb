#!/usr/bin/env node
// Build the site from a Claude Design project export.
//
//   unzip "Visual system board review.zip" -d /tmp/bid
//   node tools/build-site.js /tmp/bid
//
// The project ships each page twice: as a `<name>.dc.html` source and, for
// some pages, as a self-extracting bundle under export/. We build from the
// sources — they cover every page (the bundles miss Checkout), they share one
// runtime and one set of images instead of inlining a copy per page, and they
// are what the designer actually edits.
//
// Sources need three things the design tool serves locally and we must supply:
// the runtime (support.js), the images (uploads/), and fonts (it links Google
// Fonts; we serve the subsets from the export bundle instead).
//
// Every fix is reported as applied or skipped. SKIPPED is not fatal — the
// design may have moved — but someone should look before deploying.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SRC = process.argv[2];
if (!SRC) {
  console.error('usage: node tools/build-site.js <extracted-project-dir>');
  process.exit(1);
}

// ── the launch offer ──────────────────────────────────────────────────────
// Barak's terms: 70 cards, 129₪ WITH home delivery included, early orders ship
// on 26.10.26, and the offer closes at the end of that same day. After it
// closes the price is 189₪ and delivery is charged again.
//
// Israel leaves daylight saving on 25.10.2026, so 26.10 runs on UTC+2 and the
// end of that day is 21:59:59Z. Written as an absolute instant so the clock
// reads the same from every timezone a visitor might be in.
const OFFER = {
  cards: 70,
  price: 129,
  // The struck-through price is what it costs once the launch ends, so the
  // saving on show is the real one. There is only one other price.
  afterPrice: 189,
  shipping: 39,
  endsISO: '2026-10-26T21:59:59Z',
  endLabel: '26.10.26',
  shipDate: '26.10.26',
};

// The CTA red. Not the brand coral #EF453D: white on that is 3.76:1, under
// AA for a 15px label. This is 4.83:1 and reads as the same red.
const RED = '#D63229', RED_DARK = '#BC241C';
const SITE = 'https://www.beforeido.co.il';
const TAGLINE = 'משחק קלפים לזוגות מאורסים';
const BLURB = `${TAGLINE}. חמישים כרטיסיות עם השאלות שכל זוג מאורס צריך לשאול לפני החתונה — ערב אחד, שיחה אמיתית, בלי שיפוטיות. מאת Liver Production.`;

// Design-tool filename → public URL. Pages link to each other by source
// filename, in raw and percent-encoded form, sometimes with a #fragment.
const LINKS = {
  'Before I Do - Opening Experience.dc.html': '/',
  'Before I Do - Checkout.dc.html': '/checkout',
  'Before I Do - Terms.dc.html': '/terms',
  'Before I Do - Privacy.dc.html': '/privacy',
  // An older split of the same material; its only inbound link is #cookies,
  // which lives on the privacy page.
  'Before I Do - מדיניות.dc.html': '/privacy',
};

// Grow payment links. The amount is fixed on Grow's side and no URL parameter
// overrides it (sum/price/amount are all ignored), so a different total needs
// a different link.
//
// `launch` covers both delivery choices while the offer runs: delivery is
// included, so the total is 129₪ whether the box is shipped or collected —
// which is exactly what that link charges.
//
// `after` takes over the moment the clock reaches zero, with no deploy and no
// hand on the switch: 189₪ for the box, and Grow's own delivery selector adds
// 39₪ for home delivery or nothing for pickup. Verified against the link.
const PAY = {
  launch: 'https://pay.grow.link/OTU0ODQ~bf83dbe62447b9a2c28b0611db86e909-NDAxNjIzMw',
  after: 'https://pay.grow.link/OTU0ODQ~f2522df5261f6b64f81c1f3c57caf677-NDAxODgzNQ',
};

const PAGES = [
  { src: 'Before I Do - Opening Experience.dc.html', out: 'index.html',
    title: `Before I Do — ${TAGLINE}`, desc: BLURB, canonical: '/', og: true },
  { src: 'Before I Do - Checkout.dc.html', out: 'checkout.html',
    title: `הזמנה — Before I Do`, desc: TAGLINE, noindex: true },
  { src: 'Before I Do - Terms.dc.html', out: 'terms.html',
    title: `תקנון, משלוחים והחזרות — Before I Do`, desc: 'תנאי השימוש, מדיניות המשלוחים והחזרות של Before I Do.', canonical: '/terms' },
  { src: 'Before I Do - Privacy.dc.html', out: 'privacy.html',
    title: `מדיניות פרטיות ונגישות — Before I Do`, desc: 'מדיניות הפרטיות, השימוש בעוגיות והצהרת הנגישות של Before I Do.', canonical: '/privacy' },
  { src: 'Before I Do - 404.dc.html', out: '404.html',
    title: `העמוד לא נמצא — Before I Do`, desc: TAGLINE, noindex: true },
  // Internal review boards: reachable by link, never indexed.
  { src: 'Before I Do - Design Spec.dc.html', out: 'spec.html', board: true,
    title: `מפרט עיצוב — Before I Do`, desc: 'מסמך פנימי', noindex: true },
  { src: 'Before I Do - Visual DNA.dc.html', out: 'visual-dna.html', board: true,
    title: `Visual DNA — Before I Do`, desc: 'מסמך פנימי', noindex: true },
  { src: 'Before I Do - מדיניות.dc.html', out: 'policies.html', board: true,
    title: `מדיניות ומסמכים — Before I Do`, desc: 'מסמך פנימי', noindex: true },
];

// ── locate sources ────────────────────────────────────────────────────────
// unzip escapes non-ASCII names (מדיניות → #U05de…), so match on the parts
// of the name that survive rather than the literal Hebrew.
const onDisk = fs.readdirSync(SRC).filter(f => f.endsWith('.dc.html'));
function findSource(name) {
  if (fs.existsSync(path.join(SRC, name))) return path.join(SRC, name);
  const key = name.replace(/^Before I Do - /, '').replace(/\.dc\.html$/, '');
  if (/^[\x00-\x7F]*$/.test(key)) return null;
  const hit = onDisk.find(f => /#U[0-9a-f]{4}/i.test(f));   // the one escaped name
  return hit ? path.join(SRC, hit) : null;
}

// ── shared assets ─────────────────────────────────────────────────────────
for (const d of ['img', 'fonts', 'js']) {
  fs.rmSync(path.join(ROOT, 'assets', d), { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, 'assets', d), { recursive: true });
}

// Fonts + React come from a bundle's manifest — the sources have neither.
const bundlePath = path.join(SRC, 'export', 'Before_I_Do.html');
const bundle = fs.readFileSync(bundlePath, 'utf8');
const island = t => JSON.parse(
  bundle.match(new RegExp('<script type="__bundler/' + t + '">\\n([\\s\\S]*?)\\n\\s*<\\/script>'))[1]);
const manifest = island('manifest');
const extRes = island('ext_resources');
const bundleTpl = island('template');

const extByUuid = Object.fromEntries(extRes.map(r => [r.uuid, r.id]));
const fontPath = {};          // bundle uuid -> assets/fonts/…
const vendor = {};            // cdn url    -> assets/js/…
let nFont = 0;
for (const [uuid, e] of Object.entries(manifest)) {
  let buf = Buffer.from(e.data, 'base64');
  if (e.compressed) buf = zlib.gunzipSync(buf);
  if (e.mime.startsWith('font/')) {
    const rel = `assets/fonts/font-${++nFont}.woff2`;
    fs.writeFileSync(path.join(ROOT, rel), buf);
    fontPath[uuid] = rel;
  } else if (extByUuid[uuid]) {
    const rel = 'assets/js/' + path.basename(new URL(extByUuid[uuid]).pathname);
    fs.writeFileSync(path.join(ROOT, rel), buf);
    vendor[extByUuid[uuid]] = rel;
  }
}

// Runtime, with React pointed at our own copies.
//
// The obvious way to do that is window.__resources, and it is a trap: the
// runtime ALSO uses that object as the signal that its template came from a
// bundler, and skips re-reading the page source when it is set. We need that
// re-read. Served as raw source, the template is parsed by the browser first,
// and the browser is entitled to mangle it — <sc-for> inside <select> is not
// legal HTML, so Safari drops the city loop and the dropdown arrives empty
// while Chrome keeps it. The runtime's recovery path re-fetches the page and
// re-parses the template from text, which is immune to that.
//
// So we patch the constants instead and leave __resources unset. loadScript
// only sets integrity when it is truthy, so blanking the CDN hashes is what
// lets a local file load at all.
let runtime = fs.readFileSync(path.join(SRC, 'support.js'), 'utf8');
const pointAt = (constant, url) => {
  const before = runtime;
  runtime = runtime.replace(new RegExp(`var ${constant} = "[^"]*";`), `var ${constant} = "${url}";`);
  if (runtime === before) throw new Error(`runtime patch failed: ${constant} not found in support.js`);
};
for (const [url, rel] of Object.entries(vendor)) {
  const dom = /react-dom/.test(url);
  pointAt(dom ? 'REACT_DOM_URL' : 'REACT_URL', '/' + rel);
  pointAt(dom ? 'REACT_DOM_SRI' : 'REACT_SRI', '');
}
fs.writeFileSync(path.join(ROOT, 'assets/js/app.js'), runtime);

// The bundle's @font-face blocks carry the unicode-ranges that make the Hebrew
// and latin subsets load correctly — reuse them verbatim, repointed at us.
let faces = (bundleTpl.match(/@font-face \{[^}]*\}/g) || []).join('\n');
for (const [uuid, rel] of Object.entries(fontPath)) faces = faces.split(uuid).join('/' + rel);
fs.writeFileSync(path.join(ROOT, 'assets/fonts.css'), faces + '\n');

// Images, deduped by content: the project ships several under two names.
const imgByHash = {};
const imgPath = {};
for (const f of fs.readdirSync(path.join(SRC, 'uploads'))) {
  const buf = fs.readFileSync(path.join(SRC, 'uploads', f));
  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
  if (!imgByHash[hash]) {
    const ext = path.extname(f).toLowerCase().replace('.jpeg', '.jpg');
    const slug = path.basename(f, path.extname(f))
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28) || 'img';
    const rel = `assets/img/${slug}-${hash.slice(0, 6)}${ext}`;
    fs.writeFileSync(path.join(ROOT, rel), buf);
    imgByHash[hash] = rel;
  }
  imgPath['uploads/' + f] = imgByHash[hash];
}

console.log(`assets    ${nFont} fonts, ${Object.keys(vendor).length} vendor js, ` +
            `${Object.keys(imgByHash).length} images (from ${Object.keys(imgPath).length} files)`);

// ── per-page build ────────────────────────────────────────────────────────
function head(p) {
  const abs = u => SITE + u;
  const lines = [
    `<title>${p.title}</title>`,
    `<meta name="description" content="${p.desc}">`,
    `<meta name="theme-color" content="#4F6BA5">`,
  ];
  if (p.noindex) lines.push(`<meta name="robots" content="noindex, nofollow">`);
  if (p.canonical) lines.push(`<link rel="canonical" href="${abs(p.canonical)}">`);
  lines.push(
    `<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">`,
    `<link rel="stylesheet" href="/assets/fonts.css">`);
  if (p.og) lines.push(
    `<meta property="og:type" content="website">`,
    `<meta property="og:locale" content="he_IL">`,
    `<meta property="og:site_name" content="Before I Do">`,
    `<meta property="og:url" content="${abs('/')}">`,
    `<meta property="og:title" content="Before I Do">`,
    `<meta property="og:description" content="${TAGLINE}">`,
    `<meta property="og:image" content="${abs('/assets/og-card.png')}">`,
    `<meta property="og:image:type" content="image/png">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="Before I Do — ${TAGLINE}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="Before I Do">`,
    `<meta name="twitter:description" content="${TAGLINE}">`,
    `<meta name="twitter:image" content="${abs('/assets/og-card.png')}">`);
  return lines.join('\n') + '\n';
}

// Spec §07: focus ring 3px at 3px. Sources ship 2px.
// Spec §04: 44px minimum for anything clickable, text links included.
const SPEC_CSS = `<style>
  a:focus-visible, button:focus-visible, input:focus-visible,
  select:focus-visible, textarea:focus-visible, [tabindex]:focus-visible {
    outline: 3px solid #EF453D !important; outline-offset: 3px !important;
  }
  nav a, footer a, header a { min-height: 44px; display: inline-flex; align-items: center; }
</style>`;

// The review boards are written at desk width: a CSS snippet that cannot wrap,
// and blocks sized at a fixed 300px. Both overflow a phone. They are internal
// reading material, so readability wins over holding the authored widths —
// scoped to these pages and to narrow screens only, never the public pages.
const BOARD_CSS = `<style>
  @media (max-width: 760px) {
    /* A CSS snippet with no break opportunity is the one thing genuinely wider
       than the screen. Everything else only LOOKS wide: the rotated mock-ups
       sit at a negative offset, which in RTL still counts as page width, so
       clipping the axis is enough. Constraining widths element-by-element is
       not — it collapses the text to one word per line. */
    [style*="monospace"] { overflow-wrap: anywhere; word-break: break-word; }
    html, body { overflow-x: hidden; }
  }
</style>`;

// Floating share button. wa.me with no number opens WhatsApp on the contact
// picker with the text ready — a share, not a message to us, so the visitor
// chooses who gets it.
//
// It lives OUTSIDE <x-dc>, so the runtime never re-renders it and a redesign
// cannot displace it.
//
// The cookie banner is fixed to the bottom of the viewport and would sit under
// the button, so the button lifts itself above whatever occupies the bottom
// edge. That is measured, not hardcoded to the banner: any fixed element
// anchored near the bottom counts, and when it goes away the button drops back
// down. Nothing here depends on the banner's markup or wording.
const SHARE_TEXT = `ראיתי את זה וחשבתי עליכם\n${SITE}`;
const SHARE_FLOAT = `<a id="wa-share" class="bid-float" href="https://wa.me/?text=${encodeURIComponent(SHARE_TEXT)}"
   target="_blank" rel="noopener" aria-label="שתפו את האתר בוואטסאפ">
  <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.8-.9L3 20.5l1.6-4.9A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z"/></svg>
  <span>שתפו בוואטסאפ</span>
</a>
<a id="bid-buy" class="bid-float" href="/checkout">
  <svg width="20" height="18" viewBox="0 0 24 21" fill="#fff" aria-hidden="true"><path d="M12 20.4C12 20.4 1.2 13.3 1.2 7.1 1.2 3.7 3.9 1 7.1 1 9.2 1 11.1 2.1 12 3.8 12.9 2.1 14.8 1 16.9 1 20.1 1 22.8 3.7 22.8 7.1 22.8 13.3 12 20.4 12 20.4Z"/></svg>
  <span>אני רוצה לשחק!</span>
</a>
<style>
  .bid-float {
    position: fixed; z-index: 60;
    bottom: calc(var(--wa-lift, 0px) + clamp(16px, 3vw, 26px));
    display: inline-flex; align-items: center; justify-content: center; gap: 10px;
    min-height: 48px; padding: 0 22px; border-radius: 999px;
    color: #fff; text-decoration: none;
    font: 600 16px/1 Assistant, sans-serif; white-space: nowrap;
    box-shadow: 0 6px 20px rgba(31, 44, 74, .28);
    transition: background 260ms cubic-bezier(.2,.7,.2,1), bottom 260ms cubic-bezier(.2,.7,.2,1);
  }
  /* left and right, physically: the logical properties resolve the other way in RTL */
  #wa-share { left: clamp(14px, 4vw, 26px); background: #25D366; }
  #wa-share:hover { background: #1FB855; }
  #wa-share:focus-visible { outline: 3px solid #EF453D; outline-offset: 3px; }
  #bid-buy { right: clamp(14px, 4vw, 26px); background: ${RED}; }
  #bid-buy:hover { background: ${RED_DARK}; }
  #bid-buy:focus-visible { outline: 3px solid #4F6BA5; outline-offset: 3px; }
  /* Below 400px the pair is wider than the screen, so both shrink. */
  @media (max-width: 400px) {
    .bid-float { padding: 0 13px; gap: 7px; font-size: 13.5px; }
    .bid-float svg { width: 17px; height: 17px; }
  }
  @media (prefers-reduced-motion: reduce) { .bid-float { transition: none; } }
</style>
<script>
(function () {
  var floats = Array.prototype.slice.call(document.querySelectorAll('.bid-float'));
  if (!floats.length) return;
  function lift() {
    var vh = window.innerHeight, clear = 0;
    var nodes = document.body ? document.body.querySelectorAll('*') : [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (floats.some(function (f) { return f === el || f.contains(el); })) continue;
      var cs = getComputedStyle(el);
      if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') continue;
      // Decorative overlays are not obstructions. The fireworks canvas covers
      // the whole viewport, so without this the buttons would be lifted a full
      // screen height and fly off the top the moment the offer ends.
      if (cs.pointerEvents === 'none') continue;
      var r = el.getBoundingClientRect();
      // Anchored to the bottom edge, and actually covering something.
      if (r.height < 8 || r.width < 40) continue;
      if (r.bottom < vh - 4 || r.top > vh - 8) continue;
      clear = Math.max(clear, vh - r.top);
    }
    var v = clear ? clear + 10 + 'px' : '0px';
    floats.forEach(function (f) { f.style.setProperty('--wa-lift', v); });
  }
  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; lift(); });
  }
  schedule();
  addEventListener('resize', schedule);
  addEventListener('scroll', schedule, { passive: true });
  // The banner is rendered by the page runtime after boot, and removed when
  // the visitor answers it — both arrive as mutations.
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
})();
</script>`;

// The flip cards render in Chrome and collapse to nothing in Safari.
//
// Their wrapper holds only absolutely positioned images, so it has no content
// height; the height is meant to come from aspect-ratio: 250/370. But the grid
// sets align-items: stretch, which makes the item take the ROW's height, and
// the row — sized from content that is all out of flow — is zero. Chrome
// resolves the row from the aspect ratio anyway. Safari takes the stretch at
// its word and gives the card a height of 0, which is the empty white band
// Barak sees under "נסו אותי".
//
// align-self: start opts the card out of stretching, so its own aspect ratio
// decides its height and the row grows to fit. Applied to the card rather than
// to the grid, so it holds if the grid markup moves.
const CARD_HEIGHT_CSS = `<style>
  [style*="aspect-ratio:250/370"],
  [style*="aspect-ratio: 250 / 370"] { align-self: start; }
</style>`;

// The header CTA in red, the header centred on a phone, and the flip cards
// livelier on hover.
//
// The red is #D63229, not the brand coral #EF453D. White on the coral is
// 3.76:1, and the button's label is 15px/600 — under the size that would let
// 3:1 pass, so it fails AA. #D63229 is 4.83:1 and reads as the same red.
//
// The wiggle animates `rotate` and `scale`, not `transform`: the runtime emits
// `.scpN:hover { transform: translateY(-12px) !important }`, and !important
// outranks an animation, so keyframes on transform would run and change
// nothing. rotate and scale compose with transform instead of replacing it.
const POLISH_CSS = `<style>
  @media (max-width: 720px) {
    #bid-header, #bid-header > div { justify-content: center; }
    #bid-header > div { width: 100%; }
  }
  @keyframes bidCardWiggle {
    0%   { rotate: 0deg;    scale: 1; }
    15%  { rotate: -3.2deg; scale: 1.035; }
    32%  { rotate: 2.6deg;  scale: 1.045; }
    50%  { rotate: -1.8deg; scale: 1.04; }
    70%  { rotate: 1deg;    scale: 1.03; }
    85%  { rotate: -.4deg;  scale: 1.025; }
    100% { rotate: 0deg;    scale: 1.02; }
  }
  @media (hover: hover) and (prefers-reduced-motion: no-preference) {
    [style*="aspect-ratio:250/370"]:hover,
    [style*="aspect-ratio: 250 / 370"]:hover {
      animation: bidCardWiggle 640ms cubic-bezier(.2,.7,.2,1);
      animation-fill-mode: forwards;
    }
  }
</style>`;

// ── The long-form sales page ──────────────────────────────────────────────
// Everything below is built from facts the project already states: 60 cards,
// 6 categories, a hard box, about an hour, the first month after the
// engagement, 129₪ (was 169₪), 39₪ delivery in 1–5 business days, free pickup
// in Hod Hasharon and Givat Shmuel by phone, 14 days to cancel while sealed,
// and the four sample questions printed on the cards themselves.
//
// Nothing is invented. No reviews, ratings, testimonials or numbers that were
// not given — the design spec's voice section rules those out, and they would
// be false. The six category names are not written down anywhere in the
// project, so there is no section naming them.
const SEC = {
  wrap: (bg, inner, extra) =>
    `<section dir="rtl" style="background:${bg};${extra || ''}">
       <div style="max-width:1180px;margin:0 auto;padding:clamp(64px,10vw,120px) clamp(20px,5vw,32px)">${inner}</div>
     </section>`,
  // One coral mark per section, as the spec's accent budget allows.
  rule: (color) => `<div style="width:34px;height:1.5px;background:${color || '#EF453D'};margin:28px auto 0"></div>`,
  // The pill label from Barak's sales artifact — it tells the reader which
  // part of the argument they are standing in.
  eyebrow: (text, onBlue) =>
    `<p style="margin:0 0 18px;text-align:center"><span style="display:inline-block;font:600 13px/1 Assistant,sans-serif;letter-spacing:2px;color:${onBlue ? '#fff' : '#4F6BA5'};background:${onBlue ? 'rgba(255,255,255,.14)' : '#E7EDF8'};padding:9px 16px;border-radius:999px">${text}</span></p>`,
  quote: (text) =>
    `<p style="margin:clamp(30px,4vw,42px) auto 0;max-width:40ch;border-inline-start:4px solid #EF453D;background:#fff;border-radius:0 14px 14px 0;padding:20px 24px;font:600 clamp(18px,2.4vw,22px)/1.6 Heebo,sans-serif;color:#4F6BA5;text-align:right">${text}</p>`,
  h2: (text, color, align) =>
    `<h2 style="margin:0;font:700 clamp(28px,4.6vw,44px)/1.25 Heebo,sans-serif;color:${color};text-align:${align || 'center'};max-width:22ch;margin-inline:${align === 'right' ? '0' : 'auto'}">${text}</h2>`,
  p: (text, color, size) =>
    `<p style="margin:22px auto 0;max-width:46ch;font:300 clamp(17px,2.2vw,${size || 21}px)/1.8 Assistant,sans-serif;color:${color};text-align:center">${text}</p>`,
};

// The six categories, the audiences, the outcomes and the objections all come
// from Barak's own sales artifact — his words, not mine.
const CATEGORIES = [
  ['הבסיס', 'אולם או גן אירועים, חתונה קטנה או המונית, חורף או קיץ, תקציב מדויק או חתונה בלי פשרות.'],
  ['בחופה', 'נדרים אישיים, מי מברך, רק ההורים או כל המשפחה, ואיך זוכרים את מי שחסר.'],
  ['אחרי החופה ובאפטר', 'חיבוקים בחופה או ישר לרחבה, אוכל של המקום או חיצוני, ועד מתי נשארים.'],
  ['שאלות פתוחות', 'מה הדבר שהכי מלחיץ אותי ועוד לא סיפרתי לך? איזה רגע הייתי רוצה שכל האורחים יכירו?'],
  ['חס וחלילה', 'ספק מבריז, יורד גשם באוגוסט — מי מטפל, ואיך מחליטים כשאין זמן לחשוב.'],
  ['קלפים מיוחדים', 'החלפת תפקידים, וטו, ומה ההורים היו בוחרים — הקלפים שהופכים את הערב למשחק אמיתי.'],
];

const OUTCOMES = [
  ['מסיים ויכוחים לפני שהם מתחילים', 'כל נושא שעלול להתפוצץ בעוד חודשיים עולה הערב, בלי לחץ של דדליין וספק שמחכה לתשובה.'],
  ['הופך רצונות לבריף', 'בסוף הערב יש לכם רשימת החלטות מוסכמות שאפשר להעביר למפיק, לאולם או לצלם, במקום "נראה לנו משהו כזה".'],
  ['חוסך כסף', 'זוג שיודע מה חשוב לו לא משלם על שדרוגים שהוא לא צריך, ולא משנה הזמנות באמצע הדרך.'],
  ['מגדיר גבולות מול המשפחה', 'שאלות כמו מי מברך ומי מוזמן נסגרות בין שניכם, לפני שההורים מכריעים במקומכם.'],
  ['מחזיר את הרגש', 'בין כל הלוגיסטיקה יש קלפים שמזכירים למה בכלל התחלתם את זה.'],
];

const AUDIENCES = [
  ['זוגות שהתארסו ממש עכשיו', 'עוד לא סגרתם תאריך ואולם. זה הרגע המושלם, כי כל החלטה עוד פתוחה ואפשר לתכנן לפי מה שבאמת רוצים.'],
  ['זוגות שכבר בתוך התכנון', 'יש תאריך, יש ספקים, ויש כבר ויכוח אחד או שניים. המשחק מסדר את מה שנשאר פתוח לפני שזה מתפוצץ.'],
  ['מי שמחפש מתנת אירוסין', 'הורים, אחים וחברים: זו מתנה שנותנת לזוג ערב משלהם, במקום עוד פריט לרשימת המתנות.'],
  ['אנשי מקצוע בתחום', 'מפיקים, אולמות וצלמים: המשחק הוא מתנת פתיחה שמגיעה אליכם עם בריף מוכן מהלקוח.'],
];

const OBJECTIONS = [
  ['"אנחנו כבר דיברנו על הכול"', 'דיברתם על מקום, תאריך ותקציב. הנה שלוש שאלות שרוב הזוגות לא נגעו בהן: מי מברך מתחת לחופה, האם מזמינים את כל העבודה, ומה קורה אם ספק מבריז שבוע לפני. אם יש לכם תשובה מוסכמת לשלושתן, אתם באמת מסודרים.'],
  ['"אין לנו זמן לשחק משחקים"', 'שעה עכשיו חוסכת סדרה של שיחות טלפון, התלבטויות ושינויים בהמשך. זה לא זמן שיוצא מהתכנון, זה החלק הראשון שלו.'],
  ['"זה עוד גימיק לחתונות"', 'גימיק נזרק אחרי הערב. כאן התוצר הוא רשימת החלטות שתלווה אתכם בכל פגישה עם ספק, ואת הקלפים אפשר להעביר הלאה לזוג הבא שמתארס.'],
  ['"אנחנו זוג רגוע, אין לנו ויכוחים"', 'מצוין, אז זה יהיה ערב כיפי. ובכל זאת, רוב הוויכוחים בתכנון לא מתחילים מכעס אלא מהנחה שהשני חושב בדיוק כמוכם.'],
];

const STEPS = [
  ['01', 'פותחים את הקופסה', 'בלי הכנה, בלי לקרוא הוראות. מוציאים את החפיסה ומניחים אותה על השולחן.'],
  ['02', 'שולפים קלף', 'לא בוחרים. מה שיוצא, יוצא. חלק מהשאלות קלות, חלק פחות.'],
  ['03', 'מדברים', 'עונים שניכם, בלי למהר. אם נתקעתם על אחת — זו בדיוק השאלה ששווה לדבר עליה.'],
];

const BOX = [
  [String(OFFER.cards), 'כרטיסיות', 'שאלה אחת בכל אחת'],
  ['6', 'קטגוריות', 'מחולקות לפי נושא'],
  ['1', 'קופסה קשיחה', 'נשמרת, לא נקרעת'],
  ['60', 'דקות', 'זמן משחק ממוצע'],   // no tilde: it flips to the wrong side in RTL
];

const SAMPLES = [
  'מוזיקה חיה בחופה או פלייליסט',
  'דיג׳יי או להקה חיה',
  'הגשה לשולחן או בופה',
  'להביא את הכלב או להשאיר אותו בבית',
];

const FAQ = [
  ['כמה זמן זה לוקח?', 'כשעה. אפשר גם לעצור באמצע ולהמשיך בערב אחר — הקלפים לא בורחים.'],
  ['מתי הכי כדאי לשחק?', 'בחודש הראשון אחרי האירוסין, כשההתרגשות בשיאה ועוד לא סגרתם כלום. זה גם השלב שבו התשובות משפיעות הכי הרבה.'],
  ['איך מקבלים את הקופסה?', `משלוח עד הבית כלול במבצע ההשקה — ההזמנות המוקדמות יוצאות ב-${OFFER.shipDate}. או איסוף עצמי ללא עלות בהוד השרון או בגבעת שמואל, בתיאום טלפוני.`],
  ['ואם נגלה שאנחנו לא מסכימים?', 'אז גיליתם את זה עכשיו, בסלון, ולא בשיחה עם ספק בעוד חודשיים. זה בדיוק מה שהקלפים אמורים לעשות.'],
  ['אפשר לבטל?', 'כן. אפשר לבטל תוך 14 יום ולהחזיר, כל עוד המוצר באריזה המקורית. הפרטים המלאים בעמוד המשלוחים והביטולים.'],
  ['זה מתאים כמתנה?', 'זו אחת הדרכים הנפוצות לקנות את זה. הקופסה מגיעה סגורה ומוכנה למסירה.'],
];

const buyButton = (label, bg, color, border) =>
  `<a href="/checkout" style="display:inline-flex;align-items:center;justify-content:center;min-height:52px;padding:0 34px;border-radius:8px;background:${bg};color:${color};border:1.5px solid ${border || bg};font:600 17px/1 Assistant,sans-serif;text-decoration:none;white-space:nowrap">${label}</a>`;

// ── the launch countdown ──────────────────────────────────────────────────
// Counts to OFFER.endsISO, an absolute instant, so it reads the same from any
// timezone. Rendered server-side with the real numbers already in place, so
// the section is never blank and never flashes placeholders — the script only
// keeps it ticking.
//
// When it reaches zero: fireworks, the price swaps to the post-launch one
// everywhere it is tagged, and the checkout switches to the 189₪ payment link.
// Nobody has to be awake for it — it is a comparison against an absolute
// instant, made fresh every second, on every visitor's own device.
function countdownParts(fromMs) {
  const end = Date.parse(OFFER.endsISO);
  const left = Math.max(0, end - fromMs);
  const d = Math.floor(left / 86400000);
  return {
    expired: left === 0,
    d,
    h: Math.floor(left / 3600000) % 24,
    m: Math.floor(left / 60000) % 60,
    s: Math.floor(left / 1000) % 60,
  };
}

const COUNTDOWN = (() => {
  const p0 = countdownParts(Date.now());
  const cell = (v, label, key) => `
    <div style="min-width:clamp(62px,17vw,92px)">
      <p data-cd="${key}" style="margin:0;font:800 clamp(32px,8vw,52px)/1 Heebo,sans-serif;color:#fff;font-variant-numeric:tabular-nums">${String(v).padStart(2, '0')}</p>
      <p style="margin:6px 0 0;font:400 clamp(12px,3vw,14px)/1 Assistant,sans-serif;color:rgba(255,255,255,.72);letter-spacing:1px">${label}</p>
    </div>`;
  return `<section id="bid-countdown" dir="rtl" style="background:#3E568A">
    <div style="max-width:1180px;margin:0 auto;padding:clamp(52px,8vw,88px) clamp(20px,5vw,32px);text-align:center">
      <div data-cd-live>
        ${SEC.eyebrow('מבצע השקה', true)}
        <h2 style="margin:0 auto;max-width:20ch;font:700 clamp(26px,4.4vw,40px)/1.25 Heebo,sans-serif;color:#fff">המחיר הזה נגמר בעוד</h2>
        <div style="margin-top:clamp(26px,4vw,38px);display:flex;justify-content:center;gap:clamp(10px,3vw,26px);flex-wrap:wrap">
          ${cell(p0.d, 'ימים', 'd')}${cell(p0.h, 'שעות', 'h')}${cell(p0.m, 'דקות', 'm')}${cell(p0.s, 'שניות', 's')}
        </div>
        <p style="margin:clamp(24px,4vw,32px) auto 0;max-width:40ch;font:300 clamp(16px,2.2vw,19px)/1.75 Assistant,sans-serif;color:rgba(255,255,255,.9)">
          עד ${OFFER.endLabel}: ${OFFER.price} ₪ כולל משלוח עד הבית. אחרי זה ${OFFER.afterPrice} ₪, והמשלוח נגבה בנפרד.
        </p>
        <div style="margin-top:26px;display:flex;justify-content:center">
          <a href="/checkout" style="display:inline-flex;align-items:center;justify-content:center;min-height:52px;padding:0 34px;border-radius:8px;background:${RED};color:#fff;border:1.5px solid ${RED};font:600 17px/1 Assistant,sans-serif;text-decoration:none;white-space:nowrap">אני רוצה לשחק!</a>
        </div>
        <p style="margin:16px auto 0;font:300 15px/1.7 Assistant,sans-serif;color:rgba(255,255,255,.75)">ההזמנות המוקדמות יוצאות ב-${OFFER.shipDate}.</p>
      </div>

      <div data-cd-done style="display:none">
        ${SEC.eyebrow('מבצע ההשקה הסתיים', true)}
        <h2 style="margin:0 auto;max-width:22ch;font:700 clamp(26px,4.4vw,40px)/1.25 Heebo,sans-serif;color:#fff">תודה לכל מי שהצטרף להשקה.</h2>
        <p style="margin:20px auto 0;max-width:40ch;font:300 clamp(16px,2.2vw,19px)/1.75 Assistant,sans-serif;color:rgba(255,255,255,.9)">
          המחיר עכשיו ${OFFER.afterPrice} ₪, והמשלוח נגבה בנפרד.
        </p>
        <div style="margin-top:26px;display:flex;justify-content:center">
          <a href="/checkout" style="display:inline-flex;align-items:center;justify-content:center;min-height:52px;padding:0 34px;border-radius:8px;background:#fff;color:#4F6BA5;border:1.5px solid #fff;font:600 17px/1 Assistant,sans-serif;text-decoration:none;white-space:nowrap">אני רוצה לשחק!</a>
        </div>
      </div>
    </div>
  </section>`;
})();

const LONG_SECTIONS = [
  COUNTDOWN,

  // ── the problem, before anything is offered ────────────────────────────
  SEC.wrap('#DDE7F5', `
    ${SEC.eyebrow('הבעיה')}
    ${SEC.h2('רוב הזוגות לא רבים על החתונה. הם פשוט אף פעם לא דיברו עליה.', '#4F6BA5')}
    ${SEC.p('אתם מגיעים לפגישה ראשונה עם אולם, והשאלה הראשונה היא "כמה אורחים?". אתם עונים שני מספרים שונים. אחר כך מגיעה שאלת התקציב, ואז מי מוזמן מהעבודה, ואז מי בכלל מחליט.', '#2F3F63')}
    ${SEC.p('מכאן זה מתגלגל: כל החלטה הופכת למשא ומתן, ההורים נכנסים לתמונה, והזוג מגלה שהוא מתכנן חתונה שלמה בלי שאף פעם ישב לדבר על מה הוא באמת רוצה ממנה.', '#2F3F63')}
    ${SEC.quote('התכנון לא נכשל בגלל ספקים. הוא נכשל בגלל שיחה שלא קרתה בזמן.')}`),

  // ── the six categories ─────────────────────────────────────────────────
  SEC.wrap('#fff', `
    ${SEC.eyebrow('מה יש בחפיסה')}
    ${SEC.h2('שישה נושאים. אף אחד מהם לא נעים לגלות מול ספק.', '#4F6BA5')}
    ${SEC.rule()}
    <div style="margin-top:clamp(40px,6vw,60px);display:grid;grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr));gap:clamp(18px,3vw,26px)">
      ${CATEGORIES.map(([t, d], i) => `
        <div style="background:#F1F4F9;border-radius:14px;padding:clamp(24px,4vw,32px)">
          <p style="margin:0;font:700 13px/1 Assistant,sans-serif;letter-spacing:2px;color:rgba(79,107,165,.55)">0${i + 1}</p>
          <h3 style="margin:12px 0 0;font:700 clamp(20px,2.8vw,25px)/1.3 Heebo,sans-serif;color:#4F6BA5">${t}</h3>
          <p style="margin:12px 0 0;font:300 clamp(16px,2.1vw,18px)/1.75 Assistant,sans-serif;color:#2F3F63">${d}</p>
        </div>`).join('')}
    </div>`),

  // ── how it works ───────────────────────────────────────────────────────
  SEC.wrap('#4F6BA5', `
    ${SEC.eyebrow('איך משחקים', true)}
    ${SEC.h2('ערב אחד. בלי הכנות.', '#fff')}
    ${SEC.p('אין ניקוד, אין מנצח, ואף אחד לא צריך להתכונן.', 'rgba(255,255,255,.92)')}
    ${SEC.rule()}
    <div style="margin-top:clamp(40px,6vw,64px);display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:clamp(24px,4vw,40px)">
      ${STEPS.map(([n, t, b]) => `
        <div style="text-align:center">
          <p style="margin:0;font:700 clamp(34px,5vw,46px)/1 Heebo,sans-serif;color:rgba(255,255,255,.35)">${n}</p>
          <h3 style="margin:14px 0 0;font:700 clamp(19px,2.6vw,23px)/1.3 Heebo,sans-serif;color:#fff">${t}</h3>
          <p style="margin:12px auto 0;max-width:30ch;font:300 clamp(16px,2.1vw,18px)/1.8 Assistant,sans-serif;color:rgba(255,255,255,.9)">${b}</p>
        </div>`).join('')}
    </div>`),

  // ── what it actually does ──────────────────────────────────────────────
  SEC.wrap('#fff', `
    ${SEC.eyebrow('מה זה עושה בפועל')}
    ${SEC.h2('זה לא עוד משחק זוגי. זה כלי עבודה לתכנון.', '#4F6BA5')}
    ${SEC.rule()}
    <div style="margin-top:clamp(36px,5vw,54px);max-width:780px;margin-inline:auto;display:flex;flex-direction:column;gap:clamp(18px,3vw,26px)">
      ${OUTCOMES.map(([t, d]) => `
        <div style="display:flex;gap:16px;align-items:flex-start;text-align:right">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#EF453D" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none;margin-top:5px"><path d="M4 12.5l5.2 5.2L20 7"/></svg>
          <div>
            <h3 style="margin:0;font:700 clamp(18px,2.4vw,21px)/1.35 Heebo,sans-serif;color:#4F6BA5">${t}</h3>
            <p style="margin:7px 0 0;font:300 clamp(16px,2.1vw,18px)/1.75 Assistant,sans-serif;color:#2F3F63">${d}</p>
          </div>
        </div>`).join('')}
    </div>`),

  // ── what is in the box ─────────────────────────────────────────────────
  SEC.wrap('#DDE7F5', `
    ${SEC.h2('מה יש בפנים.', '#4F6BA5')}
    ${SEC.rule()}
    <div style="margin-top:clamp(40px,6vw,60px);display:grid;grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr));gap:clamp(18px,3vw,28px)">
      ${BOX.map(([n, t, s2]) => `
        <div style="background:#fff;border-radius:12px;padding:clamp(24px,4vw,34px) 18px;text-align:center">
          <p style="margin:0;font:800 clamp(30px,4.4vw,40px)/1 Heebo,sans-serif;color:#4F6BA5">${n}</p>
          <p style="margin:8px 0 0;font:700 clamp(16px,2.1vw,18px)/1.3 Heebo,sans-serif;color:#4F6BA5">${t}</p>
          <p style="margin:8px 0 0;font:300 15px/1.6 Assistant,sans-serif;color:#2F3F63">${s2}</p>
        </div>`).join('')}
    </div>`),

  // ── sample questions ───────────────────────────────────────────────────
  SEC.wrap('#4F6BA5', `
    ${SEC.eyebrow('טעימה', true)}
    ${SEC.h2(`ארבע מתוך ${OFFER.cards}.`, '#fff')}
    ${SEC.p('אלה שאלות אמיתיות מהחפיסה. תחשבו רגע מה הייתם עונים — ומה היה עונה מי שיושב מולכם.', 'rgba(255,255,255,.92)')}
    ${SEC.rule()}
    <div style="margin-top:clamp(40px,6vw,60px);display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:clamp(16px,2.6vw,24px)">
      ${SAMPLES.map((q, i) => `
        <div style="background:#fff;border-radius:14px;padding:clamp(28px,4vw,38px) 20px;min-height:180px;display:flex;align-items:center;justify-content:center;box-shadow:0 14px 30px rgba(31,44,74,.22);rotate:${[-2, 1.4, -1.2, 2][i]}deg">
          <p style="margin:0;font:400 clamp(18px,2.4vw,21px)/1.45 Heebo,sans-serif;color:#4F6BA5;text-align:center">${q}</p>
        </div>`).join('')}
    </div>`),

  // ── who it is for ──────────────────────────────────────────────────────
  SEC.wrap('#fff', `
    ${SEC.eyebrow('למי זה מתאים')}
    ${SEC.h2('אם אתם באחד המצבים האלה, המשחק הזה נכתב בשבילכם.', '#4F6BA5')}
    ${SEC.rule()}
    <div style="margin-top:clamp(40px,6vw,60px);display:grid;grid-template-columns:repeat(auto-fit,minmax(min(270px,100%),1fr));gap:clamp(18px,3vw,26px)">
      ${AUDIENCES.map(([t, d]) => `
        <div style="border:1.5px solid rgba(79,107,165,.25);border-radius:14px;padding:clamp(24px,4vw,32px)">
          <h3 style="margin:0;font:700 clamp(18px,2.4vw,21px)/1.35 Heebo,sans-serif;color:#4F6BA5">${t}</h3>
          <p style="margin:12px 0 0;font:300 clamp(16px,2.1vw,18px)/1.75 Assistant,sans-serif;color:#2F3F63">${d}</p>
        </div>`).join('')}
    </div>`),

  // ── when ───────────────────────────────────────────────────────────────
  SEC.wrap('#F1F4F9', `
    ${SEC.eyebrow('מתי')}
    ${SEC.h2('הזמן הנכון הוא עכשיו, לא אחר כך.', '#4F6BA5')}
    ${SEC.p('בחודש הראשון אחרי האירוסין עוד לא סגרתם אולם, לא בחרתם תפריט ולא הבטחתם לאף אחד כלום. זה השלב היחיד שבו התשובות שלכם עוד יכולות לשנות משהו.', '#2F3F63')}
    ${SEC.p('חודש אחרי זה, רוב ההחלטות כבר יתקבלו מול ספקים — ולא ביניכם.', '#2F3F63')}
    ${SEC.rule()}`),

  // ── objections ─────────────────────────────────────────────────────────
  SEC.wrap('#fff', `
    ${SEC.eyebrow('התנגדויות, בכנות')}
    ${SEC.h2('מה שאתם חושבים עכשיו, ולמה זה בכל זאת שווה.', '#4F6BA5')}
    ${SEC.rule()}
    <div style="margin-top:clamp(36px,5vw,54px);max-width:780px;margin-inline:auto;display:flex;flex-direction:column;gap:clamp(20px,3vw,28px)">
      ${OBJECTIONS.map(([q, a]) => `
        <div style="border-inline-start:3px solid rgba(79,107,165,.3);padding-inline-start:clamp(18px,3vw,24px);text-align:right">
          <h3 style="margin:0;font:700 clamp(18px,2.4vw,21px)/1.4 Heebo,sans-serif;color:#4F6BA5">${q}</h3>
          <p style="margin:10px 0 0;font:300 clamp(16px,2.1vw,18px)/1.8 Assistant,sans-serif;color:#2F3F63">${a}</p>
        </div>`).join('')}
    </div>`),

  // ── faq ────────────────────────────────────────────────────────────────
  SEC.wrap('#F1F4F9', `
    ${SEC.h2('שאלות שנשאלנו.', '#4F6BA5')}
    ${SEC.rule()}
    <div style="margin-top:clamp(36px,5vw,54px);max-width:760px;margin-inline:auto;display:flex;flex-direction:column;gap:2px">
      ${FAQ.map(([q, a]) => `
        <details class="bid-faq" style="background:#fff;border-radius:10px">
          <summary><span>${q}</span><i aria-hidden="true"></i></summary>
          <p>${a}</p>
        </details>`).join('')}
    </div>`),

  // ── the close ──────────────────────────────────────────────────────────
  SEC.wrap('#DDE7F5', `
    ${SEC.eyebrow('ניצוח')}
    ${SEC.h2('החתונה שלכם תיראה כמו ההחלטות שתקבלו בחודש הקרוב.', '#4F6BA5')}
    ${SEC.p('אפשר לקבל אותן תוך כדי תנועה: בין פגישה לפגישה, מול הצעת מחיר שפג תוקפה מחר, כשההורים על הקו והספק מחכה לתשובה. ככה מגיעים לחתונה יפה שהיא לא בדיוק שלכם.', '#2F3F63')}
    ${SEC.p('ואפשר לקבל אותן בערב אחד, על הספה, כששניכם רגועים ואף אחד לא מחכה על הקו. אותן החלטות בדיוק, רק שהפעם אתם אלה שבוחרים, ולא לוח הזמנים.', '#2F3F63')}
    ${SEC.quote('שעה אחת שקובעת איך ייראה כל שאר התהליך. ומי שעובר אותה מגיע לחופה ביחד, לא רק באותו יום.')}`),
].join('\n');

// ── the extra purchase point, just above the footer ───────────────────────
const PREFOOTER_CTA = `<section dir="rtl" style="background:#4F6BA5">
  <div style="max-width:1180px;margin:0 auto;padding:clamp(56px,9vw,104px) clamp(20px,5vw,32px);text-align:center">
    <h2 style="margin:0;font:700 clamp(28px,4.6vw,44px)/1.25 Heebo,sans-serif;color:#fff;max-width:20ch;margin-inline:auto">ערב אחד. ${OFFER.cards} שאלות. החתונה שלכם.</h2>
    <p style="margin:20px auto 0;max-width:42ch;font:300 clamp(17px,2.2vw,20px)/1.8 Assistant,sans-serif;color:rgba(255,255,255,.92)">קופסה קשיחה עם ${OFFER.cards} כרטיסיות, בשישה נושאים. משלוח עד הבית כלול במבצע ההשקה. יוצא ב-${OFFER.shipDate}.</p>
    <div style="margin-top:26px;display:flex;align-items:baseline;justify-content:center;gap:12px">
      <span data-bid-price style="font:800 clamp(34px,5vw,46px)/1 Heebo,sans-serif;color:#fff">${OFFER.price} ₪</span>
      <span data-bid-was style="font:400 clamp(18px,2.4vw,22px)/1 Heebo,sans-serif;color:rgba(255,255,255,.65);text-decoration:line-through">${OFFER.afterPrice} ₪</span>
    </div>
    <div style="margin-top:28px;display:flex;justify-content:center">
      ${buyButton('אני רוצה את המשחק', '#fff', '#4F6BA5')}
    </div>
    <p style="margin:18px auto 0;font:300 15px/1.7 Assistant,sans-serif;color:rgba(255,255,255,.8)">אפשר לבטל תוך 14 יום ולהחזיר, כל עוד המוצר באריזה המקורית.</p>
  </div>
</section>`;


// The footer stacks ten 44px rows on a phone, which is most of a screen for
// three lines of information. Laid out along the width instead, the same
// content fits in a few rows. The 44px touch target stays — it is the height
// that shrinks, not the tap area.
const FAQ_CSS = `<style>
  .bid-faq > summary {
    list-style: none; cursor: pointer;
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    min-height: 44px; padding: clamp(18px,3vw,24px) clamp(18px,3vw,28px);
    font: 700 clamp(17px,2.3vw,20px)/1.4 Heebo, sans-serif; color: #4F6BA5;
  }
  .bid-faq > summary::-webkit-details-marker { display: none; }
  .bid-faq > summary::marker { content: ""; }
  .bid-faq > summary:focus-visible { outline: 3px solid #EF453D; outline-offset: 3px; border-radius: 10px; }
  /* A plus that becomes a minus — the only coral in the section. */
  .bid-faq > summary > i {
    position: relative; flex: none; width: 18px; height: 18px;
    transition: rotate 260ms cubic-bezier(.2,.7,.2,1);
  }
  .bid-faq > summary > i::before, .bid-faq > summary > i::after {
    content: ""; position: absolute; inset: 0; margin: auto;
    background: #EF453D; border-radius: 2px;
  }
  .bid-faq > summary > i::before { width: 18px; height: 2px; }
  .bid-faq > summary > i::after  { width: 2px; height: 18px; transition: opacity 200ms; }
  .bid-faq[open] > summary > i { rotate: 180deg; }
  .bid-faq[open] > summary > i::after { opacity: 0; }
  .bid-faq > p {
    margin: 0; padding: 0 clamp(18px,3vw,28px) clamp(20px,3vw,26px);
    font: 300 clamp(16px,2.1vw,18px)/1.8 Assistant, sans-serif; color: #2F3F63;
  }
  @media (prefers-reduced-motion: reduce) { .bid-faq > summary > i { transition: none; } }
</style>`;

const FOOTER_CSS = `<style>
  @media (max-width: 720px) {
    #bid-footer > div { gap: 26px !important; text-align: center; }
    #bid-footer a[href="/"] { justify-content: center; }
    #bid-footer ul {
      flex-direction: row !important; flex-wrap: wrap;
      justify-content: center; gap: 0 22px !important;
    }
    #bid-footer h2 { margin-bottom: 4px !important; }
  }
</style>`;

// Keeps the countdown ticking, and handles the moment it runs out.
//
// Lives outside <x-dc> so the runtime never re-renders it. It writes only into
// the cells, so a re-render of the page around it costs at most one tick.
const COUNTDOWN_JS = `<script>
(function () {
  var END = Date.parse(${JSON.stringify(OFFER.endsISO)});
  var AFTER = ${OFFER.afterPrice};
  // Re-queried every tick on purpose: this script runs while the raw template
  // is still in the DOM, and the page runtime then replaces that whole subtree
  // with its own render. References taken once would point at detached nodes
  // and the clock would sit frozen on its server-rendered numbers.
  function q(sel) { return document.querySelector(sel); }
  var ended = false;

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  // Re-applied on every tick, not once. Everything below the ticker lives
  // inside <x-dc>, and the runtime re-renders that subtree from the raw
  // template — a one-shot expire() would be undone a moment later and the
  // page would go back to selling at the launch price. Each write is
  // idempotent and skipped when it would change nothing.
  function applyEnded() {
    var PRICE = AFTER + ' \u20AA';
    Array.prototype.forEach.call(document.querySelectorAll('[data-cd-live],[data-tk-live]'), function (el) {
      if (el.style.display !== 'none') el.style.display = 'none';
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-cd-done]'), function (el) {
      if (el.style.display === 'none') el.style.display = '';
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-tk-done]'), function (el) {
      if (el.style.display !== 'flex') el.style.display = 'flex';
    });
    // Every tagged price across the page stops being true at the same instant.
    Array.prototype.forEach.call(document.querySelectorAll('[data-bid-price]'), function (el) {
      if (el.textContent !== PRICE) el.textContent = PRICE;
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-bid-was]'), function (el) {
      if (el.style.display !== 'none') el.style.display = 'none';
    });
    // The buy buttons keep pointing at /checkout on purpose. That page swaps
    // to the 189₪ link by the same clock, and it is what collects the address
    // and sends Barak the order — jumping straight to Grow would lose both.
    document.documentElement.setAttribute('data-bid-offer', 'ended');
  }

  function expire() {
    applyEnded();
    if (ended) return;
    ended = true;   // the fireworks are the one thing that happens only once
    fireworks();
  }

  function tick() {
    var left = END - Date.now();
    // The interval is deliberately never cleared: expire() has to keep
    // re-asserting itself against the runtime's re-renders.
    if (left <= 0) { expire(); return; }
    var v = {
      d: Math.floor(left / 86400000),
      h: Math.floor(left / 3600000) % 24,
      m: Math.floor(left / 60000) % 60,
      s: Math.floor(left / 1000) % 60
    };
    // Every clock on the page: the ticker at the top and the section below.
    ['d','h','m','s'].forEach(function (k) {
      Array.prototype.forEach.call(document.querySelectorAll('[data-cd="' + k + '"]'), function (el) {
        el.textContent = pad(v[k]);
      });
    });
  }
  tick();
  setInterval(tick, 1000);

  function fireworks() {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var c = document.createElement('canvas');
    c.setAttribute('aria-hidden', 'true');
    c.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:70';
    document.body.appendChild(c);
    var ctx = c.getContext('2d');
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    function size() { c.width = innerWidth * dpr; c.height = innerHeight * dpr; ctx.setTransform(dpr,0,0,dpr,0,0); }
    size(); addEventListener('resize', size);

    var colors = ['#EF453D', '#FFFFFF', '#FFD34D', '#8FB3F5'];
    var parts = [], t0 = performance.now(), LAST = 5200, nextBurst = 0;

    function burst(x, y) {
      var col = colors[(Math.random() * colors.length) | 0];
      var n = 46 + ((Math.random() * 22) | 0);
      for (var i = 0; i < n; i++) {
        var a = (Math.PI * 2 * i) / n + Math.random() * 0.2;
        var sp = 1.7 + Math.random() * 3.6;
        parts.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, col: col });
      }
    }
    function frame(now) {
      var age = now - t0;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      if (age < LAST - 1200 && now > nextBurst) {
        burst(innerWidth * (0.15 + Math.random() * 0.7), innerHeight * (0.15 + Math.random() * 0.45));
        nextBurst = now + 280 + Math.random() * 380;
      }
      for (var i = parts.length - 1; i >= 0; i--) {
        var p = parts[i];
        p.x += p.vx; p.y += p.vy; p.vy += 0.045; p.vx *= 0.99; p.vy *= 0.99;
        p.life -= 0.012;
        if (p.life <= 0) { parts.splice(i, 1); continue; }
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.col;
        ctx.beginPath(); ctx.arc(p.x, p.y, 2.4, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (age < LAST || parts.length) requestAnimationFrame(frame);
      else c.remove();
    }
    requestAnimationFrame(frame);
  }
})();
<\/script>`;

// A thin ticker pinned to the top of every page.
//
// The full countdown section sits 3,284px down a 14,000px page — about four
// phone screens. A visitor has to go looking for it, which is the opposite of
// what a deadline is for. This one is visible before anything else.
//
// It lives outside <x-dc>, so the runtime never re-renders it, and the body is
// padded by the same height it occupies so nothing hides underneath.
const TICKER = `<div id="bid-ticker" dir="rtl" role="status">
  <span data-tk-live>
    <b>מבצע השקה</b>
    <span class="bid-tk-sep">·</span>
    <span>נגמר בעוד</span>
    <span class="bid-tk-nums">
      <span data-cd="d">--</span><i>י׳</i><span data-cd="h">--</span><i>ש׳</i><span data-cd="m">--</span><i>ד׳</i><span data-cd="s">--</span><i>שנ׳</i>
    </span>
    <a href="/checkout" class="bid-tk-cta">לרכישה</a>
  </span>
  <span data-tk-done style="display:none"><b>Before I Do</b><span class="bid-tk-sep">·</span><span>${OFFER.afterPrice} ₪ + משלוח</span><a href="/checkout" class="bid-tk-cta">לרכישה</a></span>
</div>
<style>
  #bid-ticker {
    position: fixed; inset-block-start: 0; inset-inline: 0; z-index: 55;
    display: flex; align-items: center; justify-content: center; gap: 10px;
    height: 46px; padding: 0 12px;
    background: ${RED}; color: #fff;
    font: 600 14px/1 Assistant, sans-serif; white-space: nowrap; overflow: hidden;
  }
  #bid-ticker b { font-weight: 700; }
  #bid-ticker .bid-tk-sep { opacity: .55; }
  #bid-ticker [data-tk-live], #bid-ticker [data-tk-done] { display: flex; align-items: center; gap: 10px; }
  .bid-tk-nums { display: inline-flex; align-items: baseline; gap: 2px; font-variant-numeric: tabular-nums; }
  .bid-tk-nums span { font-weight: 800; font-size: 15px; }
  .bid-tk-nums i { font-style: normal; opacity: .7; font-size: 11px; margin-inline-end: 5px; }
  .bid-tk-cta {
    display: inline-flex; align-items: center; height: 30px; padding: 0 12px;
    border-radius: 999px; background: #fff; color: ${RED};
    font: 700 13px/1 Assistant, sans-serif; text-decoration: none;
  }
  #bid-ticker a:focus-visible { outline: 3px solid #fff; outline-offset: 2px; }
  body { padding-block-start: 46px; }
  @media (max-width: 430px) {
    #bid-ticker { height: 42px; gap: 7px; font-size: 12.5px; }
    #bid-ticker .bid-tk-sep, #bid-ticker [data-tk-live] > span:not(.bid-tk-nums) { display: none; }
    .bid-tk-nums span { font-size: 14px; }
    .bid-tk-cta { height: 27px; padding: 0 10px; font-size: 12px; }
    body { padding-block-start: 42px; }
  }
</style>`;

// The checkout has no clock on it, but it holds the money: the payment link,
// the total, and the shipping line. All three have to turn over at the same
// instant the countdown does, on their own, on the visitor's device.
//
// window.bidEnded() is defined before the page runtime boots, because the
// render reads it. applyEnded() then keeps the static copy in step, re-applied
// every second for the same reason the countdown re-applies its own work: the
// runtime re-renders this subtree from the raw template and would otherwise
// put the launch wording straight back.
const CHECKOUT_SWITCH_JS = `<script>
(function () {
  var END = Date.parse(${JSON.stringify(OFFER.endsISO)});
  window.bidEnded = function () { return Date.now() >= END; };

  var PRICE = ${OFFER.afterPrice} + ' ₪';
  // Longest first: the short sentence is a substring of the long one, and
  // replacing it first leaves the long one half-rewritten.
  var COPY = [
    ['משלוח עד הבית כלול במבצע ההשקה. ההזמנות המוקדמות יוצאות ב-${OFFER.shipDate}. איסוף עצמי ללא עלות.',
     'משלוח עד הבית ${OFFER.shipping} ₪, אספקה תוך 1–5 ימי עסקים. איסוף עצמי ללא עלות.'],
    ['כלול במבצע ההשקה. ההזמנות המוקדמות יוצאות ב-${OFFER.shipDate}.',
     '${OFFER.shipping} ₪. אספקה תוך 1–5 ימי עסקים.']
  ];

  function applyEnded() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-bid-price]'), function (el) {
      if (el.textContent !== PRICE) el.textContent = PRICE;
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-bid-was]'), function (el) {
      if (el.style.display !== 'none') el.style.display = 'none';
    });
    var walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walk.nextNode())) {
      for (var i = 0; i < COPY.length; i++) {
        if (node.nodeValue.indexOf(COPY[i][0]) !== -1) {
          node.nodeValue = node.nodeValue.split(COPY[i][0]).join(COPY[i][1]);
        }
      }
    }
    document.documentElement.setAttribute('data-bid-offer', 'ended');
  }

  function check() { if (window.bidEnded()) applyEnded(); }
  if (document.body) check();
  addEventListener('DOMContentLoaded', check);
  setInterval(check, 1000);
})();
<\/script>`;

const report = [];
let built = 0;

for (const p of PAGES) {
  const file = findSource(p.src);
  if (!file) { report.push(['MISSING', p.out + '  (no source for ' + p.src + ')']); continue; }
  let s = fs.readFileSync(file, 'utf8');
  const fixes = [];
  const fix = (name, fn) => { const b = s; s = fn(s); fixes.push([s === b ? 'SKIPPED' : 'ok', name]); };

  fix('lang/dir', x => x.replace('<html>', '<html lang="he" dir="rtl">'));
  // The deck is 70 cards. The design was written for 60, in digits and in
  // words, and the number appears in both forms across the pages.
  fix('card count → 70', x => x
    .split('שישים כרטיסיות').join('שבעים כרטיסיות')
    .split('שישים שאלות').join('שבעים שאלות')
    .split('60 כרטיסיות').join('70 כרטיסיות')
    .split('60 קלפים').join('70 קלפים')
    .split('60 שאלות').join('70 שאלות')
    .split('50 כרטיסיות').join('70 כרטיסיות'));

  // The struck price is the post-launch one: 189₪, not the 169₪ the design
  // was drawn with. Tagged so the countdown can swap both when time is up.
  fix('struck price → 189', x => x
    .replace(/>129 ₪</g, ` data-bid-price>${OFFER.price} ₪<`)
    .replace(/>169 ₪</g, ` data-bid-was>${OFFER.afterPrice} ₪<`)
    // the policies document states it in a sentence rather than an element
    .replace('129 ₪ (מבצע, במקום 169 ₪), כולל מע״מ',
             `${OFFER.price} ₪ (מבצע השקה, במקום ${OFFER.afterPrice} ₪), כולל מע״מ`));

  // "מבצע" alone says nothing about why. This is a launch.
  fix('offer label → launch', x => x.replace(/>מבצע</g, '>מבצע השקה<'));



  // The head must land BEFORE the runtime script: the runtime reads
  // window.__resources as it boots, and a head appended at </head> would set
  // it too late, sending React to unpkg and leaving the page unrendered.
  fix('head + runtime path', x => x.replace(
    '<script src="./support.js"></script>',
    head(p) + '<script src="/assets/js/app.js"></script>'));

  // Google Fonts out, our subsets in (declared in the injected head).
  fix('local fonts', x => x
    .replace(/<link rel="preconnect" href="https:\/\/fonts\.g[^>]*>\s*/g, '')
    .replace(/<link href="https:\/\/fonts\.googleapis\.com\/css2[^>]*>\s*/g, ''));

  fix('spec: focus + touch targets', x => x.replace('</helmet>', SPEC_CSS + '\n</helmet>'));
  if (p.board) fix('board: narrow-screen readability', x => x.replace('</helmet>', BOARD_CSS + '\n</helmet>'));

  // Images.
  // Quote-agnostic: the boards reference images in single quotes too. Longest
  // path first, so a name that is a prefix of another cannot shadow it.
  let imgHits = 0;
  for (const from of Object.keys(imgPath).sort((a, b) => b.length - a.length)) {
    const before = s;
    s = s.split(from).join('/' + imgPath[from]);
    if (s !== before) imgHits++;
  }
  fixes.push([imgHits ? 'ok' : 'SKIPPED', `images (${imgHits} rewritten)`]);

  // Internal links: raw name, percent-encoded name, both with optional #frag.
  let linkHits = 0;
  for (const [name, url] of Object.entries(LINKS)) {
    for (const form of [name, encodeURIComponent(name).replace(/%2F/g, '/'), name.replace(/ /g, '%20')]) {
      const before = s;
      s = s.split(`href="${form}`).join(`href="${url === '/' ? '/' : url}\u0000`);
      if (s !== before) linkHits++;
    }
  }
  // A link was either bare (…dc.html") or carried a fragment (…dc.html#x").
  s = s.replace(/\u0000"/g, '"').replace(/\/\u0000#/g, '/#').replace(/\u0000#/g, '#');
  fixes.push([linkHits ? 'ok' : 'SKIPPED', `internal links (${linkHits} rewritten)`]);

  // Checkout only: route the pay button to the link matching the chosen
  // delivery method, and drop the "payment page connects here" placeholder.
  if (p.out === 'checkout.html') {
    // The deck is 60 cards. The checkout's order summary said 50 — the only
    // place in the project that disagreed, and the customer sees both.
    fix('card count: 50 → 60', x => x.replace('Before I Do — 50 כרטיסיות', 'Before I Do — 60 כרטיסיות'));

    // Delivery is included for the launch, so the total is 129₪ on both paths.
    // That is also what makes the single 129₪ Grow link correct: the 39₪ gap
    // that used to be charged short does not exist while the offer runs.
    //
    // Every one of these reads the clock rather than a build-time constant, so
    // the page stops selling the launch price by itself, at the right second.
    const total = who =>
      `window.bidEnded() ? ${OFFER.afterPrice} + (${who}.method === "ship" ? ${OFFER.shipping} : 0) : ${OFFER.price}`;
    fix('shipping included in the offer', x => x
      .replace('shipLabel: s.method === "ship" ? "39 ₪"',
               `shipLabel: s.method === "ship" ? (window.bidEnded() ? "${OFFER.shipping} ₪" : "כלול במבצע ההשקה")`)
      .replace('total: 129 + (s.method === "ship" ? 39 : 0)',
               `total: ${total('s')}`)
      .replace('total: 129 + (s2.method === "ship" ? 39 : 0)',
               `total: ${total('s2')}`)
      .replace('משלוח עד הבית', 'משלוח עד הבית')
      .replace('39 ₪. אספקה תוך 1–5 ימי עסקים.',
               `כלול במבצע ההשקה. ההזמנות המוקדמות יוצאות ב-${OFFER.shipDate}.`)
      .replace('משלוח 39 ₪, אספקה תוך 1–5 ימי עסקים. איסוף עצמי ללא עלות.',
               `משלוח עד הבית כלול במבצע ההשקה. ההזמנות המוקדמות יוצאות ב-${OFFER.shipDate}. איסוף עצמי ללא עלות.`));

    // Autofill. iOS offers to fill a checkout, but only for fields that say
    // what they hold — none of these carried type, name or autocomplete, so
    // Safari had nothing to map and the offer did nothing.
    //
    // No inputmode on the house number: Israeli addresses include ones like
    // "5ב", and a numeric keypad would lock those out.
    const AUTOFILL = [
      ['placeholder="ישראל ישראלי"',
       'placeholder="ישראל ישראלי" type="text" name="name" autocomplete="name" autocapitalize="words"'],
      ['placeholder="050-0000000"',
       'placeholder="050-0000000" type="tel" name="tel" autocomplete="tel" inputmode="tel"'],
      ['<select value="{{ city }}"',
       '<select name="city" autocomplete="address-level2" value="{{ city }}"'],
      ['placeholder="רחוב"',
       'placeholder="רחוב" type="text" name="address-line1" autocomplete="address-line1"'],
      // inputMode="numeric" opens a keypad with no letters on iOS, so an
      // address like "הרצל 5א" cannot be typed at all and the order cannot be
      // completed. One extra tap for everyone beats locking those addresses out.
      ['inputMode="numeric" placeholder="מספר"',
       'inputMode="text" placeholder="מספר" type="text" name="address-line2" autocomplete="address-line2"'],
      ['placeholder="הערות לשליח (לא חובה)"',
       'placeholder="הערות לשליח (לא חובה)" type="text" name="notes" autocomplete="off"'],
    ];
    for (const [from, to] of AUTOFILL) {
      fix(`autofill: ${from.slice(0, 34)}…`, x => x.replace(from, to));
    }

    // Barak's stated policy: 14 days, returnable in the original packaging.
    // One wording everywhere — a cancellation term that reads differently on
    // two pages of the same shop is a problem, not a nuance.
    fix('cancellation wording', x => x.replace(
      'אפשר לבטל תוך 14 יום, כל עוד הקופסה סגורה.',
      'אפשר לבטל תוך 14 יום ולהחזיר, כל עוד המוצר באריזה המקורית.'));

    // One link per era, not per delivery method: the launch link charges 129₪
    // however the box travels, and the post-launch one carries Grow's own
    // delivery selector. The swap needs no deploy — it is the same clock.
    fix('checkout: pay link', x => x.replace(
      'payUrl: this.props.payUrl ?? "#",',
      `payUrl: window.bidEnded() ? ${JSON.stringify(PAY.after)} : ${JSON.stringify(PAY.launch)},`));
    fix('checkout: offer switch', x => x.replace(
      '<script src="/assets/js/app.js"></script>',
      CHECKOUT_SWITCH_JS + '\n<script src="/assets/js/app.js"></script>'));
    fix('checkout: drop placeholder', x =>
      x.replace(/<p [^>]*>עמוד הסליקה יתחבר כאן\.<\/p>\s*/, ''));

    // Beacon the order to /api/order on the way out. sendBeacon is the right
    // call here: it survives the navigation to Grow, where a fetch would be
    // cancelled mid-flight, and it cannot delay the redirect.
    fix('checkout: notify on pay', x => x.replace(
      'onPay: e => { if (!this.state.consentTerms) e.preventDefault(); }',
      `onPay: e => {
        if (!this.state.consentTerms) { e.preventDefault(); return; }
        try {
          const s2 = this.state;
          const body = JSON.stringify({
            name: s2.name, phone: s2.phone, method: s2.method, point: s2.point,
            city: s2.city, street: s2.street, houseNo: s2.houseNo, notes: s2.notes,
            marketing: s2.consentMarketing,
            total: ${total('s2')}
          });
          navigator.sendBeacon("/api/order", new Blob([body], { type: "application/json" }));
        } catch (err) { /* a lost notification must never block the payment */ }
      }`));
    report.push(['note', `    checkout: ${OFFER.price} ₪ until ${OFFER.endLabel}, then ${OFFER.afterPrice} ₪ + ${OFFER.shipping} ₪ — switched by the clock, not by hand`]);
  }

  // Everywhere except the purchase flow — a share button beside a payment
  // form is a way out of it. The internal boards do not get one either; they
  // are working documents, not something a visitor shares.
  if (p.out === 'index.html') {
    fix('cards: height in Safari', x => x.replace('</helmet>', CARD_HEIGHT_CSS + '\n</helmet>'));
    fix('header centring + card wiggle', x => x.replace('</helmet>', POLISH_CSS + '\n</helmet>'));

    // The header bar needs a handle for the centring rule above.
    fix('header: id', x => x.replace(
      '<div style="max-width:1180px;margin:0 auto;padding:14px clamp(16px,5vw,32px);display:flex;align-items:center;justify-content:space-between;',
      '<div id="bid-header" style="max-width:1180px;margin:0 auto;padding:14px clamp(16px,5vw,32px);display:flex;align-items:center;justify-content:space-between;'));

    // The long-form page, and one more place to buy, before the footer.
    fix('long page: sections', x => x.replace('<footer', LONG_SECTIONS + '\n' + PREFOOTER_CTA + '\n<footer'));
    fix('faq: accordion styles', x => x.replace('</helmet>', FAQ_CSS + '\n</helmet>'));
    fix('footer: compact on phones', x => x
      .replace('<footer dir="rtl"', '<footer id="bid-footer" dir="rtl"')
      .replace('</helmet>', FOOTER_CSS + '\n</helmet>'));

    // Only the header's CTA turns red. The other two sit ON the blue, where
    // white-on-blue is the contrast that works and red would not.
    fix('header CTA: red', x => x.replace(
      'color:#fff;background:#4F6BA5;border:1.5px solid #4F6BA5;border-radius:8px;padding:0 22px;height:44px',
      `color:#fff;background:${RED};border:1.5px solid ${RED};border-radius:8px;padding:0 22px;height:44px`)
      .replace('style-hover="background:#3E568A">אני רוצה את המשחק</a>',
               `style-hover="background:${RED_DARK}">אני רוצה את המשחק</a>`));
  }

  if (p.out !== 'checkout.html' && !p.board) {
    fix('floating share + buy buttons', x => x.replace('</body>', SHARE_FLOAT + '\n</body>'));
    fix('sticky countdown ticker', x => x.replace('</body>', TICKER + '\n</body>'));
    fix('countdown script', x => x.replace('</body>', COUNTDOWN_JS + '\n</body>'));
  }

  // "יש החלטות שמקבלים מול ספקים" was wrapping to six lines even on a desktop.
  // Its block is capped at 34ch, and ch resolves against the WRAPPER's font
  // size (inherited, ~16px) rather than the 42px headline inside it — so the
  // cap lands around 270px and the headline is squeezed into a column. Give
  // the block a real width and let the headline run at display size.
  if (p.out === 'index.html') {
    fix('headline: give it room', x => x
      .replace('<div data-reveal="text" style="max-width:34ch">',
               '<div data-reveal="text" style="max-width:min(900px,100%)">')
      .replace('font:600 clamp(28px,4.4vw,42px)/1.3 Heebo,sans-serif;color:#4F6BA5;text-indent:0',
               'font:600 clamp(30px,5.4vw,58px)/1.25 Heebo,sans-serif;color:#4F6BA5;text-indent:0'));
  }

  // Barak asked for the licence number out of the footer.
  fix('footer: drop the licence number', x =>
    x.replace('ברק ליור, עוסק מורשה 207613829', 'ברק ליור'));

  // Home only: the English authoring notes render on the public page.
  if (p.out === 'index.html') {
    fix('hide design notes', x => x
      .replace(/showVoiceNotes: this\.props\.showVoiceNotes \?\? true,/, 'showVoiceNotes: this.props.showVoiceNotes ?? false,')
      .replace(/"showVoiceNotes":\{"editor":"boolean","default":true,/, '"showVoiceNotes":{"editor":"boolean","default":false,')
      .replace(/&quot;showVoiceNotes&quot;:\{&quot;editor&quot;:&quot;boolean&quot;,&quot;default&quot;:true,/,
               '&quot;showVoiceNotes&quot;:{&quot;editor&quot;:&quot;boolean&quot;,&quot;default&quot;:false,'));
  }

  // Spec §02: every size above 21px is written as a clamp so it shrinks on a
  // phone. Override font-size after the shorthand rather than inlining clamp()
  // into it — same result, nothing relying on how the font slot parses.
  let scaled = 0;
  s = s.replace(/font:(\d+) (\d+)px\/([\d.]+) ([^;"]+);/g, (m, w, px) => {
    const n = +px;
    if (n <= 21) return m;
    scaled++;
    return `${m}font-size:clamp(${Math.round(n * 0.65)}px, ${(n / 8.85).toFixed(2)}vw, ${n}px);`;
  });
  fixes.push([scaled ? 'ok' : 'SKIPPED', `spec: responsive type (${scaled})`]);

  // Spec §08: min() in the track keeps a two-column grid from overflowing at
  // 320px, where a bare 330px minimum is already wider than the viewport.
  let grids = 0;
  s = s.replace(/minmax\((\d+)px,\s*1fr\)/g, (m, px) => { grids++; return `minmax(min(${px}px,100%),1fr)`; });
  fixes.push([grids ? 'ok' : 'SKIPPED', `spec: grid min() (${grids})`]);

  // Spec §08: side gutters clamp(20px,5vw,32px).
  let gutters = 0;
  s = s.replace(/padding:([^;"]*?)\s32px(\s[^;"]*?)?(?=[;"])/g, (m, a, b) => {
    gutters++; return `padding:${a} clamp(20px,5vw,32px)${b || ''}`;
  });
  fixes.push([gutters ? 'ok' : 'SKIPPED', `spec: side gutters (${gutters})`]);

  fs.writeFileSync(path.join(ROOT, p.out), s);
  built++;
  report.push(['', `\n  ${p.out}`]);
  for (const [st, name] of fixes) report.push([st, '    ' + name]);
}

// ── robots + sitemap ──────────────────────────────────────────────────────
// The internal boards carry noindex, but state it here too so crawlers skip
// the fetch entirely rather than reading the page to learn they should not.
const publicPages = PAGES.filter(p => !p.noindex && p.canonical);
fs.writeFileSync(path.join(ROOT, 'robots.txt'),
  ['User-agent: *',
   ...PAGES.filter(p => p.noindex && p.out !== '404.html')
           .map(p => `Disallow: /${p.out.replace(/\.html$/, '')}`),
   '',
   `Sitemap: ${SITE}/sitemap.xml`, ''].join('\n'));

const today = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(ROOT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  publicPages.map(p =>
    `  <url><loc>${SITE}${p.canonical}</loc><lastmod>${today}</lastmod>` +
    `<priority>${p.canonical === '/' ? '1.0' : '0.5'}</priority></url>`).join('\n') +
  `\n</urlset>\n`);
console.log(`seo       robots.txt, sitemap.xml (${publicPages.length} public urls)`);

console.log(`pages     ${built} built\n`);
for (const [st, name] of report) console.log(st ? `  ${st.padEnd(8)}${name}` : name);

const bad = report.filter(r => r[0] === 'SKIPPED' || r[0] === 'MISSING');
if (bad.length) console.log(`\n${bad.length} item(s) need a look before deploying.`);
