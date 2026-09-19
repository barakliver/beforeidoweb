#!/usr/bin/env node
// Turn a Claude Design bundle export into the deployable site.
//
//   node tools/import-design.js ~/Downloads/Before_I_Do.html          → index.html
//   node tools/import-design.js ~/Downloads/Terms.html terms          → terms.html
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
const crypto = require('crypto');
const siteFixes = require('./site-fixes');
const C = require('./site-content');

const ROOT = path.resolve(__dirname, '..');
const SRC = process.argv[2];

// Which page of the site this bundle is. Every export is a separate design and
// a separate import; without a name they would all land on index.html.
const PAGE = (process.argv[3] || 'index').replace(/\.html$/, '');

if (!SRC) {
  console.error('usage: node tools/import-design.js <bundle.html> [page-name]');
  console.error('       page-name defaults to "index" (a-z, 0-9 and dashes)');
  process.exit(1);
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(PAGE)) {
  console.error(`bad page name "${PAGE}" — use lowercase letters, digits and dashes`);
  process.exit(1);
}
const OUT = PAGE + '.html';
const PAGE_META = (C.pages && C.pages[OUT]) || {};

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
  fs.mkdirSync(path.join(ROOT, 'assets', d), { recursive: true });
}

// Asset filenames are their content, not their position in the manifest.
// Counting (img-1, img-2…) only works while there is one page: a second import
// would renumber the same pictures and quietly repoint the first page at the
// wrong ones. A hash means two pages that share a font share the file, an
// unchanged design re-imports to identical names, and nothing collides.
// Stale files from an earlier import are swept afterwards, not up front —
// deleting the directory first would take the other pages' assets with it.
const digest = buf => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);

let nImg = 0, nFont = 0;
const paths = {};
for (const [uuid, e] of Object.entries(manifest)) {
  let buf = Buffer.from(e.data, 'base64');
  if (e.compressed) buf = zlib.gunzipSync(buf);
  const kind = EXT[e.mime] || 'bin';
  const h = digest(buf);

  let rel;
  if (e.mime.startsWith('image/')) { nImg++; rel = `assets/img/img-${h}.${kind}`; }
  else if (e.mime.startsWith('font/')) { nFont++; rel = `assets/fonts/font-${h}.${kind}`; }
  else if (extUrl[uuid]) {
    const base = path.basename(new URL(extUrl[uuid]).pathname).replace(/\.js$/, '');
    rel = `assets/js/${base}-${h}.js`;
  } else rel = `assets/js/app-${h}.js`;

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

// The social preview lives at one address that never changes. WhatsApp and
// Facebook cache og:image by URL for a long time, and a hashed filename would
// hand them a new URL on every export — so the chosen picture is copied to
// assets/social.<ext> and the tag points there. Only an index import may
// replace it; a legal page's own pictures must not become the site's preview.
function resolveSocial() {
  const dir = path.join(ROOT, 'assets');
  const isSocial = f => /^social\.(jpe?g|png|webp)$/i.test(f);
  const existing = fs.readdirSync(dir).find(isSocial);
  if (PAGE !== 'index') return existing ? 'assets/' + existing : null;

  const images = Object.values(paths).filter(p => p.startsWith('assets/img/'));
  if (!images.length) return existing ? 'assets/' + existing : null;

  // Pick by alt text when site-content names one — filenames are hashes now,
  // so the words on the picture are the only human-readable handle.
  let pick = null;
  if (C.socialImageAlt) {
    const m = html.match(new RegExp('<img[^>]*alt="[^"]*' + C.socialImageAlt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^"]*"[^>]*>'));
    const src = m && m[0].match(/src="([^"]+)"/);
    if (src && images.includes(src[1])) pick = src[1];
  }
  pick = pick
    || images.find(p => /\.jpe?g$/i.test(p))
    || images.slice().sort((a, b) =>
         fs.statSync(path.join(ROOT, b)).size - fs.statSync(path.join(ROOT, a)).size)[0];

  const out = 'assets/social' + path.extname(pick);
  for (const f of fs.readdirSync(dir)) {
    if (isSocial(f) && 'assets/' + f !== out) fs.unlinkSync(path.join(dir, f));
  }
  fs.copyFileSync(path.join(ROOT, pick), path.join(ROOT, out));
  return out;
}
const APP = Object.values(paths).find(p => /^assets\/js\/app-/.test(p));
if (!APP) {
  console.error('no runtime script in the bundle — cannot place the page head');
  process.exit(1);
}

const SOCIAL = resolveSocial();
if (SOCIAL) console.log(`social    ${SOCIAL}`);
else console.log('social    SKIPPED — no image to use as a link preview');

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
const TITLE = PAGE_META.title || C.product.name;
const DESC = PAGE_META.description || C.product.description;
const HEAD = `<title>${TITLE}</title>
<meta name="description" content="${DESC}">
<meta name="theme-color" content="#4F6BA5">
<link rel="icon" href="assets/favicon.svg" type="image/svg+xml">
${SOCIAL ? `<link rel="apple-touch-icon" href="${SOCIAL}">\n` : ''}<meta property="og:type" content="website">
<meta property="og:locale" content="he_IL">
<meta property="og:site_name" content="${C.brand}">
<meta property="og:title" content="${TITLE}">
<meta property="og:description" content="${DESC}">
${SOCIAL ? `<meta property="og:image" content="${SOCIAL}">\n` : ''}<meta name="twitter:card" content="summary_large_image">
<script>
  window.__resources = {
${ext.map(r => `    ${JSON.stringify(r.id)}: ${JSON.stringify(paths[r.uuid])}`).join(',\n')}
  };
</script>
`;
const APP_TAG = `<script src="${APP}"></script>`;
fix('head metadata + local React', s => s.replace(APP_TAG, HEAD + APP_TAG));

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

// Search, measurement, FAQ, capture and sharing — everything the design tool
// has no concept of. Kept in its own module so it can also be re-run on its
// own after a content edit: node tools/site-fixes.js
(async () => {
  const site = await siteFixes.apply(html, { root: ROOT, page: OUT });
  report.push(...site.report);

  fs.writeFileSync(path.join(ROOT, OUT), site.html);

  // Only now, with every page on disk pointing at its own hashed assets, is it
  // safe to say which files nothing uses any more.
  const swept = siteFixes.sweepAssets(ROOT);
  if (swept.length) report.push(['ok', `swept ${swept.length} unused asset file(s)`]);

  console.log(`${OUT} written\n`);
  for (const [status, name] of report) console.log(`  ${status.padEnd(8)} ${name}`);

  const skipped = report.filter(r => r[0] === 'SKIPPED');
  if (skipped.length) {
    console.log(`\n${skipped.length} fix(es) did not match — the design changed there. Check the page before deploying.`);
  }
  if (site.missing.length) {
    console.log(`\n${site.missing.length} FAQ answer(s) still empty in tools/site-content.js — not published:`);
    for (const f of site.missing) console.log('  · ' + f.q);
  }
  if (!(C.pages && C.pages[OUT])) {
    console.log(`\n"${OUT}" is not listed in tools/site-content.js — it got the`);
    console.log('default title and no place in sitemap.xml. Add it there.');
  }
  console.log('\nnext: python3 -m http.server 8099   then open http://127.0.0.1:8099');
})();
