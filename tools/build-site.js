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
  afterPrice: 169,
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
// This is the line Google prints under the link, so it has to be true and it
// has to earn the click. It said "חמישים כרטיסיות" — fifty — while every other
// surface said seventy, which is the number in the box.
const BLURB = `${TAGLINE}. ${OFFER.cards} כרטיסיות עם השאלות שכדאי לשאול לפני החתונה — ערב אחד, שיחה אמיתית, בלי שיפוטיות. משלוח עד הבית.`;

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
    title: `Before I Do ${TAGLINE}`, desc: BLURB, canonical: '/', og: true },
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

// What Google is told the page IS, rather than left to infer from the prose.
// Without it the homepage is just a page with Hebrew on it; with it, it is a
// product, at a price, in a currency, from a named seller, on pre-order until
// a stated date.
//
// Only what can be stood behind: no ratings and no reviews, because there are
// none yet, and inventing them is both against Google's rules and a lie told
// to a stranger deciding whether to trust the shop.
const STRUCTURED_DATA = JSON.stringify({
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': SITE + '/#org',
      name: 'Liver Production',
      alternateName: 'Before I Do',
      url: SITE,
      logo: SITE + '/assets/og-card.png',
      email: 'barakliver@gmail.com',
      telephone: '+972-52-660-4320',
      address: {
        '@type': 'PostalAddress',
        streetAddress: 'החומש 2',
        addressLocality: 'הוד השרון',
        addressCountry: 'IL',
      },
    },
    {
      '@type': 'WebSite',
      '@id': SITE + '/#website',
      url: SITE,
      name: 'Before I Do',
      inLanguage: 'he-IL',
      publisher: { '@id': SITE + '/#org' },
    },
    {
      '@type': 'Product',
      '@id': SITE + '/#product',
      name: 'Before I Do',
      description: BLURB,
      image: [SITE + '/assets/og-card.png'],
      brand: { '@type': 'Brand', name: 'Before I Do' },
      category: 'משחקי קופסה',
      inLanguage: 'he-IL',
      offers: {
        '@type': 'Offer',
        '@id': SITE + '/#offer',
        url: SITE + '/checkout',
        priceCurrency: 'ILS',
        price: String(OFFER.price),
        priceValidUntil: OFFER.endsISO.slice(0, 10),
        availability: 'https://schema.org/PreOrder',
        itemCondition: 'https://schema.org/NewCondition',
        seller: { '@id': SITE + '/#org' },
        hasMerchantReturnPolicy: {
          '@type': 'MerchantReturnPolicy',
          applicableCountry: 'IL',
          returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
          merchantReturnDays: 14,
          returnMethod: 'https://schema.org/ReturnByMail',
          returnFees: 'https://schema.org/ReturnShippingFees',
        },
      },
    },
  ],
}, null, 0);

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
    `<meta property="og:image:alt" content="Before I Do ${TAGLINE}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="Before I Do">`,
    `<meta name="twitter:description" content="${TAGLINE}">`,
    `<meta name="twitter:image" content="${abs('/assets/og-card.png')}">`,
    `<script type="application/ld+json">${STRUCTURED_DATA}<\/script>`);
  return lines.join('\n') + '\n';
}

