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
// Generated blocks are fenced in <!--bid:name--> … <!--/bid:name--> markers and
// rewritten in place on every run. Skipping them when they already existed is
// what an earlier version did, and it meant editing site-content.js changed
// nothing on the page — the worst kind of no-op, the silent one.

const fs = require('fs');
const path = require('path');
const C = require('./site-content');

const ROOT = path.resolve(__dirname, '..');
const SITE = C.siteUrl.replace(/\/+$/, '');
const abs = p => SITE + '/' + String(p).replace(/^\/+/, '');
const esc = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Replace the fenced block if it is there, otherwise put it where `insert`
// says. Either way the page ends up holding exactly one, current copy.
function upsert(html, name, content, insert) {
  const fenced = `<!--bid:${name}-->${content}<!--/bid:${name}-->`;
  const re = new RegExp(`<!--bid:${name}-->[\\s\\S]*?<!--/bid:${name}-->`);
  return re.test(html) ? html.replace(re, () => fenced) : insert(html, fenced);
}

// A page the content file does not know about still has to get a sane
// canonical and stay out of the home page's structured data.
function pageMeta(file) {
  const known = (C.pages && C.pages[file]) || null;
  const slug = file.replace(/\.html$/, '');
  return Object.assign({
    path: slug === 'index' ? '/' : '/' + slug,
    title: C.product.name,
    description: C.product.description,
    sections: false,   // FAQ + capture + share belong to the selling page
    product: false,    // and so does the Product/Offer structured data
    sitemap: slug !== '404',
  }, known || {});
}


// ── icons ───────────────────────────────────────────────────────────────────
const ICON = {
  whatsapp: '<path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.46 1.32 4.96L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm5.8 14.06c-.24.68-1.42 1.32-1.95 1.36-.5.04-.98.22-3.3-.69-2.78-1.1-4.55-3.95-4.69-4.14-.14-.19-1.12-1.49-1.12-2.84 0-1.35.71-2.01.96-2.29.25-.28.55-.35.73-.35h.52c.17 0 .4-.06.62.47.24.57.8 1.97.87 2.11.07.14.12.31.02.5-.09.19-.14.31-.28.47-.14.16-.29.36-.42.48-.14.14-.28.29-.12.57.16.28.72 1.19 1.55 1.93 1.07.95 1.97 1.25 2.25 1.39.28.14.44.12.6-.07.17-.19.69-.8.87-1.08.19-.28.37-.23.63-.14.25.09 1.65.78 1.93.92.28.14.47.21.54.33.07.11.07.66-.17 1.34Z"/>',
  phone: '<path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1C10.29 21 3 13.71 3 4c0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2Z"/>',
  // Drawn with strokes, not one filled outline: a single path would need the
  // lens cut out of the body, and a wrong winding turns the mark into a blob.
  instagram: {
    stroke: true,
    body: '<rect x="3" y="3" width="18" height="18" rx="5.2"/>'
      + '<circle cx="12" cy="12" r="4"/>'
      + '<circle cx="17.3" cy="6.7" r="1.15" fill="currentColor" stroke="none"/>',
  },
  mail: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2Zm8 7.2 8-5.2H4l8 5.2ZM4 18h16V8.2l-8 5.2-8-5.2V18Z"/>',
};
const svg = name => {
  const i = ICON[name];
  const paint = i.stroke
    ? 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"'
    : 'fill="currentColor"';
  return `<svg viewBox="0 0 24 24" ${paint} aria-hidden="true">${i.body || i}</svg>`;
};

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
  const waIcon = svg('whatsapp');

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


