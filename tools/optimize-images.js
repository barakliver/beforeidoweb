// Re-encode the page images as WebP and point the built pages at them.
//
// An ad click is not a patient visitor. On a throttled phone the homepage was
// taking 7.0s to paint its largest element, and 1.7MB of the 2.0MB it pulled
// down was PNG — three card fronts, a card back, a box and a photo, all at
// print resolution for a slot a few hundred pixels wide.
//
// Runs on the built output rather than on the export, so it works without the
// design-tool zip: npm i --no-save sharp && node tools/optimize-images.js
//
// Everything below the first screen also gets loading="lazy", and the one
// image the visitor actually sees first gets fetchpriority="high" so it is not
// queued behind the ones they have not scrolled to yet.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const DIR = 'assets/img';
// Twice the largest slot any of these fills, which is all a phone can resolve.
const MAX_W = 1400;
const QUALITY = 80;
// The hero photo: first thing on screen, so it must not be lazy or deprioritised.
const EAGER = /whatsapp-image/;

const pages = fs.readdirSync('.').filter(f => f.endsWith('.html'));
const rename = new Map();

(async () => {
  let before = 0, after = 0;
  for (const file of fs.readdirSync(DIR)) {
    if (!/\.(png|jpe?g)$/i.test(file)) continue;
    const src = path.join(DIR, file);
    const out = src.replace(/\.(png|jpe?g)$/i, '.webp');
    const meta = await sharp(src).metadata();
    await sharp(src)
      .resize({ width: Math.min(meta.width, MAX_W), withoutEnlargement: true })
      .webp({ quality: QUALITY, effort: 6 })
      .toFile(out);

    const b = fs.statSync(src).size, a = fs.statSync(out).size;
    if (a >= b) { fs.unlinkSync(out); console.log('  kept  ' + file + ' (webp was bigger)'); continue; }
    before += b; after += a;
    rename.set('/' + src, '/' + out);
    console.log(`  ${file}  ${Math.round(b / 1024)}KB → ${Math.round(a / 1024)}KB  (${Math.round((1 - a / b) * 100)}% off)`);
  }

  for (const page of pages) {
    let s = fs.readFileSync(page, 'utf8'), touched = false;
    for (const [from, to] of rename) {
      if (!s.includes(from)) continue;
      s = s.split(from).join(to);
      touched = true;
    }
    // One pass over every <img> that now points at a webp.
    s = s.replace(/<img\s+src="(\/assets\/img\/[^"]+\.webp)"/g, (m, url) =>
      EAGER.test(url)
        ? `<img src="${url}" fetchpriority="high" decoding="async"`
        : `<img src="${url}" loading="lazy" decoding="async"`);
    if (touched) { fs.writeFileSync(page, s); console.log('  rewrote ' + page); }
  }

  // Only now that nothing points at them.
  for (const from of rename.keys()) {
    const orig = from.slice(1);
    const left = pages.filter(p => fs.readFileSync(p, 'utf8').includes(from));
    if (left.length) { console.log('  KEPT ' + orig + ' — still referenced by ' + left.join(', ')); continue; }
    fs.unlinkSync(orig);
  }

  console.log(`images    ${Math.round(before / 1024)}KB → ${Math.round(after / 1024)}KB ` +
              `(${Math.round((1 - after / before) * 100)}% smaller)`);
})();
