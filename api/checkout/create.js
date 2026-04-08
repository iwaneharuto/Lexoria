// api/checkout/create.js
// Stripe Checkout Session を動的生成 → Price IDを直接指定するため確実
//
// 環境変数:
//   STRIPE_SECRET_KEY = sk_live_xxxx

import Stripe from 'stripe';

import { resolvePriceId } from '../../lib/stripe/priceIds.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { plan, email, jurisdiction, billingCycle, trial } = req.body || {};
  console.log('[checkout/create] request', {
    plan: plan || null,
    billingCycle: billingCycle || null,
    jurisdiction: jurisdiction || null,
    hasEmail: Boolean(email),
    trial: Boolean(trial),
  });
  const resolved = resolvePriceId({ jurisdiction, uiPlan: plan, billingCycle });
  if (!resolved.ok) {
    console.warn('[checkout/create] resolvePriceId failed', { error: resolved.error, plan, billingCycle, jurisdiction });
    return res.status(400).json({ error: resolved.error });
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  try {
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://lexoriaai.com';
    const locale = resolved.jurisdiction === 'US' ? 'en' : 'ja';
    // Free trial via Stripe should only be used when explicitly requested.
    // Normal paid continuation after an in-app trial should not add another Stripe trial.
    const subscriptionData =
      resolved.jurisdiction === 'US' && trial === true ? { trial_period_days: 7 } : {};
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: resolved.priceId, quantity: 1 }],
      customer_email: email || undefined,
      subscription_data: subscriptionData,
      success_url: `${baseUrl}/?checkout=success&plan=${encodeURIComponent(plan||'')}&jurisdiction=${encodeURIComponent(resolved.jurisdiction)}&billingCycle=${encodeURIComponent(resolved.cycle)}`,
      cancel_url:  `${baseUrl}/?checkout=cancel&jurisdiction=${encodeURIComponent(resolved.jurisdiction)}`,
      locale,
    });

    console.log('[checkout/create] session created', {
      priceId: resolved.priceId,
      resolvedJurisdiction: resolved.jurisdiction,
      resolvedCycle: resolved.cycle,
      hasUrl: Boolean(session && session.url),
    });
    return res.status(200).json({
      url: session.url,
      priceId: resolved.priceId,
      resolvedCycle: resolved.cycle,
      resolvedJurisdiction: resolved.jurisdiction,
    });
  } catch (err) {
    console.error('[Checkout] Checkout Session 作成エラー:', err);
    return res.status(500).json({ error: err.message });
  }
}