// The contact strip closes every page. Nothing here is invented: a field with
// no value in site-content.js renders no row at all, so the page never shows
// a phone number that does not ring.
function contactHtml() {
  const t = C.contact || {};
  const wa = t.whatsappNumber
    ? `https://wa.me/${String(t.whatsappNumber).replace(/\D/g, '')}?text=`
      + encodeURIComponent(t.whatsappMessageGeneral || '')
    : '';

  const rows = [
    wa && `<a class="bid-contact__row" href="${esc(wa)}" target="_blank" rel="noopener"
       data-bid-event="contact_whatsapp">${svg('whatsapp')}<span>${esc(t.whatsappLabel || 'וואטסאפ')}</span></a>`,
    t.phone && `<a class="bid-contact__row" href="tel:${esc(String(t.phone).replace(/[^\d+]/g, ''))}"
       data-bid-event="contact_phone">${svg('phone')}<span dir="ltr">${esc(t.phone)}</span></a>`,
    t.email && `<a class="bid-contact__row" href="mailto:${esc(t.email)}"
       data-bid-event="contact_email">${svg('mail')}<span dir="ltr">${esc(t.email)}</span></a>`,
    t.instagram && `<a class="bid-contact__row" href="${esc(t.instagram)}" target="_blank" rel="noopener"
       data-bid-event="contact_instagram">${svg('instagram')}<span dir="ltr">${esc(t.instagramLabel || 'Instagram')}</span></a>`,
  ].filter(Boolean);

  if (!rows.length) return '';

  // The CTA handler reads the number from here, so there is one copy of it.
  const ctaAttrs = t.whatsappNumber && t.ctaOpensWhatsapp
    ? ` data-wa-number="${esc(String(t.whatsappNumber).replace(/\D/g, ''))}"`
      + ` data-wa-message="${esc(t.whatsappMessage || '')}"`
    : '';

  return `
<footer class="bid-section bid-contact" id="contact"${ctaAttrs}>
  <div class="bid-section__inner">
    <hr class="bid-section__rule">
    <h2>${esc(t.heading || 'דברו איתנו')}</h2>
    ${t.body ? `<p class="bid-section__lead">${esc(t.body)}</p>` : ''}
    <div class="bid-contact__rows">
${rows.map(r => '      ' + r).join('\n')}
    </div>
    <p class="bid-contact__legal">${esc(C.legalName)}</p>
  </div>
</footer>`;
}

// Crawlers render JS, but not always and not quickly, and the whole page is
// drawn by the design runtime. This is the only copy in the document that is
// readable with no JavaScript at all.
function noscriptHtml(meta) {
  const price = meta.product
    ? `<p>${esc(C.product.price)} ${C.currencySymbol || '₪'} · ${esc(C.legalName)}</p>`
    : `<p>${esc(C.legalName)}</p>`;
  return `
<noscript>
  <div class="bid-noscript">
    <h1>${esc(meta.title)}</h1>
    <p>${esc(meta.description)}</p>
    ${price}
  </div>
</noscript>`;
}

