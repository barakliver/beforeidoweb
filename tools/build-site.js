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

// Grow payment links, one per delivery method: the link's amount is fixed on
// Grow's side and no URL parameter overrides it (sum/price/amount are all
// ignored), so a different total needs a different link.
//   self = 129 ₪ (pickup)   ship = 168 ₪ (129 + 39 delivery)
// Until a 168 ₪ link exists, shipping falls back to the 129 ₪ one and every
// shipped order is charged 39 ₪ short.
const PAY = {
  self: 'https://pay.grow.link/OTU0ODQ~bf83dbe62447b9a2c28b0611db86e909-NDAxNjIzMw',
  ship: null,
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
const SHARE_FLOAT = `<a id="wa-share" href="https://wa.me/?text=${encodeURIComponent(SHARE_TEXT)}"
   target="_blank" rel="noopener" aria-label="שתפו את האתר בוואטסאפ">
  <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.8-.9L3 20.5l1.6-4.9A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z"/></svg>
  <span>שתפו בוואטסאפ</span>
</a>
<style>
  #wa-share {
    position: fixed; z-index: 60;
    left: clamp(14px, 4vw, 26px);   /* physically left: inset-inline-start is the RIGHT edge in RTL */
    bottom: calc(var(--wa-lift, 0px) + clamp(16px, 3vw, 26px));
    display: inline-flex; align-items: center; justify-content: center; gap: 10px;
    min-height: 48px; padding: 0 22px; border-radius: 999px;
    background: #25D366; color: #fff; text-decoration: none;
    font: 600 16px/1 Assistant, sans-serif; white-space: nowrap;
    box-shadow: 0 6px 20px rgba(31, 44, 74, .28);
    transition: background 260ms cubic-bezier(.2,.7,.2,1), bottom 260ms cubic-bezier(.2,.7,.2,1);
  }
  #wa-share:hover { background: #1FB855; }
  #wa-share:focus-visible { outline: 3px solid #EF453D; outline-offset: 3px; }
  @media (max-width: 420px) { #wa-share { padding: 0 18px; font-size: 15px; } }
  @media (prefers-reduced-motion: reduce) { #wa-share { transition: none; } }
</style>
<script>
(function () {
  var btn = document.getElementById('wa-share');
  if (!btn) return;
  function lift() {
    var vh = window.innerHeight, clear = 0;
    var nodes = document.body ? document.body.querySelectorAll('*') : [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el === btn || btn.contains(el)) continue;
      var cs = getComputedStyle(el);
      if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') continue;
      var r = el.getBoundingClientRect();
      // Anchored to the bottom edge, and actually covering something.
      if (r.height < 8 || r.width < 40) continue;
      if (r.bottom < vh - 4 || r.top > vh - 8) continue;
      clear = Math.max(clear, vh - r.top);
    }
    btn.style.setProperty('--wa-lift', clear ? clear + 10 + 'px' : '0px');
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
const RED = '#D63229', RED_DARK = '#BC241C';
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

const report = [];
let built = 0;

for (const p of PAGES) {
  const file = findSource(p.src);
  if (!file) { report.push(['MISSING', p.out + '  (no source for ' + p.src + ')']); continue; }
  let s = fs.readFileSync(file, 'utf8');
  const fixes = [];
  const fix = (name, fn) => { const b = s; s = fn(s); fixes.push([s === b ? 'SKIPPED' : 'ok', name]); };

  fix('lang/dir', x => x.replace('<html>', '<html lang="he" dir="rtl">'));

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
    const self = JSON.stringify(PAY.self);
    const ship = JSON.stringify(PAY.ship || PAY.self);
    fix('checkout: pay link', x => x.replace(
      'payUrl: this.props.payUrl ?? "#",',
      `payUrl: s.method === "ship" ? ${ship} : ${self},`));
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
            total: 129 + (s2.method === "ship" ? 39 : 0)
          });
          navigator.sendBeacon("/api/order", new Blob([body], { type: "application/json" }));
        } catch (err) { /* a lost notification must never block the payment */ }
      }`));
    if (!PAY.ship) report.push(['WARNING', '    checkout: no 168 ₪ link — shipping charges 129 ₪']);
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

    // Only the header's CTA turns red. The other two sit ON the blue, where
    // white-on-blue is the contrast that works and red would not.
    fix('header CTA: red', x => x.replace(
      'color:#fff;background:#4F6BA5;border:1.5px solid #4F6BA5;border-radius:8px;padding:0 22px;height:44px',
      `color:#fff;background:${RED};border:1.5px solid ${RED};border-radius:8px;padding:0 22px;height:44px`)
      .replace('style-hover="background:#3E568A">אני רוצה את המשחק</a>',
               `style-hover="background:${RED_DARK}">אני רוצה את המשחק</a>`));
  }

  if (p.out !== 'checkout.html' && !p.board) {
    fix('floating share button', x => x.replace('</body>', SHARE_FLOAT + '\n</body>'));
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
