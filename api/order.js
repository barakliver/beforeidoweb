// Notify Barak the moment someone starts paying.
//
// The checkout collects the address and the pickup point; Grow collects only
// name, phone and email. So without this, a paid order arrives with nowhere to
// ship it. The checkout beacons the order here on the way to the payment page.
//
// "On the way" is the catch: this fires when the customer clicks pay, not when
// the money lands, so a message here means an order was STARTED. Payment
// itself is confirmed by Grow. Every message says which it is.
//
// Configure in Vercel → Settings → Environment Variables. Anything missing is
// skipped, and checkout is never blocked by a failure here.
//   RESEND_API_KEY     email  (resend.com, free tier)
//   ORDER_EMAIL_TO     where to send        default barakliver@gmail.com
//   ORDER_EMAIL_FROM   verified sender      default onboarding@resend.dev
//   GREENAPI_ID        WhatsApp via green-api.com: instance id
//   GREENAPI_TOKEN     …and its API token
//   WHATSAPP_WEBHOOK   or any URL of your own taking {phone, message}
//   WHATSAPP_TO        who to notify, international format, default 972526604320

const EMAIL_TO = process.env.ORDER_EMAIL_TO || 'barakliver@gmail.com';
const EMAIL_FROM = process.env.ORDER_EMAIL_FROM || 'Before I Do <onboarding@resend.dev>';
const WA_TO = process.env.WHATSAPP_TO || '972526604320';

const esc = v => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Never echo more than the form can hold; a beacon is an open endpoint.
const clip = (v, n = 120) => String(v == null ? '' : v).slice(0, n).trim();

function summarize(o) {
  const delivery = o.method === 'ship'
    ? `משלוח — ${clip(o.street)} ${clip(o.houseNo, 12)}, ${clip(o.city, 40)}`
    : o.method === 'self'
      ? `איסוף עצמי — ${o.point === 'hod' ? 'הוד השרון' : 'גבעת שמואל'}`
      : 'לא נבחר';
  const rows = [
    ['שם', clip(o.name)],
    ['טלפון', clip(o.phone, 20)],
    ['קבלה', delivery],
    ['הערות', clip(o.notes, 300) || '—'],
    ['סכום', `${Number(o.total) || 0} ₪`],
    ['דיוור', o.marketing ? 'כן, אישר/ה' : 'לא'],
  ];
  return { delivery, rows };
}

async function sendEmail(o, rows) {
  if (!process.env.RESEND_API_KEY) return 'skipped (no RESEND_API_KEY)';
  const html = `<div dir="rtl" style="font-family:Arial,sans-serif;color:#2F3F63">
    <h2 style="color:#4F6BA5;margin:0 0 4px">הזמנה חדשה — Before I Do</h2>
    <p style="margin:0 0 16px;color:#EF453D"><strong>התחילה סליקה. לאשר תשלום מול Grow לפני משלוח.</strong></p>
    <table cellpadding="7" style="border-collapse:collapse;font-size:15px">
      ${rows.map(([k, v]) => `<tr><td style="background:#F1F4F9;font-weight:bold">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}
    </table></div>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: EMAIL_FROM, to: [EMAIL_TO], subject: `הזמנה חדשה — ${clip(o.name)} — ${Number(o.total) || 0} ₪`, html }),
  });
  return r.ok ? 'sent' : `failed ${r.status} ${clip(await r.text(), 200)}`;
}

async function sendWhatsApp(o, rows) {
  // A tap-to-call link on the customer's number, so the message is also the
  // fastest way to reach them.
  const digits = String(o.phone || '').replace(/\D/g, '').replace(/^0/, '972');
  const message = [
    '🎉 הזמנה חדשה — Before I Do', '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    digits.length > 8 ? `\nלחיוג: wa.me/${digits}` : '',
    '', '⚠️ התחילה סליקה — לאשר תשלום מול Grow לפני משלוח.',
  ].filter(Boolean).join('\n');

  const { GREENAPI_ID, GREENAPI_TOKEN, WHATSAPP_WEBHOOK } = process.env;

  if (GREENAPI_ID && GREENAPI_TOKEN) {
    const url = `https://api.green-api.com/waInstance${GREENAPI_ID}/sendMessage/${GREENAPI_TOKEN}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: `${WA_TO}@c.us`, message }),
    });
    // Green API answers 200 with an error body when the instance is not
    // authorized, so the body decides, not the status.
    const body = await r.text();
    if (r.ok && /idMessage/.test(body)) return 'sent';
    return `failed ${r.status} ${clip(body, 160)}`;
  }

  if (WHATSAPP_WEBHOOK) {
    const r = await fetch(WHATSAPP_WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: WA_TO, message }),
    });
    return r.ok ? 'sent' : `failed ${r.status}`;
  }

  return 'skipped (no GREENAPI_ID/GREENAPI_TOKEN or WHATSAPP_WEBHOOK)';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  let order = req.body;
  if (typeof order === 'string') { try { order = JSON.parse(order); } catch { order = null; } }
  if (!order || typeof order !== 'object') return res.status(400).json({ error: 'bad body' });

  const { rows } = summarize(order);
  // Settled, not all: one channel failing must not lose the other.
  const [email, whatsapp] = await Promise.allSettled([sendEmail(order, rows), sendWhatsApp(order, rows)]);
  const out = {
    email: email.status === 'fulfilled' ? email.value : `error ${email.reason}`,
    whatsapp: whatsapp.status === 'fulfilled' ? whatsapp.value : `error ${whatsapp.reason}`,
  };
  console.log('order notification', JSON.stringify(out));
  // Always 200: the customer is already on their way to the payment page and
  // must never see an error because a notification did not go out.
  res.status(200).json(out);
}
