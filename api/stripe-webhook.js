// api/stripe-webhook.js
// Stripe Webhook: サブスク契約イベントで管理者にメール通知
//
// 環境変数:
//   STRIPE_SECRET_KEY      = sk_xxx
//   STRIPE_WEBHOOK_SECRET  = whsec_xxx
//   RESEND_API_KEY         = re_xxx（Resend で通知メール送信）
//   FROM_EMAIL             = noreply@lexoriaai.com
//   ADMIN_NOTIFY_EMAIL     = 管理者のメール（通知先）

import Stripe from 'stripe';

export const config = {
  api: { bodyParser: false },
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

import { buildPriceToUiPlanMap } from '../lib/stripe/priceIds.js';
const PRICE_TO_PLAN = buildPriceToUiPlanMap();

function getPlanFromPriceId(priceId) {
  return PRICE_TO_PLAN[priceId] || priceId || '—';
}

/** イベントから通知用本文テキストを組み立て */
async function buildNotificationBody(event, stripe) {
  const type = event.type;
  const created = event.created ? new Date(event.created * 1000).toISOString() : '—';
  let customerEmail = '';
  let customerId = '';
  let subscriptionId = '';
  let planOrPriceId = '';
  let amount = '';

  switch (type) {
    case 'checkout.session.completed': {
      const s = event.data.object;
      customerEmail = s.customer_email || s.customer_details?.email || '—';
      customerId = s.customer || '—';
      subscriptionId = s.subscription || '—';
      if (s.amount_total != null) amount = `¥${(s.amount_total / 100).toLocaleString()}`;
      if (s.line_items?.data?.[0]?.price?.id) planOrPriceId = getPlanFromPriceId(s.line_items.data[0].price.id) + ' / ' + s.line_items.data[0].price.id;
      else planOrPriceId = '—';
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      customerId = sub.customer || '—';
      subscriptionId = sub.id || '—';
      const item = sub.items?.data?.[0];
      if (item?.price) {
        planOrPriceId = getPlanFromPriceId(item.price.id) + ' / ' + item.price.id;
        if (item.price.unit_amount != null) amount = `¥${(item.price.unit_amount / 100).toLocaleString()}/月`;
      } else planOrPriceId = '—';
      if (sub.customer) {
        const c = await stripe.customers.retrieve(sub.customer);
        customerEmail = (c && c.email) ? c.email : '—';
      }
      return [
        `Event: ${type}`,
        `Customer email: ${customerEmail || '—'}`,
        `Customer id: ${customerId}`,
        `Subscription id: ${subscriptionId}`,
        `Plan / Price id: ${planOrPriceId}`,
        `Amount: ${amount || '—'}`,
        `Created time: ${created}`,
      ].join('\n');
    }
    case 'invoice.paid': {
      const inv = event.data.object;
      customerEmail = inv.customer_email || '—';
      customerId = inv.customer || '—';
      subscriptionId = inv.subscription || '—';
      amount = inv.amount_paid != null ? `¥${(inv.amount_paid / 100).toLocaleString()}` : '—';
      const line = inv.lines?.data?.[0];
      if (line?.price?.id) planOrPriceId = getPlanFromPriceId(line.price.id) + ' / ' + line.price.id;
      else planOrPriceId = '—';
      break;
    }
    default:
      return `Event: ${type}\nCreated time: ${created}`;
  }

  return [
    `Event: ${type}`,
    `Customer email: ${customerEmail}`,
    `Customer id: ${customerId}`,
    `Subscription id: ${subscriptionId}`,
    `Plan / Price id: ${planOrPriceId}`,
    `Amount: ${amount || '—'}`,
    `Created time: ${created}`,
  ].join('\n');
}

/** Resend で管理者に通知メール送信。Idempotency-Key に event.id を指定して同一イベントの二重送信を防止 */
async function sendAdminNotification(eventId, eventType, body) {
  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.FROM_EMAIL || 'noreply@lexoriaai.com';
  const adminEmail = process.env.ADMIN_NOTIFY_EMAIL;

  if (!adminEmail) {
    console.warn('[stripe-webhook] ADMIN_NOTIFY_EMAIL 未設定 - 通知スキップ');
    return { ok: false, reason: 'ADMIN_NOTIFY_EMAIL not set' };
  }
  if (!resendKey) {
    console.warn('[stripe-webhook] RESEND_API_KEY 未設定 - 通知スキップ');
    return { ok: false, reason: 'RESEND_API_KEY not set' };
  }

  const subject = `[Lexoria] Stripe: ${eventType}`;
  const html = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;padding:20px">
  <h2>Stripe サブスク通知</h2>
  <pre style="background:#f5f5f5;padding:16px;border-radius:8px;white-space:pre-wrap">${body.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
  <p style="color:#666;font-size:12px">event.id: ${eventId}</p>
</body></html>`;

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${resendKey}`,
    'Idempotency-Key': eventId,
  };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      from: `Lexoria <${fromEmail}>`,
      to: [adminEmail],
      subject,
      html,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[stripe-webhook] Resend error', { status: res.status, eventId, eventType, data });
    return { ok: false, reason: data.message || res.statusText };
  }
  return { ok: true, id: data.id };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

  if (!webhookSecret) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET が未設定');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }
  if (!stripeSecretKey) {
    console.error('[stripe-webhook] STRIPE_SECRET_KEY が未設定');
    return res.status(500).json({ error: 'Stripe secret key not configured' });
  }

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (err) {
    console.error('[stripe-webhook] body read error', { eventType: '-', eventId: '-', error: err.message });
    return res.status(400).json({ error: 'Failed to read body' });
  }

  const signature = req.headers['stripe-signature'];
  let event;
  try {
    const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error('[stripe-webhook] signature verification failed', { eventType: '-', eventId: '-', error: err.message });
    return res.status(400).json({ error: `Signature verification failed: ${err.message}` });
  }

  const eventType = event.type;
  const eventId = event.id;

  const allowed = [
    'checkout.session.completed',
    'customer.subscription.created',
    'customer.subscription.updated',
    'invoice.paid',
  ];
  if (!allowed.includes(eventType)) {
    console.log('[stripe-webhook] event ignored', { eventType, eventId });
    return res.status(200).json({ received: true, type: eventType });
  }

  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  try {
    const body = await buildNotificationBody(event, stripe);
    const notify = await sendAdminNotification(eventId, eventType, body);

    if (notify.ok) {
      console.log('[stripe-webhook] notify success', { eventType, eventId });
    } else {
      console.warn('[stripe-webhook] notify failure', { eventType, eventId, reason: notify.reason });
    }

    return res.status(200).json({ received: true, type: eventType, notified: notify.ok });
  } catch (err) {
    console.error('[stripe-webhook] failure', { eventType, eventId, error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
}
