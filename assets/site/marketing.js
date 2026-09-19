/* Measurement, consent, capture and sharing.
 *
 * The design tool owns everything above; this file owns everything that has to
 * know whether the page is working. No dependencies, no build step.
 *
 * Order of operations, and the reason for it: events fire from the first
 * paint, but nothing is sent anywhere until the visitor has agreed. Until then
 * they queue in memory. Agreeing flushes the queue, so the clicks someone made
 * while the banner was still up are not lost — and refusing drops it.
 */
(function () {
  'use strict';

  var CFG = window.BID_CONFIG || {};
  var STORE_KEY = 'bid_consent';
  var hasTrackers = !!(CFG.ga4Id || CFG.metaPixelId);

  // ── consent state ────────────────────────────────────────────────────────
  function read() {
    try { return localStorage.getItem(STORE_KEY); } catch (e) { return null; }
  }
  function write(v) {
    try { localStorage.setItem(STORE_KEY, v); } catch (e) { /* private mode */ }
  }

  var consent = read();
  var queue = [];
  var loaded = false;

  // ── trackers ─────────────────────────────────────────────────────────────
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }

  function loadScript(src, attrs) {
    var s = document.createElement('script');
    s.async = true;
    s.src = src;
    for (var k in attrs || {}) s.setAttribute(k, attrs[k]);
    document.head.appendChild(s);
    return s;
  }

  function loadTrackers() {
    if (loaded) return;
    loaded = true;

    if (CFG.ga4Id) {
      loadScript('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(CFG.ga4Id));
      gtag('js', new Date());
      // Consent Mode: we only get here after a yes, but stating it keeps the
      // signal correct if Google's own defaults change under us.
      gtag('consent', 'default', {
        ad_storage: 'denied', analytics_storage: 'denied',
        ad_user_data: 'denied', ad_personalization: 'denied',
      });
      gtag('consent', 'update', {
        ad_storage: 'granted', analytics_storage: 'granted',
        ad_user_data: 'granted', ad_personalization: 'granted',
      });
      gtag('config', CFG.ga4Id, { send_page_view: true });
    }

    if (CFG.metaPixelId) {
      /* eslint-disable */
      !function (f, b, e, v, n, t, s) {
        if (f.fbq) return; n = f.fbq = function () {
          n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
        };
        if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
        t = b.createElement(e); t.async = !0; t.src = v;
        s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
      }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
      /* eslint-enable */
      window.fbq('init', CFG.metaPixelId);
      window.fbq('track', 'PageView');
      window.fbq('track', 'ViewContent', {
        content_name: 'Before I Do', content_type: 'product',
      });
    }

    while (queue.length) send(queue.shift());
  }

  // ── events ───────────────────────────────────────────────────────────────
  function send(ev) {
    window.dataLayer.push(Object.assign({ event: ev.name }, ev.params));
    if (CFG.ga4Id && window.gtag) window.gtag('event', ev.name, ev.params);
    if (CFG.metaPixelId && window.fbq) {
      if (ev.meta) window.fbq('track', ev.meta, ev.params);
      else window.fbq('trackCustom', ev.name, ev.params);
    }
  }

  function track(name, params, metaStandardEvent) {
    var ev = { name: name, params: params || {}, meta: metaStandardEvent };
    if (!hasTrackers) return;              // nothing configured — do not queue
    if (consent !== 'granted') {
      if (queue.length < 50) queue.push(ev);
      return;
    }
    send(ev);
  }
  window.bidTrack = track;                  // for anything added later

  // ── what we watch ────────────────────────────────────────────────────────
  // Matched on visible text, not on the design tool's class names, so a
  // re-export from the design does not silently stop the measurement.
  var CTA = [
    { text: 'אני רוצה את המשחק', name: 'purchase_intent', meta: 'InitiateCheckout' },
    { text: 'מצאתי מתנה', name: 'purchase_intent', meta: 'InitiateCheckout' },
    { text: 'מה יש בקופסה', name: 'learn_more' },
    { text: 'תראו לי מה בפנים', name: 'learn_more' },
    { text: 'איך משחקים', name: 'learn_more' },
    { text: 'לזוג', name: 'route_toggle' },
    { text: 'למתנה', name: 'route_toggle' },
  ];

  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest && e.target.closest('button, a, [data-bid-event]');
    if (!el) return;

    var custom = el.getAttribute && el.getAttribute('data-bid-event');
    if (custom) { track(custom, { label: (el.textContent || '').trim().slice(0, 60) }); return; }

    var text = (el.textContent || '').trim();
    for (var i = 0; i < CTA.length; i++) {
      if (text === CTA[i].text) {
        track(CTA[i].name, { label: text, position: sectionOf(el) }, CTA[i].meta);
        return;
      }
    }
    if (el.closest('#deck')) track('card_flip', {});
  }, true);

  function sectionOf(el) {
    var y = 0, n = el;
    while (n) { y += n.offsetTop || 0; n = n.offsetParent; }
    var h = document.documentElement.scrollHeight || 1;
    return y < h * 0.34 ? 'hero' : y < h * 0.7 ? 'middle' : 'product';
  }

  // Scroll depth — the cheapest read on whether the page holds anyone.
  var marks = [25, 50, 75, 100], hit = {};
  addEventListener('scroll', function () {
    var d = document.documentElement;
    var pct = (d.scrollTop + innerHeight) / (d.scrollHeight || 1) * 100;
    for (var i = 0; i < marks.length; i++) {
      if (pct >= marks[i] && !hit[marks[i]]) {
        hit[marks[i]] = 1;
        track('scroll_depth', { percent: marks[i] });
      }
    }
  }, { passive: true });

  // ── consent banner ───────────────────────────────────────────────────────
  function banner() {
    if (!hasTrackers || consent) return;    // nothing to ask about, or answered

    var wrap = document.createElement('div');
    wrap.className = 'bid-consent';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-live', 'polite');
    wrap.setAttribute('aria-label', 'הסכמה לשימוש בעוגיות');

    var policy = CFG.cookiePolicyUrl
      ? ' <a href="' + CFG.cookiePolicyUrl + '">מדיניות העוגיות</a>.'
      : '';
    wrap.innerHTML =
      '<p class="bid-consent__text">אנחנו משתמשים בעוגיות כדי להבין מה עובד בדף הזה.' +
      ' בלי הסכמה שלכם לא נטען כלום.' + policy + '</p>' +
      '<div class="bid-consent__actions">' +
      '<button type="button" class="bid-btn bid-btn--ghost" data-consent="denied">לא תודה</button>' +
      '<button type="button" class="bid-btn" data-consent="granted">מאשר/ת</button>' +
      '</div>';

    wrap.addEventListener('click', function (e) {
      var b = e.target.closest('[data-consent]');
      if (!b) return;
      consent = b.getAttribute('data-consent');
      write(consent);
      wrap.remove();
      if (consent === 'granted') loadTrackers(); else queue.length = 0;
    });

    document.body.appendChild(wrap);
  }

  // ── reminder form ────────────────────────────────────────────────────────
  function leadForm() {
    var form = document.getElementById('bid-lead-form');
    if (!form) return;
    if (!CFG.leadEndpoint) {
      // No endpoint means no inbox. Hide it rather than collect into nothing,
      // and let the share half have the whole band to itself.
      var block = document.getElementById('bid-lead');
      if (block) {
        block.hidden = true;
        var grid = block.parentElement;
        if (grid) grid.classList.add('bid-closing__grid--single');
      }
      return;
    }
    form.hidden = false;

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var status = document.getElementById('bid-lead-status');
      var email = form.elements.email.value.trim();
      if (!email) return;

      var body = Object.assign({}, CFG.leadExtraFields, {
        email: email,
        source: 'beforeidoweb',
        page: location.pathname + location.search,
      });

      var btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;

      fetch(CFG.leadEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      }).then(function (r) {
        if (!r.ok) throw new Error(r.status);
        form.hidden = true;
        status.textContent = form.getAttribute('data-thanks');
        track('lead_submit', {}, 'Lead');
      }).catch(function () {
        btn.disabled = false;
        status.textContent = form.getAttribute('data-error');
      });
    });
  }

  // ── share ────────────────────────────────────────────────────────────────
  function share() {
    var copy = document.getElementById('bid-share-copy');
    if (!copy) return;
    copy.addEventListener('click', function () {
      var url = copy.getAttribute('data-url') || location.href;
      var done = function () {
        var was = copy.textContent;
        copy.textContent = copy.getAttribute('data-copied');
        setTimeout(function () { copy.textContent = was; }, 2200);
      };
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, done);
      else done();
    });
  }

  // ── boot ─────────────────────────────────────────────────────────────────
  function start() {
    if (consent === 'granted') loadTrackers();
    banner();
    leadForm();
    share();
    track('page_engaged', { route: location.search.indexOf('gift') > -1 ? 'gift' : 'couple' });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
