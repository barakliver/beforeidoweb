#!/usr/bin/env node
// Everything the page needs in order to be found, measured and shared.
//
//   node tools/site-fixes.js          re-apply to index.html in place
//
// import-design.js calls apply() as its last step, so a fresh design export
// comes out of the box with all of this already on it. Running it by hand is
// for when you edit tools/site-content.js and want the page updated without
// re-importing a design.
//
// Every fix checks for itself first, so running this twice changes nothing.

const fs = require('fs');
const path = require('path');
const C = require('./site-content');

const ROOT = path.resolve(__dirname, '..');
const SITE = C.siteUrl.replace(/\/+$/, '');
const abs = p => SITE + '/' + String(p).replace(/^\/+/, '');
const esc = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── the sections we append ──────────────────────────────────────────────────
const published = () => C.faq.filter(f => f.q && f.a && f.a.trim());

function faqHtml() {
  const items = published();
  if (!items.length) return '';
  return `
<section class="bid-section bid-faq" id="faq" aria-labelledby="bid-faq-title">
  <div class="bid-section__inner">
    <hr class="bid-section__rule">
    <h2 id="bid-faq-title">${esc(C.faqHeading)}</h2>
    <div class="bid-faq__list">
${items.map(f => `      <details>
        <summary data-bid-event="faq_open">${esc(f.q)}</summary>
        <p>${esc(f.a)}</p>
      </details>`).join('\n')}
    </div>
  </div>
</section>`;
}

function closingHtml() {
  const t = C.closing;
  const waText = t.shareText.replace('{url}', SITE);
  const wa = 'https://wa.me/?text=' + encodeURIComponent(waText);
  const waIcon = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">'
    + '<path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.46 1.32 4.96L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm5.8 14.06c-.24.68-1.42 1.32-1.95 1.36-.5.04-.98.22-3.3-.69-2.78-1.1-4.55-3.95-4.69-4.14-.14-.19-1.12-1.49-1.12-2.84 0-1.35.71-2.01.96-2.29.25-.28.55-.35.73-.35h.52c.17 0 .4-.06.62.47.24.57.8 1.97.87 2.11.07.14.12.31.02.5-.09.19-.14.31-.28.47-.14.16-.29.36-.42.48-.14.14-.28.29-.12.57.16.28.72 1.19 1.55 1.93 1.07.95 1.97 1.25 2.25 1.39.28.14.44.12.6-.07.17-.19.69-.8.87-1.08.19-.28.37-.23.63-.14.25.09 1.65.78 1.93.92.28.14.47.21.54.33.07.11.07.66-.17 1.34Z"/></svg>';

  return `
<section class="bid-section bid-closing" aria-labelledby="bid-closing-title">
  <div class="bid-section__inner bid-closing__grid">
    <div id="bid-lead">
      <hr class="bid-section__rule">
      <h2 id="bid-closing-title">${esc(t.heading)}</h2>
      <p class="bid-section__lead">${esc(t.body)}</p>
      <form id="bid-lead-form" class="bid-form-wrap" hidden
            data-thanks="${esc(t.thanks)}" data-error="${esc(t.error)}">
        <div class="bid-form">
          <label class="bid-visually-hidden" for="bid-email">${esc(t.placeholder)}</label>
          <input id="bid-email" name="email" type="email" required autocomplete="email"
                 placeholder="${esc(t.placeholder)}">
          <button type="submit" class="bid-btn">${esc(t.submit)}</button>
        </div>
        <label class="bid-form__consent">
          <input type="checkbox" name="marketing_consent" required>
          <span>${esc(t.consent)}</span>
        </label>
      </form>
      <p class="bid-status" id="bid-lead-status" role="status"></p>
    </div>

    <div>
      <hr class="bid-section__rule">
      <h2>${esc(t.shareHeading)}</h2>
      <p class="bid-section__lead">${esc(t.shareBody)}</p>
      <div class="bid-share">
        <a class="bid-btn" href="${esc(wa)}" target="_blank" rel="noopener"
           data-bid-event="share_whatsapp">${waIcon}${esc(t.shareWhatsapp)}</a>
        <button type="button" class="bid-btn bid-btn--ghost" id="bid-share-copy"
                data-bid-event="share_copy" data-url="${esc(SITE)}"
                data-copied="${esc(t.shareCopied)}">${esc(t.shareCopy)}</button>
      </div>
    </div>
  </div>
</section>`;
}

