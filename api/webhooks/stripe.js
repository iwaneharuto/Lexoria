// api/webhooks/stripe.js
// Stripe Webhook ハンドラー（Vercel Serverless Function）
//
// 環境変数（Vercel Dashboard > Settings > Environment Variables に追加）:
//   STRIPE_WEBHOOK_SECRET = whsec_zeUrGeuXNy3PGMIJDRO37KLIQOcDeHSw
//   STRIPE_SECRET_KEY     = sk_live_xxxx（Stripeダッシュボードから取得）
//
// 処理するイベント:
//   checkout.session.completed       → 初回購入完了・プラン有効化
//   customer.subscription.created    → サブスク作成
//   customer.subscription.updated    → プラン変更・更新
//   customer.subscription.deleted    → 解約完了
//   invoice.paid                     → 更新決済成功
//   invoice.payment_failed           → 決済失敗

import Stripe from 'stripe';
import { buildPriceToUiPlanMap } from '../../lib/stripe/priceIds.js';
import { getStoredUser, putStoredUser, normalizeEmail } from '../../lib/authStore.js';

// Vercel はデフォルトでリクエストボディをパースするが、
// Stripe 署名検証には生のバイト列が必要なため bodyParser を無効化
export const config = {
  api: {
    bodyParser: false,
  },
};

// リクエストボディを Buffer として取得するヘルパー
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Price ID → UI plan（lib/stripe/priceIds.js の現行 ID + 旧 US Webhook 用レガシー）
// 確認: Dashboard → 商品 → 各 Price の ID、または `stripe prices list`
const PRICE_TO_PLAN = buildPriceToUiPlanMap();
const PLAN_TO_SEAT_LIMIT = Object.freeze({
  personal: 2, // Starter
  small: 5,    // Standard
  large: 10,   // Pro
});

function resolveBillingCycleFromPrice(price) {
  const interval = price?.recurring?.interval;
  return interval === 'year' ? 'yearly' : 'monthly';
}

// プランを解決（price.idベースのみ）
function resolvePlanFromSubscription(subscription) {
  const item  = subscription?.items?.data?.[0];
  const price = item?.price;
  if (!price?.id) return null;
  return PRICE_TO_PLAN[price.id] || null;
}

function resolveBillingSnapshot(subscription, customerId) {
  const item = subscription?.items?.data?.[0];
  const price = item?.price || null;
  const plan = resolvePlanFromSubscription(subscription);
  if (!plan) return null;
  return {
    plan,
    billingCycle: resolveBillingCycleFromPrice(price),
    seatLimit: PLAN_TO_SEAT_LIMIT[plan] || 0,
    subscriptionStatus: String(subscription?.status || ''),
    stripeSubscriptionId: String(subscription?.id || ''),
    stripeCustomerId: String(customerId || subscription?.customer || ''),
    currentPeriodEnd: subscription?.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : null,
  };
}

async function saveBillingStateByEmail(email, snapshot) {
  const em = normalizeEmail(email);
  if (!em) return { ok: false, reason: 'email_not_found' };
  const user = await getStoredUser(em);
  if (!user) {
    console.warn('[Webhook] DB user not found for billing update:', em);
    return { ok: false, reason: 'user_not_found' };
  }
  const next = {
    ...user,
    plan: snapshot.plan,
    billingCycle: snapshot.billingCycle,
    seatLimit: snapshot.seatLimit,
    subscriptionStatus: snapshot.subscriptionStatus,
    stripeSubscriptionId: snapshot.stripeSubscriptionId,
    stripeCustomerId: snapshot.stripeCustomerId,
    currentPeriodEnd: snapshot.currentPeriodEnd,
    updated_at: new Date().toISOString(),
  };
  await putStoredUser(em, next);
  return { ok: true };
}

