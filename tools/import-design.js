#!/usr/bin/env node
// Turn a Claude Design bundle export into the deployable site.
//
//   node tools/import-design.js ~/Downloads/Before_I_Do.html
//
// The export is one self-extracting HTML file: assets live base64 in a
// manifest island and the page mints blob URLs for them at load. That is fine
// as a download and useless as a hosted site, so we unpack it into real files
// and re-apply the things the design tool does not emit.
//
// Every fix below is reported as applied or skipped. A skipped fix is not
// fatal — the design may simply have changed — but it does mean someone should
// look before deploying.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const SRC = process.argv[2];

if (!SRC) {
  console.error('usage: node tools/import-design.js <bundle.html>');
  process.exit(1);
}

const bundle = fs.readFileSync(SRC, 'utf8');

function island(type) {
  const m = bundle.match(
    new RegExp('<script type="__bundler/' + type + '">\\n([\\s\\S]*?)\\n\\s*<\\/script>')
  );
  if (!m) throw new Error(`no "${type}" island in ${SRC} — is this a Claude Design export?`);
  return JSON.parse(m[1]);
}

const manifest = island('manifest');
const ext = island('ext_resources');
let html = island('template');

// ── assets ────────────────────────────────────────────────────────────────
const EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg',
  'image/gif': 'gif', 'font/woff2': 'woff2', 'font/woff': 'woff',
  'text/javascript': 'js', 'text/css': 'css',
};
const extUrl = Object.fromEntries(ext.map(r => [r.uuid, r.id]));

for (const d of ['img', 'fonts', 'js']) {
  fs.rmSync(path.join(ROOT, 'assets', d), { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, 'assets', d), { recursive: true });
}

let nImg = 0, nFont = 0;
const paths = {};
for (const [uuid, e] of Object.entries(manifest)) {
  let buf = Buffer.from(e.data, 'base64');
  if (e.compressed) buf = zlib.gunzipSync(buf);
  const kind = EXT[e.mime] || 'bin';

  let rel;
  if (e.mime.startsWith('image/')) rel = `assets/img/img-${++nImg}.${kind}`;
  else if (e.mime.startsWith('font/')) rel = `assets/fonts/font-${++nFont}.${kind}`;
  else if (extUrl[uuid]) rel = 'assets/js/' + path.basename(new URL(extUrl[uuid]).pathname);
  else rel = 'assets/js/app.js';

  fs.writeFileSync(path.join(ROOT, rel), buf);
  paths[uuid] = rel;
}
for (const [uuid, rel] of Object.entries(paths)) html = html.split(uuid).join(rel);

const orphans = html.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g);
if (orphans) {
  console.error('unresolved asset references:', [...new Set(orphans)].join(', '));
  process.exit(1);
}
console.log(`assets    ${Object.keys(paths).length} files (${nImg} images, ${nFont} fonts)`);

// ── fixes the design tool does not emit ───────────────────────────────────
const report = [];
function fix(name, fn) {
  const before = html;
  html = fn(html);
  report.push([html === before ? 'SKIPPED' : 'ok', name]);
}

fix('lang="he" dir="rtl"', s => s.replace('<html><head>', '<html lang="he" dir="rtl"><head>'));

// React is fetched from unpkg by the runtime; window.__resources redirects it
// to our own copies. It also stops the runtime re-fetching the page at boot.
const SITE = 'https://www.beforeido.co.il';
const TAGLINE = 'משחק קלפים לזוגות מאורסים';

// og:image must be absolute — a relative one is not resolved reliably by every
// scraper, and WhatsApp is one of the strict ones.
const HEAD = `<title>Before I Do — ${TAGLINE}</title>
<meta name="description" content="${TAGLINE}. חמישים כרטיסיות עם השאלות שכל זוג מאורס צריך לשאול לפני החתונה — ערב אחד, שיחה אמיתית, בלי שיפוטיות. מאת Liver Production.">
<meta name="theme-color" content="#4F6BA5">
<link rel="canonical" href="${SITE}/">
<link rel="icon" href="assets/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="assets/img/img-1.png">
<meta property="og:type" content="website">
<meta property="og:locale" content="he_IL">
<meta property="og:site_name" content="Before I Do">
<meta property="og:url" content="${SITE}/">
<meta property="og:title" content="Before I Do">
<meta property="og:description" content="${TAGLINE}">
<meta property="og:image" content="${SITE}/assets/og-card.png">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Before I Do — ${TAGLINE}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Before I Do">
<meta name="twitter:description" content="${TAGLINE}">
<meta name="twitter:image" content="${SITE}/assets/og-card.png">
<script>
  window.__resources = {
${ext.map(r => `    ${JSON.stringify(r.id)}: ${JSON.stringify(paths[r.uuid])}`).join(',\n')}
  };
</script>
`;
fix('head metadata + local React', s =>
  s.replace('<script src="assets/js/app.js"></script>', HEAD + '<script src="assets/js/app.js"></script>'));

// The authoring commentary ("What the opening does", "Still open"…) is written
// in English for the designer and renders on the public page.
fix('hide design notes (data-props)', s =>
  s.replace('&quot;showVoiceNotes&quot;:{&quot;editor&quot;:&quot;boolean&quot;,&quot;default&quot;:true,',
            '&quot;showVoiceNotes&quot;:{&quot;editor&quot;:&quot;boolean&quot;,&quot;default&quot;:false,'));
fix('hide design notes (component)', s =>
  s.replace('showVoiceNotes: this.props.showVoiceNotes ?? true,',
            'showVoiceNotes: this.props.showVoiceNotes ?? false,'));

// Headings are authored at one fixed desktop size, which on a phone costs most
// of the screen. Override font-size after the shorthand rather than inlining
// clamp() into it — same result, nothing relying on how the font slot parses.
// Reaches full size around a 708px viewport; below that it scales down.
const BIG_PX = 32;
let scaled = 0;
html = html.replace(/font:(\d+) (\d+)px\/([\d.]+) ([^;"]+);/g, (m, weight, px, lh, family) => {
  const n = +px;
  if (n < BIG_PX) return m;
  scaled++;
  return `${m}font-size:clamp(${Math.round(n * 0.65)}px, ${(n / 7.08).toFixed(1)}vw, ${n}px);`;
});
report.push([scaled ? 'ok' : 'SKIPPED', `responsive headings (${scaled} rules ≥ ${BIG_PX}px)`]);

fs.writeFileSync(path.join(ROOT, 'index.html'), html);

console.log('index.html written\n');
for (const [status, name] of report) console.log(`  ${status.padEnd(8)} ${name}`);

const skipped = report.filter(r => r[0] === 'SKIPPED');
if (skipped.length) {
  console.log(`\n${skipped.length} fix(es) did not match — the design changed there. Check the page before deploying.`);
}
console.log('\nnext: python3 -m http.server 8099   then open http://127.0.0.1:8099');