// Every action answers a pointer the same way: a 2px lift and a shadow that
// deepens, 200ms, settling back on press. Enough to say "this is clickable"
// without any of them jumping.
//
// The runtime emits its own style-hover background swaps inline; transform and
// box-shadow compose with those rather than fighting them.
const BUTTON_CSS = `<style>
  a[href="/checkout"], a[href^="https://pay.grow.link"],
  .bid-tk-cta, #bid-where .bid-w-go a, button {
    transition: transform 200ms cubic-bezier(.22,.8,.3,1),
                box-shadow 200ms ease,
                background-color 200ms ease;
  }
  @media (hover: hover) {
    a[href="/checkout"]:hover, a[href^="https://pay.grow.link"]:hover,
    .bid-tk-cta:hover, button:not(:disabled):not([disabled]):hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(31, 44, 74, .18);
    }
  }
  a[href="/checkout"]:active, a[href^="https://pay.grow.link"]:active,
  .bid-tk-cta:active, button:not(:disabled):not([disabled]):active {
    transform: translateY(0);
    box-shadow: 0 2px 8px rgba(31, 44, 74, .14);
  }
  /* The checkout's legal links sit in a plain div rather than a <footer>, so
     the site-wide 44px rule never reached them. */
  a[href^="/privacy#"], a[href^="/terms#"] {
    min-height: 44px; display: inline-flex; align-items: center;
  }

  /* Standalone links that act as controls get a thumb-sized box. Inline
     links inside a paragraph are left alone — they are text, not buttons. */
  a[href="/"], a[href="/checkout"], .bid-tk-cta {
    min-height: 44px; display: inline-flex; align-items: center;
  }
  .bid-tk-cta { min-height: 0; }

  /* A disabled step button must not pretend it can be pressed. */
  button:disabled, button[disabled] { transform: none !important; box-shadow: none !important; }
  @media (prefers-reduced-motion: reduce) {
    a[href="/checkout"], a[href^="https://pay.grow.link"],
    .bid-tk-cta, #bid-where .bid-w-go a, button { transition: none; }
    a[href="/checkout"]:hover, a[href^="https://pay.grow.link"]:hover,
    .bid-tk-cta:hover, button:not(:disabled):hover { transform: none; }
  }
</style>`;

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
<style>
  .bid-float {
    position: fixed; z-index: 60;
    bottom: calc(var(--wa-lift, 0px) + clamp(16px, 3vw, 26px));
    display: inline-flex; align-items: center; justify-content: center; gap: 10px;
    min-height: 48px; padding: 0 22px; border-radius: 999px;
    color: #fff; text-decoration: none;
    font: 600 16px/1 Assistant, sans-serif; white-space: nowrap;
    box-shadow: 0 6px 20px rgba(31, 44, 74, .28);
    transition: background 260ms cubic-bezier(.2,.7,.2,1),
                bottom 260ms cubic-bezier(.2,.7,.2,1),
                transform 220ms cubic-bezier(.2,.7,.2,1),
                box-shadow 220ms cubic-bezier(.2,.7,.2,1);
  }
  /* left, physically: the logical properties resolve the other way in RTL */
  #wa-share { left: clamp(14px, 4vw, 26px); background: #25D366; }
  /* The hover keeps the same green and the same white. Barak wants one
     colouring for the button in every state, so the answer to a pointer is
     the lift and the icon, not a different shade. */
  #wa-share:hover, #wa-share:focus-visible, #wa-share:active { background: #25D366; }
  /* The page carries a bare a:hover colour rule, coral, which outranks the
     .bid-float colour and turned the label coral — on a phone too, because
     iOS applies :hover on tap and leaves it applied. The id wins in every
     state. */
  #wa-share, #wa-share:link, #wa-share:visited,
  #wa-share:hover, #wa-share:focus, #wa-share:active { color: #fff; }
  /* Green button, so a red ring reads as an error rather than as focus.
     !important because the site-wide focus rule is itself !important and
     would otherwise paint this one coral the moment it is tabbed to. */
  #wa-share:focus-visible { outline: 3px solid #1F2C4A !important; outline-offset: 3px !important; }

  /* A slow breath, so the eye catches it once without the page nagging.
     Shadow and scale only — nothing that moves the button out from under a
     finger already on its way to it. */
  @keyframes bid-wa-breathe {
    0%, 88%, 100% { transform: scale(1);     box-shadow: 0 6px 20px rgba(31,44,74,.28), 0 0 0 0 rgba(37,211,102,.45); }
    92%           { transform: scale(1.045); box-shadow: 0 8px 24px rgba(31,44,74,.32), 0 0 0 10px rgba(37,211,102,0); }
    96%           { transform: scale(1);     box-shadow: 0 6px 20px rgba(31,44,74,.28), 0 0 0 16px rgba(37,211,102,0); }
  }
  #wa-share { animation: bid-wa-breathe 6s ease-in-out 3s infinite; }

  /* Pointer nearby or on it: the breathing stops and it simply leans in. */
  #wa-share:hover, #wa-share:focus-visible {
    animation: none;
    transform: translateY(-3px) scale(1.04);
    box-shadow: 0 12px 28px rgba(31, 44, 74, .34);
  }
  #wa-share svg { transition: transform 220ms cubic-bezier(.2,.7,.2,1); }
  #wa-share:hover svg { transform: rotate(-9deg) scale(1.1); }
  #wa-share:active { transform: translateY(-1px) scale(.99); }

  /* Below 400px it shrinks rather than crowding the screen. */
  @media (max-width: 400px) {
    .bid-float { padding: 0 15px; gap: 8px; font-size: 14px; }
    .bid-float svg { width: 18px; height: 18px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .bid-float { transition: none; }
    #wa-share, #wa-share:hover, #wa-share:focus-visible { animation: none; transform: none; }
    #wa-share svg, #wa-share:hover svg { transition: none; transform: none; }
  }
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
      // the whole viewport, so without this the button would be lifted a full
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
// The card hover animates `rotate`, `scale` and `filter`, not `transform`:
// the runtime emits `.scpN:hover { transform: translateY(-12px) !important }`,
// and !important outranks an animation, so keyframes on transform would run
// and change nothing. These compose with it rather than replacing it.
//
// It used to be a wiggle — a shake back and forth, which reads as an error
// state, not as an invitation. A card you are about to pick up rises, leans a
// little and catches more light. One motion, one direction, no oscillation.
const POLISH_CSS = `<style>
  @media (max-width: 720px) {
    #bid-header, #bid-header > div { justify-content: center; }
    #bid-header > div { width: 100%; }
  }
  @media (hover: hover) and (prefers-reduced-motion: no-preference) {
    [style*="aspect-ratio:250/370"],
    [style*="aspect-ratio: 250 / 370"] {
      position: relative;
      transition: rotate 460ms cubic-bezier(.22,.85,.26,1),
                  scale 460ms cubic-bezier(.22,.85,.26,1),
                  filter 460ms ease;
    }
    [style*="aspect-ratio:250/370"]:hover,
    [style*="aspect-ratio: 250 / 370"]:hover {
      rotate: -3deg;
      scale: 1.045;
      filter: brightness(1.07) saturate(1.04);
    }
    /* The hint belongs under the card the visitor is actually reaching for,
       the way the design shows it — not as a sentence standing above all three. */
    [style*="aspect-ratio:250/370"]::after,
    [style*="aspect-ratio: 250 / 370"]::after {
      content: "לחצו להפוך";
      position: absolute; inset-inline: 0; top: calc(100% + 16px);
      text-align: center; pointer-events: none;
      font: 400 13px/1 Assistant, sans-serif; color: rgba(47,63,99,.5);
      opacity: 0; translate: 0 -5px;
      transition: opacity 280ms ease, translate 280ms cubic-bezier(.2,.7,.2,1);
    }
    [style*="aspect-ratio:250/370"]:hover::after,
    [style*="aspect-ratio: 250 / 370"]:hover::after { opacity: 1; translate: 0 0; }
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
       <div style="max-width:1180px;margin:0 auto;padding:clamp(40px,6vw,72px) clamp(20px,5vw,32px)">${inner}</div>
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
// Kept after its section came off the page, like SAMPLES and AUDIENCES:
// Barak's copy, one paste away from returning.
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
  ['01', 'פותחים את הקופסה', 'בלי לקרוא הוראות, מוציאים את החפיסה אל השולחן.'],
  ['02', 'שולפים קלף', 'מה שיוצא, יוצא.'],
  ['03', 'מתחברים', 'עונים שניכם. נתקעתם? אלו בדיוק הרגעים ששווה להתעכב עליהם.'],
];

const BOX = [
  [String(OFFER.cards), 'כרטיסיות', 'שאלה אחת בכל אחת'],
  ['6', 'קטגוריות', 'מחולקות לפי נושא'],
  ['1', 'קופסה קשיחה', 'נשמרת, לא נקרעת'],
  ['60', 'דקות', 'זמן משחק ממוצע'],   // no tilde: it flips to the wrong side in RTL
];

// SAMPLES and AUDIENCES are Barak's own copy, kept after their sections came
// off the page: bringing either back is a paste, not a rewrite.
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
  // A quiet clock: light digits, hairline separators, no boxes and no badge.
  // The urgency is in the number, and a number does not need decoration to
  // be read as one.
  const cell = (v, label, key) => `
    <div style="min-width:clamp(52px,15vw,78px)">
      <p data-cd="${key}" style="margin:0;font:300 clamp(36px,10vw,58px)/1 Heebo,sans-serif;color:#fff;font-variant-numeric:tabular-nums;letter-spacing:-1px">${String(v).padStart(2, '0')}</p>
      <p style="margin:10px 0 0;font:400 clamp(11.5px,2.8vw,12.5px)/1 Assistant,sans-serif;color:rgba(255,255,255,.55);letter-spacing:2px">${label}</p>
    </div>`;
  const gap = `<div aria-hidden="true" style="align-self:start;margin-top:clamp(4px,1.2vw,8px);font:300 clamp(28px,8vw,44px)/1 Heebo,sans-serif;color:rgba(255,255,255,.22)">:</div>`;
  const rule = `<div aria-hidden="true" style="width:min(340px,70%);height:1px;margin:clamp(28px,5vw,40px) auto 0;background:rgba(255,255,255,.16)"></div>`;
  return `<section id="bid-countdown" dir="rtl" style="background:#3E568A">
    <div style="max-width:1180px;margin:0 auto;padding:clamp(44px,6.5vw,72px) clamp(20px,5vw,32px);text-align:center">
      <div data-cd-live>
        <div style="display:flex;justify-content:center;align-items:flex-start;gap:clamp(6px,2vw,16px)">
          ${cell(p0.d, 'ימים', 'd')}${gap}${cell(p0.h, 'שעות', 'h')}${gap}${cell(p0.m, 'דקות', 'm')}${gap}${cell(p0.s, 'שניות', 's')}
        </div>
        <p style="margin:clamp(22px,3.4vw,30px) auto 0;font:300 clamp(15px,2vw,17px)/1.7 Assistant,sans-serif;color:rgba(255,255,255,.85)">כולל משלוח חינם עד הבית</p>
        <div style="margin-top:clamp(20px,3vw,26px);display:flex;justify-content:center">
          <a href="/checkout" style="display:inline-flex;align-items:center;justify-content:center;min-height:52px;padding:0 36px;border-radius:8px;background:${RED};color:#fff;border:1.5px solid ${RED};font:600 17px/1 Assistant,sans-serif;text-decoration:none;white-space:nowrap">להזמנה</a>
        </div>
        <p style="margin:16px auto 0;font:300 14px/1.7 Assistant,sans-serif;color:rgba(255,255,255,.5)">ההזמנות המוקדמות יוצאות ב-${OFFER.shipDate}.</p>
      </div>

      <div data-cd-done style="display:none">
        <p style="margin:0;font:400 clamp(12px,2.8vw,13px)/1 Assistant,sans-serif;color:rgba(255,255,255,.55);letter-spacing:3px">מבצע ההשקה הסתיים</p>
        <h2 style="margin:clamp(20px,3vw,28px) auto 0;max-width:22ch;font:600 clamp(26px,4.4vw,40px)/1.25 Heebo,sans-serif;color:#fff">תודה לכל מי שהצטרף להשקה.</h2>
        ${rule}
        <p style="margin:clamp(26px,4vw,34px) auto 0;max-width:36ch;font:300 clamp(15px,2vw,17px)/1.8 Assistant,sans-serif;color:rgba(255,255,255,.82)">
          המחיר עכשיו ${OFFER.afterPrice} ₪, והמשלוח נגבה בנפרד.
        </p>
        <div style="margin-top:clamp(26px,4vw,32px);display:flex;justify-content:center">
          <a href="/checkout" style="display:inline-flex;align-items:center;justify-content:center;min-height:52px;padding:0 36px;border-radius:8px;background:#fff;color:#4F6BA5;border:1.5px solid #fff;font:600 17px/1 Assistant,sans-serif;text-decoration:none;white-space:nowrap">להזמנה</a>
        </div>
      </div>
    </div>
  </section>`;
})();

// ── "איפה אתם בתוך כל הסיפור הזה?" ────────────────────────────────────────
//
// An editorial composition rather than a feature grid. The four states are
// the material; the layout is the design.
//
// What carries it:
//   · One focal point — the headline, at display size, held on the right
//     where an RTL reader starts, with a coral hairline as its only mark.
//   · Scale tension — 84px numerals against 16px copy, and nothing between.
//   · Controlled asymmetry — 01 sits beside the headline, 02 drops 120px
//     below it, 03 tucks under the headline and 04 runs wide across the
//     lower band. The 12-column grid underneath stays disciplined.
//   · Four different treatments of one system: 01 bare on the page, 02 under
//     a hairline, 03 beside one, 04 on a tinted surface. No rounded boxes
//     repeated four times.
//   · One motif, once: the brand heart, drawn as a line, oversized and
//     cropped by the section edge. Not a pile of cards.
//
// Coral appears exactly twice: the rule under the headline, and the 04
// numeral that pulls the eye down into the cards.
const WHERE_STATES = [
  ['01', 'הרגע התארסנו', 'עוד לא פתחתם אקסל.<br>תיהנו מהרגע.'],
  ['02', 'עמוק בתכנונים', 'תקציב, אורחים, ספקים.<br>כן, אנחנו מכירים.'],
  ['03', 'מחפשים מתנה', 'מתנה בנאלית?<br>לא במשמרת שלכם.'],
  ['04', 'משפחה', 'אתם מכירים אותם מספיק טוב<br>כדי להביא משהו עם קצת יותר מחשבה.'],
];

const WHERE_SECTION = (() => {
  const state = ([n, title, copy]) => `
    <div class="bid-w-state" data-n="${n}" tabindex="0">
      <p class="bid-w-num">${n}</p>
      <div>
        <h3 class="bid-w-title">${title}</h3>
        <p class="bid-w-copy">${copy}</p>
      </div>
    </div>`;
  const [s1, s2, s3, s4] = WHERE_STATES.map(state);
  return `<section id="bid-where" dir="rtl" aria-labelledby="bid-where-h">
  <svg class="bid-w-heart" viewBox="0 0 24 21" fill="none" stroke="#4F6BA5" stroke-width=".5" aria-hidden="true"><path d="M12 20.4C12 20.4 1.2 13.3 1.2 7.1 1.2 3.7 3.9 1 7.1 1 9.2 1 11.1 2.1 12 3.8 12.9 2.1 14.8 1 16.9 1 20.1 1 22.8 3.7 22.8 7.1 22.8 13.3 12 20.4 12 20.4Z"/></svg>
  <div class="bid-w-grid">
    <div class="bid-w-lead">
      <h2 id="bid-where-h">איפה אתם בתוך<br>כל הסיפור הזה?</h2>
      <i class="bid-w-mark" aria-hidden="true"></i>
    </div>
    <div class="bid-w-list">${s1}${s2}${s3}${s4}</div>
    <div class="bid-w-go"><a href="#bid-try">יאללה, תראו לנו קלף<span aria-hidden="true">←</span></a></div>
  </div>
</section>`;
})();

const BOX_SECTION_CSS = `<style>
  #bid-box {
    background: #F1F4F9;
    padding: clamp(44px,6vw,76px) clamp(20px,5vw,32px);
  }
  .bid-box-wrap { max-width: 1180px; margin: 0 auto; text-align: center; }
  #bid-box h2 {
    margin: 0; font: 700 clamp(28px,4.4vw,44px)/1.25 Heebo, sans-serif;
    color: #4F6BA5;
  }
  .bid-box-rule {
    display: block; width: 34px; height: 1.5px; background: #EF453D;
    margin: clamp(22px,3vw,28px) auto 0;
  }

  .bid-box-grid {
    /* Capped, or the two halves fly to opposite ends of a 1180px row and
       leave a hole between them. */
    max-width: 820px; margin: clamp(30px,4.4vw,46px) auto 0;
    display: grid; grid-template-columns: 1fr auto;
    gap: clamp(24px,3.4vw,44px); align-items: center;
    text-align: start;
  }
  .bid-box-copy { min-width: 0; }
  .bid-box-count {
    margin: 0 0 clamp(18px,2.6vw,24px);
    display: flex; align-items: baseline; gap: 10px;
    font: 300 clamp(20px,2.4vw,25px)/1 Heebo, sans-serif; color: #4F6BA5;
  }
  /* the count set at display size inside its own sentence */
  .bid-box-count b {
    font: 800 clamp(44px,6vw,72px)/1 Heebo, sans-serif; letter-spacing: -2px;
  }
  .bid-box-line {
    margin: 0 0 clamp(11px,1.5vw,15px);
    font: 300 clamp(17px,2.2vw,22px)/1.6 Assistant, sans-serif; color: #2F3F63;
  }
  /* each line steps in from the reading edge, so the eye falls toward the
     card the third one introduces */
  .bid-box-line[data-step="2"] { margin-inline-start: clamp(16px,2.4vw,30px); }
  .bid-box-line[data-step="3"] { margin-inline-start: clamp(32px,4.8vw,60px); color: #4F6BA5; }

  /* ── the line someone says out loud, set as the product's own card ── */
  .bid-box-card {
    /* The page does not set a global border-box, so without this the padding
       is added to the width and the card comes out 40px wider than asked. */
    box-sizing: border-box;
    justify-self: center; outline: none;
    /* The floor matters more than the ceiling: between roughly 1020 and
       1070px the width has already bottomed out while the quote font is
       still near its own maximum, and the second line used to break in
       two. 244px leaves the line 8px of room at that worst point. */
    width: clamp(244px,21vw,258px); min-height: clamp(330px,29vw,352px);
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: clamp(20px,2.6vw,28px);
    padding: clamp(26px,3.4vw,34px) clamp(20px,2.6vw,26px);
    background: #fff; border-radius: 14px;
    box-shadow: 0 18px 38px rgba(31, 44, 74, .16);
    rotate: -2.5deg;
    transition: rotate 240ms cubic-bezier(.22,.8,.3,1),
                translate 240ms cubic-bezier(.22,.8,.3,1),
                box-shadow 240ms ease;
    position: relative;
  }
  /* the hairline frame the printed cards carry */
  .bid-box-card::before {
    content: ""; position: absolute; inset: 10px;
    border: 1px solid rgba(79,107,165,.28); border-radius: 8px; pointer-events: none;
  }
  .bid-box-heart { width: 22px; height: auto; flex: none; }
  .bid-box-quote {
    margin: 0; font: 600 clamp(17px,1.85vw,19px)/1.55 Heebo, sans-serif;
    color: #4F6BA5; text-align: center;
  }
  .bid-box-sig {
    display: flex; align-items: center; gap: 10px; width: 100%;
    color: rgba(79,107,165,.55);
  }
  .bid-box-sig i { flex: 1; height: 1px; background: rgba(79,107,165,.3); }
  .bid-box-sig span { font: 500 15px/1 Caveat, cursive; white-space: nowrap; }

  @media (hover: hover) {
    .bid-box-card:hover { rotate: 0deg; translate: 0 -5px; box-shadow: 0 24px 46px rgba(31,44,74,.2); }
  }
  .bid-box-card:focus-visible { rotate: 0deg; translate: 0 -5px; }

  .bid-box-close { margin-block-start: clamp(30px,4vw,46px); }
  .bid-box-close p {
    margin: 0 0 6px;
    font: 300 clamp(16px,1.9vw,19px)/1.75 Assistant, sans-serif; color: rgba(47,63,99,.8);
  }
  .bid-box-close p:last-child { margin: 0; color: #4F6BA5; font-weight: 400; }

  @media (max-width: 820px) {
    .bid-box-grid { grid-template-columns: 1fr; gap: clamp(28px,6vw,38px); }
    .bid-box-copy { text-align: center; }
    /* a flex row ignores text-align, so the count needs its own centring */
    .bid-box-count { justify-content: center; }
    .bid-box-line[data-step="2"], .bid-box-line[data-step="3"] { padding-inline-start: 0; }
    /* a card's proportions, not a square: 236 × 318 is close to the real one */
    .bid-box-card { width: 250px; min-height: 336px; gap: 18px; padding: 24px 20px; }
    .bid-box-quote { font-size: 18px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .bid-box-card { transition: none; }
    .bid-box-card:hover, .bid-box-card:focus-visible { rotate: -2.5deg; translate: none; }
  }
</style>`;

const WHERE_CSS = `<style>
  #bid-where {
    position: relative; overflow: hidden; background: #fff;
    padding: clamp(54px,7.5vw,96px) clamp(20px,5vw,32px);
  }
  .bid-w-grid {
    position: relative; z-index: 1;
    max-width: 1180px; margin: 0 auto;
    display: grid; grid-template-columns: repeat(12, 1fr);
    /* A third row takes the slack. Without it the list, which spans the
       column, hands its extra height to the rows above and pushes the one
       link half a screen away from the headline it belongs to. */
    grid-template-rows: auto auto 1fr;
    column-gap: clamp(24px,4vw,72px); align-items: start;
  }

  /* The one motif: the brand heart as a line, large, and cut by the section
     edge so it reads as a watermark rather than as an illustration. */
  .bid-w-heart {
    position: absolute; inset-inline-start: -8%; inset-block-end: -34%;
    width: clamp(300px,30vw,420px); height: auto; opacity: .075; pointer-events: none;
  }

  /* ── right: the focal point, the weighted state, the one way on ──── */
  .bid-w-lead { grid-column: 1 / 6; grid-row: 1; }
  .bid-w-lead h2 {
    margin: 0;
    font: 700 clamp(33px,5vw,64px)/1.05 Heebo, sans-serif;
    letter-spacing: -1px; color: #4F6BA5;
  }
  .bid-w-mark {
    display: block; width: 52px; height: 2px; background: #EF453D;
    margin-block: clamp(22px,3vw,30px) clamp(30px,4.5vw,52px);
  }

  /* ── four equal stops on one measured line ──────────────────────────
     None of the four is louder than the others. The interest is structural:
     a hairline runs the height of the list, each state sits on it behind its
     own tick, and the numerals straddle it like marks on a rule. A scale,
     not four cards with one shouting. */
  .bid-w-list { position: relative; }
  .bid-w-list::before {
    content: ""; position: absolute; inset-block: 0;
    inset-inline-start: calc(clamp(44px,4.6vw,62px) + clamp(14px,1.8vw,20px));
    width: 1px; background: rgba(79,107,165,.22);
  }
  /* the single coral moment on the line: its first measure */
  .bid-w-list::after {
    content: ""; position: absolute; inset-block-start: 0;
    inset-inline-start: calc(clamp(44px,4.6vw,62px) + clamp(14px,1.8vw,20px));
    width: 1px; height: clamp(26px,3vw,36px); background: #EF453D;
  }

  .bid-w-state {
    position: relative; min-width: 0; outline: none;
    display: grid;
    grid-template-columns: clamp(44px,4.6vw,62px) clamp(28px,3.6vw,46px) 1fr;
    align-items: start;
    padding-block: clamp(20px,2.8vw,30px);
    transition: transform 220ms cubic-bezier(.22,.8,.3,1);
  }
  .bid-w-state:first-child { padding-block-start: 0; }
  .bid-w-state:last-child { padding-block-end: 0; }
  /* the tick that joins each state to the line */
  .bid-w-state::before {
    content: ""; position: absolute;
    inset-inline-start: calc(clamp(44px,4.6vw,62px) + clamp(14px,1.8vw,20px));
    inset-block-start: calc(clamp(20px,2.8vw,30px) + .62em);
    width: clamp(14px,1.8vw,20px); height: 1px; background: rgba(79,107,165,.34);
    transition: width 220ms cubic-bezier(.22,.8,.3,1), background-color 220ms ease;
  }
  .bid-w-state:first-child::before { inset-block-start: .62em; }

  .bid-w-num {
    margin: 0; grid-column: 1;
    font: 800 clamp(30px,3.4vw,44px)/.85 Heebo, sans-serif;
    color: rgba(79,107,165,.22); letter-spacing: -1px;
    font-variant-numeric: tabular-nums;
    transition: color 220ms ease;
  }
  .bid-w-state > div { grid-column: 3; }
  .bid-w-title { margin: 0; font: 700 clamp(18px,2vw,22px)/1.3 Heebo, sans-serif; color: #2F3F63; }
  .bid-w-copy {
    margin: 8px 0 0; font: 300 clamp(15px,1.6vw,16.5px)/1.7 Assistant, sans-serif;
    color: rgba(47,63,99,.72);
  }

  .bid-w-list { grid-column: 7 / 13; grid-row: 1 / 4; margin-block-start: clamp(6px,1.4vw,18px); }

  /* ── one continuation, not four ──────────────────────────────────── */
  .bid-w-go { grid-column: 1 / 6; grid-row: 2; margin-block-start: clamp(26px,3.4vw,38px); }
  .bid-w-go a {
    display: inline-flex; align-items: center; gap: 10px; min-height: 44px;
    font: 600 clamp(16px,1.9vw,18px)/1 Assistant, sans-serif;
    color: #EF453D; text-decoration: none;
    border-block-end: 1.5px solid rgba(239,69,61,.3); padding-block-end: 6px;
    transition: border-color 200ms ease;
  }
  .bid-w-go a span { transition: transform 200ms cubic-bezier(.22,.8,.3,1); }
  .bid-w-go a:hover { border-block-end-color: #EF453D; }
  .bid-w-go a:hover span { transform: translateX(-5px); }

  /* ── restraint: a lift and the tick reaching out, the same for each ── */
  @media (hover: hover) {
    .bid-w-state:hover { transform: translateY(-4px); }
    .bid-w-state:hover .bid-w-num { color: rgba(79,107,165,.46); }
    .bid-w-state:hover::before { width: clamp(24px,3vw,34px); background: #EF453D; }
  }
  .bid-w-state:focus-visible { transform: translateY(-4px); }
  .bid-w-state:focus-visible .bid-w-num { color: rgba(79,107,165,.46); }
  .bid-w-state:focus-visible::before { width: clamp(24px,3vw,34px); background: #EF453D; }

  /* ── phones: the same line, drawn tighter ───────────────────────── */
  @media (max-width: 900px) {
    .bid-w-heart { inset-inline-start: -26%; inset-block-end: -6%; width: 240px; opacity: .07; }
    .bid-w-grid { display: block; }
    .bid-w-lead h2 { letter-spacing: -.5px; }
    .bid-w-mark { margin-block: 20px 30px; }
    .bid-w-list { margin-block-start: 0; }
    .bid-w-list::before, .bid-w-list::after,
    .bid-w-state::before { inset-inline-start: calc(38px + 13px); }
    .bid-w-state { grid-template-columns: 38px 26px 1fr; padding-block: 22px; }
    .bid-w-num { font-size: 28px; }
    .bid-w-state::before { width: 13px; inset-block-start: calc(22px + .62em); }
    .bid-w-state:hover::before, .bid-w-state:focus-visible::before { width: 13px; }
    .bid-w-go { margin-block-start: 30px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .bid-w-state, .bid-w-num, .bid-w-go a, .bid-w-go a span { transition: none; }
    .bid-w-state:hover, .bid-w-state:focus-visible { transform: none; }
  }

  /* The ticker is fixed at the top, so an anchor jump must clear it. */
  #bid-try { scroll-margin-top: 64px; }
</style>`;

// ── מאחורי הקלעים: Barak ─────────────────────────────────────────────────
//
// Barak's own words, as he wrote them; his two starred phrases carry the only
// emphasis. Warm neutral rather than the house blue, because he asked for less
// blue this high up the page — and paper stock is the right register for a
// man talking about a physical box he made.
//
// The portrait is not here yet. The slot is built, and PORTRAIT_JS removes
// the figure while the file is missing, so the section reads as one clean
// column today and becomes two the moment assets/img/barak.webp lands.
const BARAK_SECTION = `<section id="bid-barak" dir="rtl" aria-labelledby="bid-barak-h">
  <div class="bid-b-grid">
    <figure class="bid-b-photo">
      <img src="/assets/img/barak.webp" alt="ברק ליור, מפיק חתונות" loading="lazy" decoding="async">
      <span class="bid-b-slot" aria-hidden="true">
        <svg viewBox="0 0 24 21" fill="none" stroke="#4F6BA5" stroke-width=".5"><path d="M12 20.4C12 20.4 1.2 13.3 1.2 7.1 1.2 3.7 3.9 1 7.1 1 9.2 1 11.1 2.1 12 3.8 12.9 2.1 14.8 1 16.9 1 20.1 1 22.8 3.7 22.8 7.1 22.8 13.3 12 20.4 12 20.4Z"/></svg>
      </span>
    </figure>
    <div class="bid-b-text">
      <p class="bid-b-eyebrow">מאחורי הקלעים</p>
      <h2 id="bid-barak-h">משחק החתונות היחיד<br>שנוצר על ידי מפיק חתונות.</h2>
      <i class="bid-b-mark" aria-hidden="true"></i>
      <p>יש את הרגע הזה אחרי ההצעה. האדרנלין קצת יורד, ופתאום קולטים שצריך להרים עכשיו חתיכת אירוע. פתאום במקום רומנטיקה, אתם מוצאים את עצמכם <strong>טובעים באקסלים, במשימות ובלחץ</strong>.</p>
      <p>אהלן, אני ברק. מפיק חתונות ומאסטר NLP. ביומיום שלי אני מתעסק בלעשות סדר בבלאגן, גם של פרויקטים וגם של אנשים, ולגרום לדברים לעבוד חלק.</p>
      <p>‏'Before I Do' נולד כדי שלא תיזרקו למים העמוקים לגמרי לבד. הבאתי לתוך הקופסה הזו את הידע מעשרות חתונות וזוגות יחד עם כלים מה-NLP, נטו כדי לתת לכם תמיכה מרחוק.</p>
      <p>הרעיון פשוט: אתם מנהלים את התכנון בעצמכם, אבל יש לכם עוגן. משהו ששומר עליכם מפוקסים ודואג שתתקשרו נכון גם כשנהיה לחוץ.</p>
      <p>ואל תדאגו, אם חששתם שזה עוד משחק זוגיות קיטשי ודביק. זה הכי לא. דרך לתאם ציפיות, לשחרר עומס ולהפוך את <em>הדרך לחופה לחוויה שאשכרה נהנים ממנה</em>.</p>
      
    </div>
  </div>
</section>`;

const BARAK_CSS = `<style>
  #bid-barak {
    background: #F7F6F3;
    padding: clamp(52px,7vw,92px) clamp(20px,5vw,32px);
  }
  .bid-b-grid {
    max-width: 1180px; margin: 0 auto;
    display: grid; grid-template-columns: minmax(0,7fr) minmax(0,5fr);
    column-gap: clamp(32px,5vw,76px); align-items: start;
  }
  /* The text sits on the reading edge, the portrait opposite it — and both
     are pinned to row 1. The figure comes first in the DOM, so without the
     row the text auto-placed onto a second row and the two stacked. */
  .bid-b-text { grid-column: 1; grid-row: 1; }
  .bid-b-photo { grid-column: 2; grid-row: 1; margin: 0; position: relative; }
  .bid-b-photo img {
    display: block; width: 100%; height: auto; aspect-ratio: 4 / 5;
    object-fit: cover; border-radius: 10px;
  }
  /* The frame is held open until the portrait arrives: an empty surface with
     the brand mark in it, so the space reads as reserved rather than broken.
     The image replaces it with no other change. */
  .bid-b-slot { display: none; }
  #bid-barak[data-no-photo] .bid-b-photo img { display: none; }
  #bid-barak[data-no-photo] .bid-b-slot {
    display: flex; align-items: center; justify-content: center;
    width: 100%; aspect-ratio: 4 / 5; border-radius: 10px;
    background: rgba(79,107,165,.05); border: 1px solid rgba(79,107,165,.16);
  }
  .bid-b-slot svg { width: 26%; height: auto; opacity: .3; }

  .bid-b-eyebrow {
    margin: 0 0 14px; font: 400 12.5px/1 Assistant, sans-serif;
    letter-spacing: 3px; color: rgba(47,63,99,.5);
  }
  #bid-barak h2 {
    margin: 0; font: 700 clamp(25px,3.4vw,40px)/1.2 Heebo, sans-serif;
    color: #2F3F63; letter-spacing: -.5px;
  }
  .bid-b-mark {
    display: block; width: 44px; height: 2px; background: #EF453D;
    margin-block: clamp(20px,2.6vw,26px) clamp(24px,3vw,32px);
  }
  .bid-b-text p:not(.bid-b-eyebrow):not(.bid-b-sign) {
    margin: 0 0 clamp(15px,1.8vw,19px); max-width: 58ch;
    font: 300 clamp(16px,1.8vw,18px)/1.85 Assistant, sans-serif; color: rgba(47,63,99,.88);
  }
  /* Both emphases are bold in the brand blue. Coral is not used for
     running text in this section. */
  .bid-b-text strong,
  .bid-b-text em { font-style: normal; font-weight: 700; color: #4F6BA5; }
  .bid-b-sign {
    margin: clamp(22px,3vw,30px) 0 0;
    display: flex; align-items: center; gap: 10px;
    font: 600 clamp(15px,1.7vw,16.5px)/1.5 Assistant, sans-serif; color: #2F3F63;
  }
  .bid-b-sign span { color: rgba(47,63,99,.35); }

  /* one column, and the portrait first — a face before a wall of text */
  @media (max-width: 860px) {
    .bid-b-grid { display: flex; flex-direction: column; }
    .bid-b-photo { width: min(320px,72%); margin-block-end: clamp(26px,5vw,34px); }
    .bid-b-photo img { aspect-ratio: 1 / 1; }
    .bid-b-text p:not(.bid-b-eyebrow):not(.bid-b-sign) { max-width: none; }
  }
</style>`;

// The portrait has not been supplied yet. Rather than ship a broken image or a
// "photo goes here" box on a shop that is taking orders, the figure removes
// itself while the file is missing — and the layout is already there for it.
const PORTRAIT_JS = `<script>
(function () {
  function check() {
    var sec = document.getElementById('bid-barak');
    if (!sec) return;
    var img = sec.querySelector('.bid-b-photo img');
    function reserve() { sec.setAttribute('data-no-photo', ''); }
    function fill() { sec.removeAttribute('data-no-photo'); }
    if (!img) return reserve();
    if (img.complete) return img.naturalWidth ? fill() : reserve();
    img.addEventListener('error', reserve);
    img.addEventListener('load', fill);
  }
  check();
  // The runtime re-renders this subtree, which puts the figure back.
  setInterval(check, 700);
})();
<\/script>`;

const LONG_SECTIONS = [
  COUNTDOWN,

  // ── the problem, before anything is offered ────────────────────────────
  SEC.wrap('#DDE7F5', `
    ${SEC.eyebrow('הבעיה')}
    ${SEC.h2('רוב הזוגות לא רבים על החתונה. הם פשוט אף פעם לא דיברו עליה.', '#4F6BA5')}
    ${SEC.p('אתם מגיעים לפגישה ראשונה עם אולם, והשאלה הראשונה היא "כמה אורחים?". אתם עונים שני מספרים שונים. אחר כך מגיעה שאלת התקציב, ואז מי מוזמן מהעבודה, ואז מי בכלל מחליט.', '#2F3F63')}
    ${SEC.p('מכאן זה מתגלגל: כל החלטה הופכת למשא ומתן, ההורים נכנסים לתמונה, והזוג מגלה שהוא מתכנן חתונה שלמה בלי שאף פעם ישב לדבר על מה הוא באמת רוצה ממנה.', '#2F3F63')}
    ${SEC.quote('התכנון לא נכשל בגלל ספקים. הוא נכשל בגלל שיחה שלא קרתה בזמן.')}`),

  // ── what is waiting in the box ─────────────────────────────────────────
  //
  // Short, rhythmic copy that builds to a line someone says out loud — so the
  // line is set as a card. The product's own front: white stock, a hairline
  // frame, the small red heart at the top and the script signature between
  // two rules at the foot. The card language used once, as the thing the
  // paragraph is actually about, rather than a pile of them for decoration.
  //
  // The three "חלקם" lines step inward as they go, so the eye falls toward
  // the card the third one introduces.
  `<section id="bid-box" dir="rtl">
    <div class="bid-box-wrap">
      <h2>מה מחכה בקופסה?</h2>
      <i class="bid-box-rule" aria-hidden="true"></i>
      <div class="bid-box-grid">
        <div class="bid-box-copy">
          <p class="bid-box-count"><b>${OFFER.cards}</b> קלפים.</p>
          <p class="bid-box-line" data-step="1">חלקם ירגישו לכם מוכרים.</p>
          <p class="bid-box-line" data-step="2">חלקם יפתיעו אתכם.</p>
          <p class="bid-box-line" data-step="3">וחלקם יגרמו לכם לעצור רגע ולהגיד:</p>
        </div>
        <div class="bid-box-card" tabindex="0">
          <svg class="bid-box-heart" viewBox="0 0 24 21" fill="#EF453D" aria-hidden="true"><path d="M12 20.4C12 20.4 1.2 13.3 1.2 7.1 1.2 3.7 3.9 1 7.1 1 9.2 1 11.1 2.1 12 3.8 12.9 2.1 14.8 1 16.9 1 20.1 1 22.8 3.7 22.8 7.1 22.8 13.3 12 20.4 12 20.4Z"/></svg>
          <p class="bid-box-quote">״רגע,<br>על זה בכלל לא דיברנו.״</p>
          <div class="bid-box-sig" aria-hidden="true"><i></i><span>Before I Do</span><i></i></div>
        </div>
      </div>
      <div class="bid-box-close">
        <p>לא צריך לדעת מראש מה הולך לעלות.</p>
        <p>בשביל זה פותחים קלף.</p>
        <p>ונותנים לשיחה לזרום.</p>
      </div>
    </div>
  </section>`,

  // ── how it works ───────────────────────────────────────────────────────
  SEC.wrap('#4F6BA5', `
    ${SEC.h2('איך משחקים?', '#fff')}
    ${SEC.p('פותחים בקבוק יין באווירה כיפית', 'rgba(255,255,255,.92)')}
    ${SEC.rule()}
    <div style="margin-top:clamp(40px,6vw,64px);display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:clamp(24px,4vw,40px)">
      ${STEPS.map(([n, t, b]) => `
        <div style="text-align:center">
          <p style="margin:0;font:700 clamp(34px,5vw,46px)/1 Heebo,sans-serif;color:rgba(255,255,255,.35)">${n}</p>
          <h3 style="margin:14px 0 0;font:700 clamp(19px,2.6vw,23px)/1.3 Heebo,sans-serif;color:#fff">${t}</h3>
          <p style="margin:12px auto 0;max-width:30ch;font:300 clamp(16px,2.1vw,18px)/1.8 Assistant,sans-serif;color:rgba(255,255,255,.9)">${b}</p>
        </div>`).join('')}
    </div>
    <div style="margin-top:clamp(36px,5vw,52px);display:flex;justify-content:center">
      ${buyButton('להזמנה', '#fff', '#4F6BA5')}
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
    // The structured data tells Google the price and that the box is on
    // pre-order. Both stop being true at the same instant as everything else.
    var ld = document.querySelector('script[type="application/ld+json"]');
    // schema.org/PreOrder, not "PreOrder": the value is a URL, so the quote
    // that looks like it belongs in front of the word is nowhere near it.
    if (ld && ld.textContent.indexOf('schema.org/PreOrder') !== -1) {
      try {
        var data = JSON.parse(ld.textContent);
        (data['@graph'] || []).forEach(function (node) {
          if (node['@type'] !== 'Product' || !node.offers) return;
          node.offers.price = String(AFTER);
          node.offers.availability = 'https://schema.org/InStock';
          delete node.offers.priceValidUntil;
        });
        ld.textContent = JSON.stringify(data);
      } catch (e) { /* malformed is worse than stale */ }
    }
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
    <span class="bid-tk-lead"><span class="bid-tk-long">מבצע השקה </span>נגמר בעוד</span>
    <span class="bid-tk-nums">
      <span data-cd="d">--</span><i>:</i><span data-cd="h">--</span><i>:</i><span data-cd="m">--</span><i>:</i><span data-cd="s">--</span>
    </span>
    <a href="/checkout" class="bid-tk-cta">להזמנה</a>
  </span>
  <span data-tk-done style="display:none"><span class="bid-tk-lead">Before I Do</span><span class="bid-tk-nums">${OFFER.afterPrice} ₪</span><a href="/checkout" class="bid-tk-cta">להזמנה</a></span>
</div>
<style>
  /* A hairline of urgency, not a banner. Flat, one weight, no borders. */
  #bid-ticker {
    position: fixed; inset-block-start: 0; inset-inline: 0; z-index: 55;
    display: flex; align-items: center; justify-content: center; gap: 14px;
    height: 44px; padding: 0 14px;
    background: ${RED}; color: #fff;
    font: 400 13.5px/1 Assistant, sans-serif; white-space: nowrap; overflow: hidden;
  }
  #bid-ticker [data-tk-live], #bid-ticker [data-tk-done] { display: flex; align-items: center; gap: 14px; }
  .bid-tk-lead { color: rgba(255,255,255,.82); letter-spacing: .3px; }
  .bid-tk-nums {
    display: inline-flex; align-items: baseline; gap: 1px;
    font: 500 15px/1 Heebo, sans-serif; font-variant-numeric: tabular-nums; letter-spacing: .5px;
    /* A colon clock is read left to right, days first, the way every digital
       clock is. Left in the page's RTL flow it comes out back to front. */
    direction: ltr; unicode-bidi: isolate;
  }
  .bid-tk-nums i { font-style: normal; color: rgba(255,255,255,.45); padding: 0 1px; }
  .bid-tk-cta {
    position: relative;
    display: inline-flex; align-items: center; height: 28px; padding: 0 14px;
    border-radius: 999px; background: rgba(255,255,255,.14);
    color: #fff; font: 500 12.5px/1 Assistant, sans-serif; text-decoration: none;
    transition: background 180ms ease;
  }
  .bid-tk-cta:hover { background: rgba(255,255,255,.24); }
  /* The bar is 44px tall and the pill is 28px. The tap area fills the bar
     without the pill growing — a thumb should not have to aim. */
  .bid-tk-cta::after { content: ""; position: absolute; inset: -9px -8px; }
  #bid-ticker a:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  body { padding-block-start: 44px; }
  @media (max-width: 430px) {
    #bid-ticker { height: 40px; gap: 10px; }
    /* Room for "נגמר בעוד" but not for the whole sentence — and without some
       words a bare 35:08:45:27 says nothing. */
    .bid-tk-long { display: none; }
    .bid-tk-nums { font-size: 14.5px; }
    .bid-tk-cta { height: 26px; padding: 0 12px; font-size: 12px; }
    body { padding-block-start: 40px; }
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

  // The fields live in a form so iOS will fill them, and a form submits on
  // Enter. There is nothing to submit to \u2014 the steps are handled in the
  // page \u2014 so a submit would reload and throw the order away. Captured at
  // the document, so it survives every re-render of the form itself.
  document.addEventListener('submit', function (e) { e.preventDefault(); }, true);
})();
<\/script>`;

// Everyone who reached the checkout, not only everyone who paid.
//
// Barak asked to keep whatever can be kept about the people who fill the form
// and leave at the last moment. This watches the component's own state, and on
// the way out sends what the visitor already typed, plus where they got to and
// where they came from.
//
// Two deliberate limits. It stays quiet unless a name or a phone was actually
// entered — an empty form is not a lead, and an open endpoint should not be fed
// noise. And it never fires after the pay button, because that path already
// sends the real order.
const CHECKOUT_LEADS_JS = `<script>
(function () {
  var sent = false, maxStep = 1, t0 = Date.now();
  var q = new URLSearchParams(location.search);

  // window.__bidCheckout is refreshed on every render of the checkout, so at
  // unload it already holds exactly what the visitor last typed.
  function snap() {
    var c = window.__bidCheckout;
    if (!c) return null;
    if (c.step > maxStep) maxStep = c.step;
    return c.s;
  }
  setInterval(snap, 500);

  function device() {
    var w = innerWidth;
    return (w <= 480 ? 'טלפון' : w <= 1024 ? 'טאבלט' : 'מחשב') + ' ' + w + 'px';
  }
  function utm() {
    return ['source', 'medium', 'campaign', 'content', 'term']
      .map(function (k) { var v = q.get('utm_' + k); return v ? k + '=' + v : ''; })
      .filter(Boolean).join(' ');
  }

  function send() {
    if (sent || window.__bidPaid) return;
    var s = snap();
    if (!s) return;
    var named = String(s.name || '').trim().length > 1;
    var dialled = String(s.phone || '').replace(/\\D/g, '').length >= 7;
    if (!named && !dialled) return;
    var seconds = Math.round((Date.now() - t0) / 1000);
    if (seconds < 5) return;
    sent = true;
    try {
      var body = JSON.stringify({
        stage: 'abandoned',
        name: s.name, phone: s.phone, method: s.method, point: s.point,
        city: s.city, street: s.street, houseNo: s.houseNo, notes: s.notes,
        marketing: s.consentMarketing, consentTerms: s.consentTerms,
        total: window.bidEnded() ? ${OFFER.afterPrice} + (s.method === "ship" ? ${OFFER.shipping} : 0) : ${OFFER.price},
        step: maxStep, seconds: seconds, device: device(), utm: utm(),
        source: document.referrer || ''
      });
      navigator.sendBeacon("/api/order", new Blob([body], { type: "application/json" }));
    } catch (err) { /* a lost lead must never be visible to the customer */ }
  }

  // Both, on purpose: pagehide is the reliable one on a desktop navigation,
  // and iOS can background and kill a tab without ever firing it.
  addEventListener('pagehide', send);
  addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') send();
  });
})();
<\/script>`;

// The two legal pages shipped as the design's own placeholder — "כאן נכנס
// גוף הטקסט", "גוף הסעיף", "פריט רשימה" — on a live shop that takes money
// and now also keeps details from people who did not finish paying.
//
// Written against what this shop actually does: the two prices and the date
// they change, the two pickup points, the real list of processors, and the
// accessibility work that is genuinely in the code. Where something has not
// been done — no formal accessibility audit — it says so rather than claiming
// a standard nobody verified.
//
// Drafted from the Israeli consumer and privacy statutes, not reviewed by a
// lawyer. The anchors (#terms, #returns, #privacy, #cookies, #accessibility)
// are load-bearing: the footer and the cookie banner link straight into them.
const TERMS_BODY = `<p style="font-weight:600;color:#4F6BA5">המסמך הזה כתוב בלשון זכר מטעמי נוחות בלבד ומתייחס לכל המגדרים. הוא חל על כל הזמנה שמתבצעת באתר beforeido.co.il.</p>

<h2 id="terms">תקנון ותנאי שימוש</h2>

<h3>1. מי אנחנו</h3>
<p>האתר beforeido.co.il מופעל על ידי <strong>ברק ליור (Liver Production)</strong>, עוסק מורשה 207613829, מרחוב החומש 2, הוד השרון.</p>
<ul>
<li>טלפון / וואטסאפ: <a href="tel:0526604320">052-6604320</a></li>
<li>דוא״ל: <a href="mailto:barakliver@gmail.com">barakliver@gmail.com</a></li>
<li>שעות מענה: ימים א׳–ה׳, 09:00–18:00</li>
</ul>

<h3>2. המוצר</h3>
<p>Before I Do הוא משחק קלפים לזוגות מאורסים: קופסה קשיחה ובה 70 כרטיסיות עם שאלות לתיאום ציפיות לקראת החתונה.</p>
<p>התמונות והאיורים באתר נועדו להמחשה. ייתכנו הפרשי גוון קלים בין הצג לבין המוצר עצמו, ושינויים קלים בעיצוב הקופסה בין מהדורות — תוכן הכרטיסיות ומספרן לא ישתנו.</p>
<p>המשחק אינו ייעוץ זוגי, טיפול או תחליף להם. הוא נועד לשיחה בין בני זוג בלבד.</p>

<h3>3. מחירים ותשלום</h3>
<ul>
<li>כל המחירים באתר נקובים בשקלים חדשים <strong>וכוללים מע״מ</strong>.</li>
<li><strong>במבצע ההשקה, עד 26.10.26:</strong> 129 ₪ לקופסה, כולל משלוח עד הבית או איסוף עצמי.</li>
<li><strong>לאחר סיום המבצע:</strong> 189 ₪ לקופסה. משלוח עד הבית בתוספת 39 ₪; איסוף עצמי ללא עלות.</li>
<li>המחיר המחייב הוא המחיר שמוצג במסך התשלום ברגע ביצוע ההזמנה.</li>
</ul>
<p>התשלום מתבצע בעמוד סליקה מאובטח של חברת <strong>Grow</strong>. פרטי כרטיס האשראי נמסרים ישירות ל-Grow, אינם עוברים דרך האתר ואינם נשמרים אצלנו בשום שלב.</p>
<p>חשבונית מס תישלח בדוא״ל לאחר ביצוע התשלום.</p>

<h3>4. ביצוע הזמנה</h3>
<p>ביצוע הזמנה באתר מותנה בכך שאתם בני 18 ומעלה ובעלי כרטיס אשראי תקף על שמכם, או שקיבלתם את הסכמת האחראי עליכם.</p>
<p>האחריות למסירת פרטים נכונים ומלאים — שם, טלפון וכתובת — היא שלכם. פרטים שגויים עלולים לעכב או למנוע את האספקה, ולחייב בעלות משלוח נוספת.</p>
<p>ההזמנה נחשבת מאושרת רק לאחר קבלת אישור תשלום מחברת הסליקה. קבלת פרטים באתר, ללא תשלום שאושר, אינה מהווה הזמנה.</p>
<p>במקרה של טעות בתיאור או במחיר, או של אזילת מלאי — נהיה רשאים לבטל את ההזמנה, ליידע אתכם ולהשיב לכם את מלוא הסכום ששולם. זו תהיה התרופה היחידה במקרה כזה.</p>

<h3>5. קניין רוחני</h3>
<p>כל הזכויות בתוכן האתר, בשאלות שבכרטיסיות, בעיצוב, בטקסטים, בלוגו ובשם Before I Do שמורות לברק ליור.</p>
<p>המשחק נמכר לשימוש אישי ופרטי. אין להעתיק, לשכפל, לצלם, לתרגם, להפיץ או לעשות שימוש מסחרי בכרטיסיות או בתוכנן — לרבות בסדנאות, בהרצאות או בפעילות בתשלום — ללא אישור מראש ובכתב.</p>

<h3>6. שימוש באתר ואחריות</h3>
<p>אנחנו עושים כל מאמץ שהאתר יהיה זמין ותקין, אך איננו יכולים להתחייב לזמינות רציפה או לכך שלא תהיה בו תקלה. אנחנו רשאים לעדכן, לשנות או להשבית חלקים מהאתר לצורך תחזוקה.</p>
<p>אחריותנו הכוללת כלפי לקוח בגין הזמנה מסוימת לא תעלה על הסכום ששולם בפועל באותה הזמנה.</p>

<h3>7. דין וסמכות שיפוט</h3>
<p>על תקנון זה ועל כל הזמנה שנעשית באתר יחולו דיני מדינת ישראל בלבד. סמכות השיפוט הבלעדית נתונה לבתי המשפט המוסמכים במחוז תל אביב והמרכז.</p>

<h3>8. שינויים בתקנון</h3>
<p>אנחנו רשאים לעדכן את התקנון מעת לעת. הנוסח המחייב הוא זה המופיע באתר במועד ביצוע ההזמנה. תאריך העדכון האחרון מופיע בראש העמוד.</p>

<h2 id="returns">משלוחים, ביטול והחזרות</h2>

<h3>9. משלוח עד הבית</h3>
<ul>
<li>המשלוח מתבצע לכל רחבי הארץ, למעט אזורים שאליהם חברת השליחויות אינה מגיעה או מגיעה בתיאום מיוחד. במקרה כזה ניצור אתכם קשר.</li>
<li><strong>הזמנות מוקדמות מתקופת ההשקה יוצאות ב-26.10.26.</strong> זהו מועד היציאה מאיתנו, ולא מועד המסירה לידיכם.</li>
<li>לאחר תקופת ההשקה, הזמנות יוצאות תוך 1–5 ימי עסקים ממועד אישור התשלום.</li>
<li>ימי עסקים הם א׳–ה׳, למעט ערבי חג, חגים ומועדי ישראל.</li>
</ul>
<p>עיכובים שמקורם בחברת השליחויות, בדואר ישראל, בכתובת שגויה או בנסיבות שאינן בשליטתנו — לרבות שביתה, מזג אוויר קיצוני, מצב ביטחוני או הוראות רשויות — אינם באחריותנו, ולא יזכו בפיצוי מעבר להחזר דמי המשלוח ששולמו בפועל.</p>

<h3>10. איסוף עצמי</h3>
<p>האיסוף העצמי הוא ללא עלות, משתי נקודות: <strong>הוד השרון</strong> ו<strong>גבעת שמואל</strong>. האיסוף מתואם מראש טלפונית. הזמנה שלא נאספה תוך 21 יום ממועד התיאום — ניצור קשר לפני כל פעולה נוספת.</p>

<h3>11. ביטול עסקה והחזר כספי</h3>
<p>זכות הביטול נתונה לכם על פי <strong>חוק הגנת הצרכן, התשמ״א-1981</strong> ותקנות הגנת הצרכן (ביטול עסקה), התשע״א-2010.</p>
<ul>
<li><strong>המועד:</strong> ניתן לבטל מיום ביצוע העסקה ועד <strong>14 ימים מיום קבלת המוצר</strong> או מיום קבלת מסמך הגילוי — לפי המאוחר.</li>
<li><strong>לאדם עם מוגבלות, אזרח ותיק או עולה חדש:</strong> עד 4 חודשים מיום קבלת המוצר, ובלבד שההתקשרות כללה שיחה בין הצדדים. ייתכן שנבקש תעודה מתאימה.</li>
<li><strong>איך מבטלים:</strong> בטלפון <a href="tel:0526604320">052-6604320</a>, בוואטסאפ לאותו מספר, או בדוא״ל <a href="mailto:barakliver@gmail.com">barakliver@gmail.com</a>. נא לציין שם מלא וטלפון.</li>
<li><strong>מצב המוצר:</strong> יש להחזיר את הקופסה שלמה, ללא פגם ובאריזתה המקורית. מוצר שנעשה בו שימוש או שאריזתו נפגמה — לא יזכה בהחזר, בהתאם לתקנה 6 לתקנות.</li>
<li><strong>החזרת המוצר:</strong> באחריותכם ועל חשבונכם, לאחת מנקודות האיסוף או בתיאום איתנו.</li>
<li><strong>דמי ביטול:</strong> אנו רשאים לגבות דמי ביטול בשיעור של 5% ממחיר המוצר או 100 ₪ — הנמוך מביניהם.</li>
<li><strong>ההחזר:</strong> יבוצע תוך 14 ימים מקבלת הודעת הביטול, לאותו אמצעי תשלום שבו בוצעה העסקה.</li>
</ul>

<h3>12. מוצר פגום או שאינו תואם</h3>
<p>אם הקופסה הגיעה פגומה, חסרה כרטיסיות או אינה תואמת את מה שהוזמן — צרו קשר תוך 14 ימים מקבלתה וצרפו תמונה. נחליף אותה או נשיב את מלוא הסכום, לפי בחירתכם, <strong>ועלות המשלוח בשני הכיוונים עלינו</strong>. במקרה כזה לא ייגבו דמי ביטול.</p>`;

const PRIVACY_BODY = `<p style="font-weight:600;color:#4F6BA5">אנחנו אוספים את המינימום שנדרש כדי לשלוח לכם קופסה ולדבר איתכם עליה. העמוד הזה מפרט בדיוק מה נאסף, למה, למי זה מגיע וכמה זמן זה נשמר.</p>

<h2 id="privacy">מדיניות פרטיות</h2>

<h3>1. מי אחראי למידע</h3>
<p>האחראי על המידע הוא <strong>ברק ליור (Liver Production)</strong>, עוסק מורשה 207613829, החומש 2, הוד השרון. לכל פנייה בנושא פרטיות: <a href="mailto:barakliver@gmail.com">barakliver@gmail.com</a> או <a href="tel:0526604320">052-6604320</a>.</p>
<p>מסירת המידע אינה חובה חוקית, אך בלעדיה לא נוכל לטפל בהזמנה ולשלוח לכם את המוצר.</p>

<h3>2. איזה מידע נאסף</h3>
<p><strong>א. מה שאתם מוסרים בקופה:</strong> שם מלא, מספר טלפון, אופן קבלת המוצר, כתובת למשלוח (עיר, רחוב ומספר) או נקודת איסוף, הערות לשליח, והאם אישרתם לקבל דיוור.</p>
<p><strong>ב. מה שנוצר מעצם הגלישה:</strong> כתובת IP, סוג הדפדפן והמכשיר ודפי האתר שנצפו. המידע הזה נשמר בשרתי האחסון שלנו לצורכי אבטחה ותפעול, ואינו משמש לפילוח אישי.</p>
<p><strong>ג. קופה שלא הושלמה:</strong> אם מילאתם שם או טלפון בעמוד ההזמנה ויצאתם בלי להשלים את התשלום, אנחנו שומרים את מה שהספקתם להקליד — יחד עם השלב שאליו הגעתם, משך השהייה בעמוד, סוג המכשיר, והאתר שממנו הגעתם. אנחנו עושים בזה שימוש אחד בלבד: לפנות אליכם ולשאול אם נתקלתם בבעיה. <strong>אם לא הוקלדו שם או טלפון — לא נשמר דבר.</strong> בקשה למחיקה תתבצע מיד, ראו סעיף 8.</p>
<p><strong>ד. מה שלא נאסף אצלנו לעולם:</strong> פרטי כרטיס אשראי. הם נמסרים ישירות לחברת הסליקה Grow ואינם עוברים דרך האתר.</p>

<h3>3. למה אנחנו משתמשים במידע</h3>
<ul>
<li>לטפל בהזמנה, להוציא חשבונית ולשלוח את המוצר.</li>
<li>ליצור אתכם קשר בנוגע להזמנה — אישור, תיאום מסירה, בירור תקלה.</li>
<li>לשמור תיעוד חשבונאי, כנדרש בדין.</li>
<li>לשלוח עדכונים ומבצעים — <strong>רק אם סימנתם את התיבה המתאימה</strong>.</li>
<li>לשפר את האתר ולהבין היכן אנשים נתקלים בקושי.</li>
</ul>

<h3>4. למי המידע מועבר</h3>
<p>איננו מוכרים מידע ואיננו מעבירים אותו לצד שלישי, למעט הגורמים הדרושים לתפעול ההזמנה:</p>
<ul>
<li><strong>Grow</strong> — סליקת האשראי. מקבלת את שמכם, הטלפון ופרטי התשלום.</li>
<li><strong>Vercel</strong> — אחסון האתר והפעלת עמוד ההזמנה.</li>
<li><strong>Green API</strong> — מעבירה אלינו את התראת ההזמנה בוואטסאפ.</li>
<li><strong>Resend</strong> — משלוח התראת ההזמנה בדוא״ל, אם השירות פעיל.</li>
<li><strong>חברת השליחויות או דואר ישראל</strong> — מקבלת שם, טלפון וכתובת לצורך המסירה בלבד.</li>
<li><strong>רשות מוסמכת</strong> — אם נידרש לכך על פי דין או צו שיפוטי.</li>
</ul>
<p>חלק מהשירותים האלה מאחסנים מידע בשרתים מחוץ לישראל, לרבות באיחוד האירופי ובארצות הברית. עצם ביצוע ההזמנה מהווה הסכמה להעברה זו.</p>

<h3>5. כמה זמן המידע נשמר</h3>
<ul>
<li><strong>הזמנות שבוצעו:</strong> שבע שנים, כנדרש מדיני המס והחשבונאות.</li>
<li><strong>קופה שלא הושלמה:</strong> עד 12 חודשים, ולאחר מכן נמחק.</li>
<li><strong>רשימת דיוור:</strong> עד להסרה מצידכם.</li>
<li><strong>יומני שרת:</strong> עד 12 חודשים.</li>
</ul>

<h3>6. דיוור פרסומי</h3>
<p>נשלח לכם דיוור שיווקי רק אם אישרתם זאת במפורש, בהתאם לסעיף 30א לחוק התקשורת (בזק ושידורים), התשמ״ב-1982.</p>
<p>בכל הודעה תופיע דרך להסרה, וניתן גם להשיב "הסר" או לכתוב אלינו לדוא״ל. ההסרה תבוצע תוך יום עסקים אחד. הסרה מדיוור אינה מבטלת הודעות תפעוליות בנוגע להזמנה קיימת.</p>

<h3>7. אבטחת מידע</h3>
<p>האתר פועל בתקשורת מוצפנת (HTTPS), והגישה למידע ההזמנות מוגבלת לברק ליור בלבד. אנו נוקטים אמצעים סבירים לאבטחת המידע, אך איננו יכולים להבטיח חסינות מוחלטת מפני חדירה או שימוש לרעה.</p>

<h3>8. הזכויות שלכם</h3>
<p>לפי חוק הגנת הפרטיות, התשמ״א-1981, אתם רשאים:</p>
<ul>
<li>לעיין במידע שנשמר עליכם.</li>
<li>לבקש לתקן מידע שגוי, לא שלם או לא מעודכן.</li>
<li>לבקש למחוק מידע שאינו נדרש עוד לצורך שלשמו נאסף, ובכלל זה מידע מקופה שלא הושלמה.</li>
<li>לבקש להסיר את עצמכם מרשימת הדיוור.</li>
</ul>
<p>לפנייה: <a href="mailto:barakliver@gmail.com">barakliver@gmail.com</a>. נשיב תוך 30 ימים. מידע שאנו מחויבים לשמור על פי דין — כגון תיעוד הזמנה לצורכי מס — לא יימחק עד תום התקופה הקבועה בחוק.</p>

<h3>9. קטינים</h3>
<p>האתר אינו מיועד לבני פחות מ-18 ואיננו אוספים מידע ביודעין על קטינים. אם נודע לכם שקטין מסר מידע דרך האתר — כתבו לנו ונמחק אותו.</p>

<h3>10. שינויים במדיניות</h3>
<p>נעדכן את המדיניות אם ישתנו השירותים או הדין. תאריך העדכון האחרון מופיע בראש העמוד, ושינוי מהותי יוצג באתר.</p>

<h2 id="cookies">מדיניות עוגיות</h2>

<h3>11. מה נשמר בפועל</h3>
<p>נכון לתאריך שבראש העמוד, האתר <strong>אינו מפעיל עוגיות מדידה, פילוח או פרסום של צד שלישי</strong>. אין באתר Google Analytics, אין פיקסל של פייסבוק, ואין מערכת מעקב אחרת.</p>
<p>הדבר היחיד שנשמר בדפדפן שלכם הוא פריט אחסון מקומי בשם <strong>bid-cookie-consent</strong>, שמכיל את הבחירה שלכם בהודעת העוגיות ואת מועד הבחירה. הוא נשמר במכשיר שלכם בלבד, לא נשלח אלינו, ונועד רק כדי שההודעה לא תופיע שוב בכל ביקור.</p>
<p>בנוסף, ספק האחסון Vercel עשוי להציב עוגיות טכניות הכרחיות לאיזון עומסים ולאבטחה. אלה אינן משמשות למעקב.</p>

<h3>12. אם זה ישתנה</h3>
<p>אם נוסיף בעתיד כלי מדידה או פרסום, הם ייטענו <strong>רק לאחר אישור מצידכם</strong> בהודעת העוגיות, והעמוד הזה יעודכן לפני כן.</p>

<h3>13. ניהול ההעדפה</h3>
<p>אפשר לאפס את הבחירה שלכם בכל רגע — הכפתור למטה ימחק את ההעדפה השמורה, והודעת העוגיות תופיע שוב בביקור הבא.</p>
<p id="bid-consent-slot"></p>
<p>אפשר גם למחוק את כל נתוני האתר דרך הגדרות הדפדפן, בסעיף הפרטיות או "נתוני אתרים".</p>

<h2 id="accessibility">הצהרת נגישות</h2>

<h3>14. המחויבות שלנו</h3>
<p>אנחנו רואים בנגישות חלק מהמוצר, לא תוספת. השקענו מאמץ שהאתר יהיה שמיש גם למי שגולש במקלדת בלבד, בקורא מסך, בהגדלת טקסט או בניגודיות גבוהה, ברוח תקנות שוויון זכויות לאנשים עם מוגבלות (התאמות נגישות לשירות), התשע״ג-2013 והתקן הישראלי ת״י 5568.</p>

<h3>15. מה נעשה בפועל</h3>
<ul>
<li>האתר בנוי בעברית ובכיוון ימין-לשמאל מלא, כולל טפסים ותפריטים.</li>
<li>כל הכפתורים והקישורים ניתנים להפעלה במקלדת, עם סימון מיקוד ברור וגלוי.</li>
<li>שטחי הלחיצה בגודל 44 פיקסלים לפחות, כדי שיהיו נוחים גם למי שידיו אינן יציבות.</li>
<li>הניגודיות בין הטקסט לרקע נבדקה ותוקנה כדי לעמוד ביחס של 4.5:1 לפחות.</li>
<li>מבנה הכותרות היררכי ותקין, כדי שקורא מסך יוכל לנווט בו.</li>
<li>לשדות הטופס בעמוד ההזמנה יש תוויות ומאפייני מילוי אוטומטי.</li>
<li>אנימציות מכבדות את הגדרת המערכת "צמצום תנועה".</li>
<li>לאיורים ולאייקונים הדקורטיביים יש סימון שמסתיר אותם מקורא מסך, כדי שלא יפריעו לקריאה.</li>
</ul>

<h3>16. מה עדיין לא נעשה — בגילוי מלא</h3>
<p>האתר <strong>טרם עבר בדיקת נגישות פורמלית על ידי מורשה נגישות מוסמך</strong>, ואין בידינו חוות דעת נגישות. ההתאמות שלמעלה נעשו במהלך הפיתוח ונבדקו בדפדפן, אך לא במלוא הטכנולוגיות המסייעות.</p>
<p>מגבלות שידועות לנו: קבצים ותכנים שהופקו על ידי צד שלישי עשויים שלא להיות נגישים במלואם, וייתכנו עמודים או רכיבים שבהם ההתאמה חלקית.</p>
<p>אנחנו ממשיכים לתקן. כל דיווח על תקלת נגישות מטופל ומשפר את האתר בפועל.</p>

<h3>17. נגישות נקודות האיסוף</h3>
<p>האיסוף העצמי מתבצע בתיאום טלפוני מראש. אם יש צורך בהתאמה כלשהי — מסירה לרכב, סיוע בנשיאה או מועד שקט יותר — אמרו לנו בשיחת התיאום ונדאג לכך. ניתן גם לבחור במשלוח עד הבית במקום איסוף.</p>

<h3>18. פניות בנושא נגישות</h3>
<p>אחראי הנגישות באתר הוא <strong>ברק ליור</strong>.</p>
<ul>
<li>דוא״ל: <a href="mailto:barakliver@gmail.com">barakliver@gmail.com</a></li>
<li>טלפון / וואטסאפ: <a href="tel:0526604320">052-6604320</a></li>
</ul>
<p>נשמח לשמוע מה לא עבד ובאיזו טכנולוגיה השתמשתם — זה מה שמאפשר לנו לתקן. נשיב תוך 7 ימי עסקים.</p>`;

// "ניהול העדפות פרטיות" in the footer pointed at a section that could only
// describe the setting, never change it. This is the button that changes it.
const CONSENT_RESET = `<script>
(function () {
  // The slot lives inside <x-dc>, which the page runtime renders after this
  // script runs and re-renders afterwards. Looking once finds nothing, and a
  // button planted once is thrown away by the next render \u2014 so check on an
  // interval and plant it again whenever it has gone.
  var IDLE = '\u05d0\u05d9\u05e4\u05d5\u05e1 \u05d4\u05e2\u05d3\u05e4\u05ea \u05d4\u05e2\u05d5\u05d2\u05d9\u05d5\u05ea';
  var DONE = '\u05d4\u05d4\u05e2\u05d3\u05e4\u05d4 \u05d0\u05d5\u05e4\u05e1\u05d4 \u2713';

  function plant() {
    var slot = document.getElementById('bid-consent-slot');
    if (!slot || slot.querySelector('button')) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = IDLE;
    b.style.cssText = 'min-height:44px;padding:0 22px;border-radius:8px;border:1.5px solid #4F6BA5;background:#fff;color:#4F6BA5;font:600 15px/1 Assistant,sans-serif;cursor:pointer';
    b.addEventListener('click', function () {
      try { localStorage.removeItem('bid-cookie-consent'); } catch (e) {}
      b.textContent = DONE;
      setTimeout(function () { b.textContent = IDLE; }, 2600);
    });
    slot.appendChild(b);
  }
  plant();
  setInterval(plant, 500);
})();
<\/script>`;

// The date the legal pages state they were last updated. It is the date the
// text changed, not the date of the build — a document that redates itself on
// every deploy is telling the reader something untrue.
const LEGAL_UPDATED = '2026-09-21';

const LEGAL_OPEN = '<div class="legal" style="order:1;max-width:70ch;min-width:0">';
const LEGAL_CLOSE = '</div>\n\n</div>\n</main>';

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
  fix('buttons: one answer to a pointer', x => x.replace('</helmet>', BUTTON_CSS + '\n</helmet>'));
  if (p.out === 'index.html') fix('box section: styles', x => x.replace('</helmet>', BOX_SECTION_CSS + '\n</helmet>'));
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
  // The legal pages get their real text, their own H1, and today's date.
  if (p.out === 'terms.html' || p.out === 'privacy.html') {
    const body = p.out === 'terms.html' ? TERMS_BODY : PRIVACY_BODY;
    const h1 = p.out === 'terms.html' ? '\u05ea\u05e7\u05e0\u05d5\u05df \u05d5\u05ea\u05e0\u05d0\u05d9 \u05e9\u05d9\u05de\u05d5\u05e9' : '\u05de\u05d3\u05d9\u05e0\u05d9\u05d5\u05ea \u05e4\u05e8\u05d8\u05d9\u05d5\u05ea \u05d5\u05e0\u05d2\u05d9\u05e9\u05d5\u05ea';

    fix('legal: the actual document', x => {
      const i = x.indexOf(LEGAL_OPEN);
      const j = x.indexOf(LEGAL_CLOSE, i);
      if (i < 0 || j < 0) return x;
      return x.slice(0, i + LEGAL_OPEN.length) + '\n' + body + '\n' + x.slice(j);
    });

    // Both pages carried the same H1, which told a visitor nothing about
    // which of the two they had landed on.
    fix('legal: page title', x => x
      .replace('&quot;default&quot;:&quot;\u05ea\u05e7\u05e0\u05d5\u05df \u05d5\u05de\u05d3\u05d9\u05e0\u05d9\u05d5\u05ea&quot;', `&quot;default&quot;:&quot;${h1}&quot;`));

    fix('legal: updated date', x => x
      .split('2026-09-19').join(LEGAL_UPDATED));

    if (p.out === 'privacy.html') {
      fix('legal: consent reset button', x => x.replace('</body>', CONSENT_RESET + '\n</body>'));
    }
  }

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

    // iOS AutoFill needs a form. Barak asked for it twice and the fields
    // already carried the right autocomplete tokens — but Safari offers to
    // fill an address only when the fields sit inside a <form>, and this page
    // had none. The wrapper that holds all three steps becomes one.
    //
    // Both buttons get type="button" first: inside a form an untyped button
    // is a submit button, and the first tap would reload the page and lose
    // everything typed.
    fix('checkout: buttons are buttons, not submits', x => x
      .replace('<button onClick="{{ back }}"', '<button type="button" onClick="{{ back }}"')
      .replace('<button onClick="{{ next }}"', '<button type="button" onClick="{{ next }}"'));

    fix('checkout: wrap the fields in a form', x => {
      const open = '<div style="padding:36px 34px 40px;min-width:0">';
      const i = x.indexOf(open);
      if (i < 0) return x;
      // Walk the div nesting to find this one's own closing tag.
      let depth = 0, end = -1;
      const re = /<(\/?)div\b[^>]*>/g;
      re.lastIndex = i;
      for (let m; (m = re.exec(x));) {
        depth += m[1] ? -1 : 1;
        if (depth === 0) { end = m.index; break; }
      }
      if (end < 0) return x;
      return x.slice(0, i)
        + '<form autocomplete="on" style="padding:36px 34px 40px;min-width:0">'
        + x.slice(i + open.length, end)
        + '</form>'
        + x.slice(end + '</div>'.length);
    });

    // The address fields belong to one shipping address, and saying so is what
    // turns three separate suggestions into a single "fill address" offer.
    fix('checkout: group the address for autofill', x => x
      .replace('autocomplete="name"', 'autocomplete="shipping name"')
      .replace('autocomplete="tel"', 'autocomplete="shipping tel"')
      .replace('autocomplete="address-level2"', 'autocomplete="shipping address-level2"')
      .replace('autocomplete="address-line1"', 'autocomplete="shipping address-line1"')
      .replace('autocomplete="address-line2"', 'autocomplete="shipping address-line2"'));

    // The checkout's own footer repeated the name, the address and the email
    // in one line. Same request as the site footer: the phone is enough.
    fix('checkout footer: phone only', x => x.replace(
      'ברק ליור<br>החומש 2, הוד השרון<br>052-6604320 · barakliver@gmail.com', '052-6604320'));

    fix('checkout: drop the step-1 sub-line', x => x.replace(
      '<p style="margin:12px 0 0;font:300 17px/1.6 Assistant,sans-serif;color:#2F3F63">שני שדות, ואפשר להתקדם.</p>\n', ''));

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

    // renderVals runs on every render, so this is always the current answer.
    fix('checkout: expose state to the lead beacon', x => x.replace(
      'const s = this.state, step = s.step;',
      'const s = this.state, step = s.step; try { window.__bidCheckout = { s: s, step: step }; } catch (e) {}'));
    fix('checkout: lead beacon', x => x.replace('</body>', CHECKOUT_LEADS_JS + '\n</body>'));
    fix('checkout: drop placeholder', x =>
      x.replace(/<p [^>]*>עמוד הסליקה יתחבר כאן\.<\/p>\s*/, ''));

    // Beacon the order to /api/order on the way out. sendBeacon is the right
    // call here: it survives the navigation to Grow, where a fetch would be
    // cancelled mid-flight, and it cannot delay the redirect.
    fix('checkout: notify on pay', x => x.replace(
      'onPay: e => { if (!this.state.consentTerms) e.preventDefault(); }',
      `onPay: e => {
        if (!this.state.consentTerms) { e.preventDefault(); return; }
        window.__bidPaid = true;
        try {
          const s2 = this.state;
          const body = JSON.stringify({
            stage: "pay",
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
    // The line above the flip cards told the visitor how the widget works.
    // The design says it differently: one short invitation here, and the
    // "לחצו להפוך" hint under whichever card they are reaching for.
    // Barak asked for a new running order near the top: the opening, then his
    // own paragraph, then the cards, then "יש החלטות". That last block sits
    // before the cards today, so it moves down past them; "איפה אתם" keeps
    // its place just ahead of the cards, which is what its one link needs.
    fix('order: Barak, then the cards, then the deck', x => {
      const span = (open) => {
        const i = x.indexOf(open);
        if (i < 0) return null;
        let depth = 0, end = -1;
        const re = /<(\/?)div\b[^>]*>/g; re.lastIndex = i;
        for (let m; (m = re.exec(x));) { depth += m[1] ? -1 : 1; if (depth === 0) { end = m.index + m[0].length; break; } }
        return end < 0 ? null : [i, end];
      };
      const deck = span('<div id="deck"');
      const tryCards = span('<div id="bid-try"');
      const w = x.indexOf('<section id="bid-where"');
      const wEnd = x.indexOf('</section>', w);
      if (!deck || !tryCards || w < 0 || wEnd < 0) return x;
      // deck → where → cards, in that order and not nested
      if (!(deck[0] < deck[1] && deck[1] <= w && wEnd < tryCards[0] && tryCards[0] < tryCards[1])) return x;
      const where = x.slice(w, wEnd + '</section>'.length);
      const cards = x.slice(tryCards[0], tryCards[1]);
      const board = x.slice(deck[0], deck[1]);
      return x.slice(0, deck[0])
        + BARAK_SECTION + '\n\n' + where + '\n\n' + cards + '\n\n' + board
        + x.slice(tryCards[1]);
    });
    fix('barak: styles', x => x.replace('</helmet>', BARAK_CSS + '\n</helmet>'));
    fix('barak: portrait slot', x => x.replace('</body>', PORTRAIT_JS + '\n</body>'));

    // The section goes inside the template, immediately before the card
    // preview, so its one continuation leads forward into the cards rather
    // than scrolling a visitor back up the page.
    fix('where-are-you: the section', x => x.replace(
      '<div style="background:#fff">\n<div style="max-width:1180px;margin:0 auto;padding:clamp(40px,6vw,72px) clamp(20px,5vw,32px)">\n<div data-reveal="visual" style="text-align:center">',
      WHERE_SECTION + '\n<div id="bid-try" style="background:#fff">\n<div style="max-width:1180px;margin:0 auto;padding:clamp(40px,6vw,72px) clamp(20px,5vw,32px)">\n<div data-reveal="visual" style="text-align:center">'));
    fix('where-are-you: styles', x => x.replace('</helmet>', WHERE_CSS + '\n</helmet>'));

    fix('cards: invite, do not instruct', x => x.replace(
      'לחיצה הופכת קלף. לחיצה נוספת מחזירה אותו.',
      'לחצו על הקלפים כדי להפוך אותם'));

    // …and it belongs under the heading, not under the cards. Below them it
    // lands right where the per-card hint appears, and the two stack up.
    fix('cards: invitation above, hint below', x => x
      .replace('<p style="margin:clamp(22px,3vw,34px) 0 0;font:300 15px/1.6 Assistant,sans-serif;color:#3E568A;text-align:center">לחצו על הקלפים כדי להפוך אותם</p>\n', '')
      .replace('<p style="margin:0 0 clamp(28px,4vw,44px);font:600 clamp(28px,4.4vw,42px)/1.2 Heebo,sans-serif;color:#4F6BA5">נסו אותי</p>',
               '<p style="margin:0 0 12px;font:600 clamp(28px,4.4vw,42px)/1.2 Heebo,sans-serif;color:#4F6BA5">נסו אותי</p>\n<p style="margin:0 0 clamp(28px,4vw,44px);font:300 15px/1.6 Assistant,sans-serif;color:#3E568A;text-align:center">לחצו על הקלפים כדי להפוך אותם</p>'));

    fix('headline: give it room', x => x
      .replace('<div data-reveal="text" style="max-width:34ch">',
               '<div data-reveal="text" style="max-width:min(900px,100%)">')
      // Wide, not shouting: it was clamped at 42px and wrapping to six lines,
      // then over-corrected to 58px and crowding the section. This sits
      // between them, with the width fix that was the real problem.
      .replace('font:600 clamp(28px,4.4vw,42px)/1.3 Heebo,sans-serif;color:#4F6BA5;text-indent:0',
               'font:600 clamp(24px,3.7vw,42px)/1.3 Heebo,sans-serif;color:#4F6BA5;text-indent:0'));
  }

  // Barak asked for the licence number out of the footer, and then for the
  // name, the address and the email as well. All four still appear in the
  // terms and the privacy policy, where the law wants the seller identified;
  // the footer keeps the phone.
  fix('footer: drop the licence number', x =>
    x.replace('ברק ליור, עוסק מורשה 207613829', 'ברק ליור'));
  fix('footer: drop the name and address', x =>
    x.replace('<p style="margin:14px 0 0;font:400 15px/1.85 Assistant,sans-serif;color:#fff">ברק ליור<br>החומש 2, הוד השרון</p>', ''));
  fix('footer: drop the email', x =>
    x.replace(/<li><a href="mailto:barakliver@gmail\.com"[^>]*>barakliver@gmail\.com<\/a><\/li>\s*/, ''));

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
