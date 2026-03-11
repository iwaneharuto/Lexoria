// api/checkout/create.js
// Stripe Checkout Session を動的生成 → Price IDを直接指定するため確実
//
// 環境変数:
//   STRIPE_SECRET_KEY = sk_live_xxxx

import Stripe from 'stripe';

// Price ID の正式な対応表
const PLAN_PRICE = {
  personal: 'price_1T8v3PAPYDSR7srNMboKV12t', // ¥9,800/月  1名
  small:    'price_1T9E61APYDSR7srNHlKLA9VT', // ¥39,800/月 最大5名
  large:    'price_1T9K14APYDSR7srN7qvPVkFr', // ¥74,900/月 最大10名
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { plan, email } = req.body || {};

  if (!PLAN_PRICE[plan]) {
    return res.status(400).json({ error: `Invalid plan: ${plan}` });
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: PLAN_PRICE[plan], quantity: 1 }],
      customer_email: email || undefined,
      success_url: `${process.env.NEXT_PUBLIC_BASE_URL || 'https://lexoriaai.com'}/?checkout=success&plan=${plan}`,
      cancel_url:  `${process.env.NEXT_PUBLIC_BASE_URL || 'https://lexoriaai.com'}/?checkout=cancel`,
      locale: 'ja',
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('[Checkout] Checkout Session 作成エラー:', err);
    return res.status(500).json({ error: err.message });
  }
}
