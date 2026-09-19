/* Measurement and capture — the only file you need to touch to turn them on.
 *
 * Everything here is off until it is filled in: no ID means no tracker loads,
 * and no consent banner is shown for trackers that do not exist. Nothing here
 * runs before the visitor agrees.
 */
window.BID_CONFIG = {
  // Google Analytics 4 — the "G-XXXXXXXXXX" from Admin › Data Streams.
  ga4Id: '',

  // Meta (Facebook/Instagram) Pixel — the 15-16 digit ID from Events Manager.
  // This is also what makes remarketing to engaged couples possible later.
  metaPixelId: '',

  // Where the reminder form posts. Any endpoint that accepts a JSON POST:
  // Formspree (https://formspree.io/f/xxxx), Web3Forms, a Google Apps Script
  // web app, Mailchimp via Zapier — all fine. Empty hides the form entirely,
  // because a form that silently drops emails is worse than no form.
  leadEndpoint: '',

  // Extra fields sent with every lead, e.g. { access_key: '...' } for Web3Forms.
  leadExtraFields: {},

  // Optional: link shown in the cookie banner once the policy page exists.
  cookiePolicyUrl: '',
};