// Crawlers render JS, but not always and not quickly, and the whole page is
// drawn by the design runtime. This is the only copy in the document that is
// readable with no JavaScript at all.
function noscriptHtml() {
  return `
<noscript>
  <div class="bid-noscript">
    <h1>${esc(C.product.name)}</h1>
    <p>${esc(C.product.description)}</p>
    <p>${esc(C.product.price)} ${C.currencySymbol || '₪'} · ${esc(C.legalName)}</p>
  </div>
</noscript>`;
}

function jsonLd() {
  const items = published();
  const graph = [
    {
      '@type': 'Organization',
      '@id': SITE + '/#org',
      name: C.legalName,
      url: SITE,
    },
    {
      '@type': 'WebSite',
      '@id': SITE + '/#website',
      url: SITE,
      name: C.brand,
      inLanguage: 'he-IL',
      publisher: { '@id': SITE + '/#org' },
    },
    {
      '@type': 'Product',
      '@id': SITE + '/#product',
      name: C.product.name,
      description: C.product.description,
      image: [abs(C.product.image)],
      brand: { '@type': 'Brand', name: C.brand },
      // No aggregateRating until there are real reviews to aggregate.
      offers: {
        '@type': 'Offer',
        url: SITE,
        price: C.product.price,
        priceCurrency: C.product.currency,
        availability: 'https://schema.org/' + C.product.availability,
        seller: { '@id': SITE + '/#org' },
      },
    },
  ];

  if (items.length) {
    graph.push({
      '@type': 'FAQPage',
      '@id': SITE + '/#faq',
      mainEntity: items.map(f => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    });
  }

  return '<script type="application/ld+json">'
    + JSON.stringify({ '@context': 'https://schema.org', '@graph': graph })
    + '</script>';
}

const HEAD_ADDITIONS = () => `<link rel="canonical" href="${SITE}/">
<meta property="og:url" content="${SITE}/">
<meta property="og:image:alt" content="קופסת Before I Do עם הכרטיסיות">
<meta name="robots" content="index,follow,max-image-preview:large">
<link rel="stylesheet" href="assets/site/marketing.css">
${jsonLd()}
<script src="assets/site/config.js"></script>
<script defer src="assets/site/marketing.js"></script>
`;

// ── image weight ────────────────────────────────────────────────────────────
// A 950KB PNG below the fold is the single most expensive thing on a phone.
// Convert when a converter is around, and always stop the browser fetching
// images nobody has scrolled to yet.
function converter() {
  try {
    const sharp = require('sharp');
    return (src, out) => sharp(src).webp({ quality: 82, effort: 6 }).toFile(out).then(() => true);
  } catch (e) { /* not installed */ }

  const { spawnSync } = require('child_process');
  if (spawnSync('cwebp', ['-version'], { stdio: 'ignore' }).status === 0) {
    return (src, out) => {
      const r = spawnSync('cwebp', ['-q', '82', src, '-o', out], { stdio: 'ignore' });
      return Promise.resolve(r.status === 0);
    };
  }
  return null;
}

async function optimizeImages(html, root, report) {
  const dir = path.join(root, 'assets', 'img');
  if (!fs.existsSync(dir)) return html;

  const convert = converter();
  const sources = fs.readdirSync(dir).filter(f => /\.(png|jpe?g)$/i.test(f));
  let saved = 0, made = 0;
  const swap = {};

  for (const f of sources) {
    const src = path.join(dir, f);
    const webp = src.replace(/\.(png|jpe?g)$/i, '.webp');
    if (!fs.existsSync(webp)) {
      if (!convert) continue;
      if (!(await convert(src, webp))) continue;
      made++;
    }
    // Only point the page at the smaller file — a WebP that came out heavier
    // than its source is not an optimization.
    if (fs.statSync(webp).size < fs.statSync(src).size) {
      saved += fs.statSync(src).size - fs.statSync(webp).size;
      swap['assets/img/' + f] = 'assets/img/' + path.basename(webp);
    }
  }

  // Only inside <img>. og:image and the touch icon stay JPEG/PNG: WhatsApp and
  // Facebook are the whole point of that tag and neither renders WebP reliably.
  html = html.replace(/<img\b[^>]*>/g, tag => {
    for (const from in swap) tag = tag.split(from).join(swap[from]);
    return tag;
  });

  report.push([
    saved ? 'ok' : 'SKIPPED',
    convert
      ? `webp images (${made} converted, ${Math.round(saved / 1024)}KB lighter)`
      : 'webp images — no converter found (npm i sharp, or brew install webp)',
  ]);

  // Everything but the first image waits until it is scrolled to.
  let first = true;
  const before = html;
  html = html.replace(/<img\b(?![^>]*\b(?:loading|fetchpriority)=)([^>]*?)>/g, (m, attrs) => {
    if (first) { first = false; return `<img${attrs} decoding="async" fetchpriority="high">`; }
    return `<img${attrs} loading="lazy" decoding="async">`;
  });
  report.push([html === before ? 'SKIPPED' : 'ok', 'lazy-load below-the-fold images']);

  return html;
}

// ── files that live next to the page ────────────────────────────────────────
function writeSiteFiles(root, report) {
  const robots = `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`;
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE}/</loc>
    <lastmod>${new Date().toISOString().slice(0, 10)}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`;
  fs.writeFileSync(path.join(root, 'robots.txt'), robots);
  fs.writeFileSync(path.join(root, 'sitemap.xml'), sitemap);
  report.push(['ok', 'robots.txt + sitemap.xml']);
}

// ── the pass ────────────────────────────────────────────────────────────────
async function apply(html, opts = {}) {
  const root = opts.root || ROOT;
  const report = [];
  const fix = (name, fn) => {
    const before = html;
    html = fn(html);
    report.push([html === before ? 'SKIPPED' : 'ok', name]);
  };

  // og:image has to be absolute or WhatsApp and Facebook show no preview at
  // all — and a link sent in WhatsApp is how this product actually travels.
  fix('absolute og:image', s =>
    s.replace(/(<meta property="og:image" content=")(?!https?:)([^"]+)(")/,
      (m, a, p, b) => a + abs(p) + b));

  fix('head: canonical, og:url, schema, measurement', s =>
    s.includes('assets/site/marketing.css') ? s : s.replace('</head>', HEAD_ADDITIONS() + '</head>'));

  fix('no-JS fallback copy', s =>
    s.includes('bid-noscript') ? s : s.replace('<body>', '<body>' + noscriptHtml()));

  fix('FAQ + capture + share sections', s => {
    if (s.includes('bid-closing')) return s;
    return s.replace('</body>', faqHtml() + closingHtml() + '\n</body>');
  });

  html = await optimizeImages(html, root, report);
  writeSiteFiles(root, report);

  const missing = C.faq.filter(f => f.q && !(f.a && f.a.trim()));
  return { html, report, missing };
}

module.exports = { apply };

// ── standalone ──────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const file = path.join(ROOT, 'index.html');
    const { html, report, missing } = await apply(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, html);

    console.log('site fixes → index.html\n');
    for (const [status, name] of report) console.log(`  ${status.padEnd(8)} ${name}`);

    if (missing.length) {
      console.log(`\n${missing.length} FAQ answer(s) still empty — not published:`);
      for (const f of missing) console.log('  · ' + f.q);
      console.log('  fill them in tools/site-content.js and run this again.');
    }
    const cfg = path.join(ROOT, 'assets', 'site', 'config.js');
    if (/ga4Id: ''/.test(fs.readFileSync(cfg, 'utf8'))) {
      console.log('\nno analytics ID in assets/site/config.js — nothing is being measured yet.');
    }
  })();
}
