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
  { src: 'Before I Do - Design Spec.dc.html', out: 'spec.html',
    title: `מפרט עיצוב — Before I Do`, desc: 'מסמך פנימי', noindex: true },
  { src: 'Before I Do - Visual DNA.dc.html', out: 'visual-dna.html',
    title: `Visual DNA — Before I Do`, desc: 'מסמך פנימי', noindex: true },
  { src: 'Before I Do - מדיניות.dc.html', out: 'policies.html',
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

// Runtime.
fs.copyFileSync(path.join(SRC, 'support.js'), path.join(ROOT, 'assets/js/app.js'));

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
const RESOURCES = `<script>
  window.__resources = {
${Object.entries(vendor).map(([url, rel]) => `    ${JSON.stringify(url)}: ${JSON.stringify(rel)}`).join(',\n')}
  };
</script>`;

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
  lines.push(RESOURCES);
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