// メインハンドラー
export default async function handler(req, res) {
  // ── POSTのみ受け付け ──────────────────────────────────────────
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── 環境変数チェック ──────────────────────────────────────────
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

  if (!webhookSecret) {
    console.error('[Webhook] STRIPE_WEBHOOK_SECRET が未設定');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }
  if (!stripeSecretKey) {
    console.error('[Webhook] STRIPE_SECRET_KEY が未設定');
    return res.status(500).json({ error: 'Stripe secret key not configured' });
  }

  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  // ── 生のリクエストボディ取得 ──────────────────────────────────
  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (err) {
    console.error('[Webhook] ボディ取得失敗:', err);
    return res.status(400).json({ error: 'Failed to read request body' });
  }

  // ── Stripe 署名検証 ───────────────────────────────────────────
  const signature = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error('[Webhook] 署名検証失敗:', err.message);
    return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
  }

  console.log(`[Webhook] イベント受信: ${event.type} (${event.id})`);

  // ── イベント処理 ──────────────────────────────────────────────
  try {
    switch (event.type) {

      // ── 初回購入完了 ─────────────────────────────────────────
      case 'checkout.session.completed': {
        const session = event.data.object;
        const customerEmail = session.customer_email || session.customer_details?.email;
        const customerId    = session.customer;
        const subscriptionId = session.subscription;

        if (!customerEmail) {
          console.warn('[Webhook] checkout.session.completed: メールアドレスなし', session.id);
          break;
        }

        // サブスクリプション詳細を取得して price.id ベースでプランを特定しDB保存
        let snapshot = null;
        if (subscriptionId) {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['items.data.price'] });
          snapshot = resolveBillingSnapshot(subscription, customerId);
        }
        if (!snapshot) {
          console.error('[Webhook] checkout.session.completed: unknown or missing price.id', {
            sessionId: session.id,
            customerEmail,
            subscriptionId,
          });
          break;
        }
        const dbRes = await saveBillingStateByEmail(customerEmail, snapshot);

        console.log('[Webhook] 購入完了/DB更新', {
          email: customerEmail,
          plan: snapshot.plan,
          billingCycle: snapshot.billingCycle,
          seatLimit: snapshot.seatLimit,
          subscriptionStatus: snapshot.subscriptionStatus,
          subscriptionId: snapshot.stripeSubscriptionId,
          customerId: snapshot.stripeCustomerId,
          currentPeriodEnd: snapshot.currentPeriodEnd,
          dbUpdated: dbRes.ok,
        });

        break;
      }

      // ── サブスクリプション作成 ────────────────────────────────
      case 'customer.subscription.created': {
        const subscription = event.data.object;
        const customerId   = subscription.customer;
        const snapshot     = resolveBillingSnapshot(subscription, customerId);
        const status       = subscription.status; // active / trialing / incomplete 等

        console.log(`[Webhook] サブスク作成: customer=${customerId} plan=${snapshot ? snapshot.plan : '-'} status=${status}`);

        // メールアドレスをcustomerIdから取得
        const customer = await stripe.customers.retrieve(customerId);
        const email    = customer.email;
        if (email && snapshot) {
          await saveBillingStateByEmail(email, snapshot);
          console.log(`[Webhook] → ユーザー: ${email} プラン有効化: ${snapshot.plan}`);
        }

        break;
      }

      // ── サブスクリプション更新（プラン変更・更新日迎え） ────────
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const customerId   = subscription.customer;
        const snapshot     = resolveBillingSnapshot(subscription, customerId);
        const status       = subscription.status;
        const cancelAtEnd  = subscription.cancel_at_period_end;

        console.log(`[Webhook] サブスク更新: customer=${customerId} plan=${snapshot ? snapshot.plan : '-'} status=${status} cancelAtEnd=${cancelAtEnd}`);

        const customer = await stripe.customers.retrieve(customerId);
        const email    = customer.email;
        if (email && snapshot) {
          await saveBillingStateByEmail(email, snapshot);
          if (status === 'active' && !cancelAtEnd) {
            console.log(`[Webhook] → ${email} プラン更新: ${snapshot.plan}`);
          } else if (cancelAtEnd) {
            console.log(`[Webhook] → ${email} 解約予約済み（期間末に停止）`);
          }
        }

        break;
      }

      // ── サブスクリプション削除（解約完了） ────────────────────
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId   = subscription.customer;

        console.log(`[Webhook] サブスク削除（解約完了）: customer=${customerId}`);

        const customer = await stripe.customers.retrieve(customerId);
        const email    = customer.email;
        if (email) {
          const ended = {
            plan: 'free',
            billingCycle: 'monthly',
            seatLimit: 0,
            subscriptionStatus: String(subscription?.status || 'canceled'),
            stripeSubscriptionId: String(subscription?.id || ''),
            stripeCustomerId: String(customerId || ''),
            currentPeriodEnd: subscription?.current_period_end
              ? new Date(subscription.current_period_end * 1000).toISOString()
              : null,
          };
          await saveBillingStateByEmail(email, ended);
          console.log(`[Webhook] → ${email} プラン無効化`);
        }

        break;
      }

      // ── 決済成功（毎月の更新） ────────────────────────────────
      case 'invoice.paid': {
        const invoice    = event.data.object;
        const customerId = invoice.customer;
        const email      = invoice.customer_email;
        const amount     = invoice.amount_paid;
        const periodEnd  = invoice.lines?.data?.[0]?.period?.end;

        console.log(`[Webhook] 決済成功: ${email || customerId} ¥${amount/100} 次回: ${periodEnd ? new Date(periodEnd*1000).toLocaleDateString('ja-JP') : '不明'}`);

        // TODO: DB更新 → users.update({ email }, { isPro: true, lastPaidAt: new Date() })

        break;
      }

      // ── 決済失敗 ──────────────────────────────────────────────
      case 'invoice.payment_failed': {
        const invoice    = event.data.object;
        const customerId = invoice.customer;
        const email      = invoice.customer_email;
        const attempt    = invoice.attempt_count;

        console.warn(`[Webhook] 決済失敗: ${email || customerId} 試行${attempt}回目`);

        // Stripe側で自動リトライが設定されていれば自動対応
        // 3回失敗でサブスク停止（Stripeダッシュボードで設定）
        // TODO: 決済失敗通知メールを送信する場合はここに実装

        break;
      }

      default:
        console.log(`[Webhook] 未処理イベント: ${event.type}`);
    }

    return res.status(200).json({ received: true, type: event.type });

  } catch (err) {
    console.error(`[Webhook] イベント処理エラー (${event.type}):`, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