function jsonLd(meta, socialImage) {
  const items = meta.sections ? published() : [];
  const url = SITE + meta.path;
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
  ];

  if (meta.product) {
    graph.push({
      '@type': 'Product',
      '@id': SITE + '/#product',
      name: C.product.name,
      description: C.product.description,
      image: [socialImage],
      brand: { '@type': 'Brand', name: C.brand },
      // No aggregateRating until there are real reviews to aggregate.
      offers: {
        '@type': 'Offer',
        url: url,
        price: C.product.price,
        priceCurrency: C.product.currency,
        availability: 'https://schema.org/' + C.product.availability,
        seller: { '@id': SITE + '/#org' },
      },
    });
  }

  if (items.length) {
    graph.push({
      '@type': 'FAQPage',
      '@id': url + '#faq',
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

const HEAD_ADDITIONS = (meta, socialImage) => `<link rel="canonical" href="${SITE + meta.path}">
<meta property="og:url" content="${SITE + meta.path}">
<meta property="og:image:alt" content="קופסת Before I Do עם הכרטיסיות">
<meta name="robots" content="index,follow,max-image-preview:large">
<link rel="stylesheet" href="assets/site/marketing.css">
${jsonLd(meta, socialImage)}
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
function writeSiteFiles(root, report, currentPage) {
  const robots = `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`;

  // Every page on disk, plus the one being written right now (on a first
  // import it is not saved yet). 404 pages stay out by their own meta.
  const files = new Set(fs.readdirSync(root).filter(f => f.endsWith('.html')));
  files.add(currentPage);

  const urls = [...files]
    .map(pageMeta)
    .filter(m => m.sitemap)
    .sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));

  const today = new Date().toISOString().slice(0, 10);
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(m => `  <url>
    <loc>${SITE + m.path}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${m.path === '/' ? 'weekly' : 'monthly'}</changefreq>
    <priority>${m.path === '/' ? '1.0' : '0.5'}</priority>
  </url>`).join('\n')}
</urlset>
`;
  fs.writeFileSync(path.join(root, 'robots.txt'), robots);
  fs.writeFileSync(path.join(root, 'sitemap.xml'), sitemap);
  report.push(['ok', `robots.txt + sitemap.xml (${urls.length} page${urls.length > 1 ? 's' : ''})`]);
}

// Hashed filenames mean an old import's assets simply stop being mentioned.
// Nothing else will ever remove them, so this does — but only what every page
// on disk agrees is unused, and never a whole directory at once, because an
// empty match set means the pages are unreadable, not that the files are dead.
function sweepAssets(root) {
  const pages = fs.readdirSync(root).filter(f => f.endsWith('.html'));
  if (!pages.length) return [];
  const text = pages.map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');

  const removed = [];
  for (const d of ['img', 'fonts', 'js']) {
    const dir = path.join(root, 'assets', d);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir);
    const used = f => text.includes('assets/' + d + '/' + f);
    if (!files.some(used)) continue;          // safety net, see above

    for (const f of files) {
      if (used(f)) continue;
      // The original of a WebP the page does use is the source it was made
      // from — the better copy, and the only one if the export is gone.
      if (used(f.replace(/\.(png|jpe?g)$/i, '.webp'))) continue;
      fs.unlinkSync(path.join(dir, f));
      removed.push(d + '/' + f);
    }
  }
  return removed;
}

// ── the pass ────────────────────────────────────────────────────────────────
async function apply(html, opts = {}) {
  const root = opts.root || ROOT;
  const page = opts.page || 'index.html';
  const meta = pageMeta(page);
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

  // Taken from the page rather than the content file so there is one source
  // for the preview picture: whatever the import wrote into og:image.
  const ogMatch = html.match(/<meta property="og:image" content="([^"]+)"/);
  const socialImage = ogMatch ? ogMatch[1] : abs(C.product.image);

  fix('head: canonical, og:url, schema, measurement', s =>
    upsert(s, 'head', HEAD_ADDITIONS(meta, socialImage),
      (h, b) => h.replace('</head>', b + '\n</head>')));

  fix('no-JS fallback copy', s =>
    upsert(s, 'noscript', noscriptHtml(meta), (h, b) => h.replace('<body>', '<body>' + b)));

  fix(meta.sections ? 'FAQ + capture + share sections' : 'no appended sections (not the selling page)', s =>
    upsert(s, 'sections', meta.sections ? faqHtml() + closingHtml() : '',
      (h, b) => meta.sections ? h.replace('</body>', b + '\n</body>') : h));

  // Contact closes every page, selling or not.
  fix('contact strip', s =>
    upsert(s, 'contact', contactHtml(), (h, b) => h.replace('</body>', b + '\n</body>')));

  html = await optimizeImages(html, root, report);
  writeSiteFiles(root, report, page);

  const missing = meta.sections ? C.faq.filter(f => f.q && !(f.a && f.a.trim())) : [];
  return { html, report, missing };
}

module.exports = { apply, sweepAssets };

// ── standalone ──────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const only = process.argv[2];   // optional: a single page to re-fix
    const pages = fs.readdirSync(ROOT)
      .filter(f => f.endsWith('.html'))
      .filter(f => !only || f === only || f === only + '.html');

    if (!pages.length) {
      console.error(only ? `no such page: ${only}` : 'no .html pages in the project root');
      process.exit(1);
    }

    let missing = [];
    for (const page of pages) {
      const file = path.join(ROOT, page);
      const res = await apply(fs.readFileSync(file, 'utf8'), { page });
      fs.writeFileSync(file, res.html);
      missing = res.missing.length ? res.missing : missing;

      console.log(`site fixes → ${page}\n`);
      for (const [status, name] of res.report) console.log(`  ${status.padEnd(8)} ${name}`);
      console.log('');
    }

    const swept = sweepAssets(ROOT);
    if (swept.length) console.log(`swept ${swept.length} unused asset file(s):\n  ${swept.join('\n  ')}\n`);

    if (missing.length) {
      console.log(`${missing.length} FAQ answer(s) still empty — not published:`);
      for (const f of missing) console.log('  · ' + f.q);
      console.log('  fill them in tools/site-content.js and run this again.');
    }
    const cfg = path.join(ROOT, 'assets', 'site', 'config.js');
    if (/ga4Id: ''/.test(fs.readFileSync(cfg, 'utf8'))) {
      console.log('\nno analytics ID in assets/site/config.js — nothing is being measured yet.');
    }
  })();
}
