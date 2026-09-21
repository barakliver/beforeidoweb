// Notify Barak the moment someone starts paying — and keep the ones who don't.
//
// Two kinds of beacon arrive here, told apart by `stage`:
//
//   pay        the customer pressed the pay button. The checkout collects the
//              address and the pickup point; Grow collects only name, phone
//              and email, so without this a paid order arrives with nowhere
//              to ship it.
//   abandoned  the customer filled something in and left without pressing it.
//              Same details, as far as they got, plus how far that was and
//              where they came from.
//
// "On the way" is the catch for an order: it fires when the customer clicks
// pay, not when the money lands, so a message means an order was STARTED.
// Payment itself is confirmed by Grow. Every message says which it is.
//
// An abandonment is a snapshot, not a verdict: a visitor who switches tabs and
// comes back to buy produces one of each. The order is the one that counts.
//
// Configure in Vercel → Settings → Environment Variables. Anything missing is
// skipped, and checkout is never blocked by a failure here.
//   RESEND_API_KEY     email  (resend.com, free tier)
//   ORDER_EMAIL_TO     where to send        default barakliver@gmail.com
//   ORDER_EMAIL_FROM   verified sender      default onboarding@resend.dev
//   GREENAPI_ID        WhatsApp via green-api.com: instance id
//   GREENAPI_TOKEN     …and its API token
//   GREENAPI_URL       …and its apiUrl, which is per-instance (the console
//                      shows e.g. https://7107.api.greenapi.com). Defaults to
//                      the shared host, which does not serve every instance.
//   WHATSAPP_WEBHOOK   or any URL of your own taking {phone, message}
//   WHATSAPP_TO        who to notify, international format, default 972526604320
//   WHATSAPP_CHAT_ID   …or a chat id verbatim, which overrides WHATSAPP_TO.
//                      Use a group (…@g.us) to avoid WhatsApp's "message
//                      yourself" chat, which arrives without a notification.
//   WHATSAPP_LEADS_CHAT_ID  where abandoned checkouts go. Point it at a second
//                      group to keep them out of the orders one; unset, they
//                      arrive in the same place, marked.

const EMAIL_TO = process.env.ORDER_EMAIL_TO || 'barakliver@gmail.com';
const EMAIL_FROM = process.env.ORDER_EMAIL_FROM || 'Before I Do <onboarding@resend.dev>';
const WA_TO = process.env.WHATSAPP_TO || '972526604320';
// A number needs the @c.us suffix; a group id already carries @g.us.
const WA_CHAT = process.env.WHATSAPP_CHAT_ID || `${WA_TO}@c.us`;
const WA_LEADS_CHAT = process.env.WHATSAPP_LEADS_CHAT_ID || WA_CHAT;

const esc = v => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Never echo more than the form can hold; a beacon is an open endpoint.
const clip = (v, n = 120) => String(v == null ? '' : v).slice(0, n).trim();

// Which of the checkout's three steps they got to. On an abandonment this is
// the whole story: a name and nothing else is a different problem from a full
// address that stopped at the pay button.
const STEPS = { 1: 'פרטים אישיים', 2: 'איך מקבלים', 3: 'מסך התשלום' };

const duration = s => {
  const n = Number(s) || 0;
  return n < 60 ? `${n} שניות` : `${Math.floor(n / 60)} דק׳ ${n % 60} שנ׳`;
};

// A referrer is a URL from an open endpoint; only its host is worth repeating.
const origin = u => { try { return new URL(String(u)).hostname.replace(/^www\./, ''); } catch { return ''; } };

function summarize(o, abandoned) {
  const delivery = o.method === 'ship'
    ? `משלוח — ${clip(o.street)} ${clip(o.houseNo, 12)}, ${clip(o.city, 40)}`
    : o.method === 'self'
      ? `איסוף עצמי — ${o.point === 'hod' ? 'הוד השרון' : 'גבעת שמואל'}`
      : 'לא נבחר';
  const rows = [
    ['שם', clip(o.name) || '—'],
    ['טלפון', clip(o.phone, 20) || '—'],
    ['קבלה', delivery],
    ['הערות', clip(o.notes, 300) || '—'],
    ['סכום', `${Number(o.total) || 0} ₪`],
    ['דיוור', o.marketing ? 'כן, אישר/ה' : 'לא'],
  ];
  if (abandoned) {
    rows.push(
      ['הגיע/ה עד', STEPS[Number(o.step)] || '—'],
      ['זמן בקופה', duration(o.seconds)],
      ['מכשיר', clip(o.device, 40) || '—'],
      ['הגיע/ה מ', origin(o.source) || 'ישירות'],
    );
    if (clip(o.utm, 120)) rows.push(['קמפיין', clip(o.utm, 120)]);
  }
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

async function sendWhatsApp(o, rows, abandoned) {
  // A tap-to-call link on the customer's number, so the message is also the
  // fastest way to reach them. On an abandonment that is the entire point.
  const digits = String(o.phone || '').replace(/\D/g, '').replace(/^0/, '972');
  const message = [
    abandoned ? '🟡 נטישה בקופה — Before I Do' : '🎉 הזמנה חדשה — Before I Do', '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    digits.length > 8 ? `\nלחיוג: wa.me/${digits}` : '',
    '',
    abandoned
      ? 'מילא/ה פרטים ויצא/ה בלי ללחוץ על תשלום. אם ההזמנה תיסגר בכל זאת — תגיע הודעה נפרדת.'
      : '⚠️ התחילה סליקה — לאשר תשלום מול Grow לפני משלוח.',
  ].filter(Boolean).join('\n');

  const chatId = abandoned ? WA_LEADS_CHAT : WA_CHAT;

  const { GREENAPI_ID, GREENAPI_TOKEN, WHATSAPP_WEBHOOK } = process.env;

  if (GREENAPI_ID && GREENAPI_TOKEN) {
    const base = (process.env.GREENAPI_URL || 'https://api.green-api.com').replace(/\/+$/, '');
    const url = `${base}/waInstance${GREENAPI_ID}/sendMessage/${GREENAPI_TOKEN}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId, message }),
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

  const abandoned = order.stage === 'abandoned';
  const { rows } = summarize(order, abandoned);

  // The record, whatever the messaging does: one line per beacon in the
  // function log, so a month of leads can be read back and exported.
  console.log('BID_LEAD ' + JSON.stringify({
    at: new Date().toISOString(),
    stage: abandoned ? 'abandoned' : 'pay',
    ...Object.fromEntries(rows),
  }));

  // Email is for orders only — an inbox full of near-misses stops being read.
  // Settled, not all: one channel failing must not lose the other.
  const [email, whatsapp] = await Promise.allSettled([
    abandoned ? Promise.resolve('skipped (abandoned)') : sendEmail(order, rows),
    sendWhatsApp(order, rows, abandoned),
  ]);
  const out = {
    stage: abandoned ? 'abandoned' : 'pay',
    email: email.status === 'fulfilled' ? email.value : `error ${email.reason}`,
    whatsapp: whatsapp.status === 'fulfilled' ? whatsapp.value : `error ${whatsapp.reason}`,
  };
  console.log('order notification', JSON.stringify(out));
  // Always 200: the customer is already on their way to the payment page and
  // must never see an error because a notification did not go out.
  res.status(200).json(out);
}
