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

// ── 商品・プラン設定 ─────────────────────────────────────────────
// 商品ID: prod_U79MghzsXxusgz
const PRODUCT_ID = 'prod_U79MghzsXxusgz';

// Price ID → プラン名 マッピング
// 確認方法: Stripe Dashboard → 商品カタログ → prod_U79MghzsXxusgz → 各価格のID
// または Stripe CLI: stripe prices list --product prod_U79MghzsXxusgz
const PRICE_TO_PLAN = {
  'price_1T8v3PAPYDSR7srNMboKV12t': 'personal', // パーソナルプラン ¥9,800/月  1ユーザー
  'price_1T9E61APYDSR7srNHlKLA9VT': 'small',    // スモールプラン  ¥39,800/月  最大5ユーザー
  'price_1T9K14APYDSR7srN7qvPVkFr': 'large',    // ラージプラン    ¥74,900/月  最大10ユーザー
};

// プランを解決（静的マッピング → 金額フォールバックの順で判定）
async function resolvePlan(stripe, subscription) {
  const item  = subscription?.items?.data?.[0];
  const price = item?.price;
  if (!price) return 'personal';

  // 静的マッピングで解決できる場合
  if (PRICE_TO_PLAN[price.id]) return PRICE_TO_PLAN[price.id];

  // 同じ商品に属するpriceなら金額でプランを推定
  if (price.product === PRODUCT_ID) {
    const amount = price.unit_amount; // JPY（¥単位）
    if      (amount >= 74900) return 'large';
    else if (amount >= 39800) return 'small';
    else                      return 'personal';
  }

  console.warn('[Webhook] 未知のPrice ID:', price.id, '→ personal にフォールバック');
  return 'personal';
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

        // サブスクリプション詳細を取得してプランを特定
        let plan = 'personal';
        if (subscriptionId) {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          plan = await resolvePlan(stripe, subscription);
        }

        console.log(`[Webhook] 購入完了: ${customerEmail} → ${plan}プラン (customer: ${customerId})`);

        // TODO: データベースが導入された際はここでユーザーのプラン・顧客IDを更新
        // 現在はlocalStorageベースのため、サーバー側での永続化は未実装
        // 将来の実装例:
        // await db.users.update({ email: customerEmail }, {
        //   plan, isPro: true, stripeCustomerId: customerId,
        //   stripeSubscriptionId: subscriptionId, planActivatedAt: new Date()
        // });

        break;
      }

      // ── サブスクリプション作成 ────────────────────────────────
      case 'customer.subscription.created': {
        const subscription = event.data.object;
        const customerId   = subscription.customer;
        const plan         = await resolvePlan(stripe, subscription);
        const status       = subscription.status; // active / trialing / incomplete 等

        console.log(`[Webhook] サブスク作成: customer=${customerId} plan=${plan} status=${status}`);

        // メールアドレスをcustomerIdから取得
        const customer = await stripe.customers.retrieve(customerId);
        const email    = customer.email;
        if (email) {
          console.log(`[Webhook] → ユーザー: ${email} プラン有効化: ${plan}`);
          // TODO: DB更新 → users.update({ email }, { plan, isPro: true, stripeCustomerId: customerId })
        }

        break;
      }

      // ── サブスクリプション更新（プラン変更・更新日迎え） ────────
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const customerId   = subscription.customer;
        const plan         = await resolvePlan(stripe, subscription);
        const status       = subscription.status;
        const cancelAtEnd  = subscription.cancel_at_period_end;

        console.log(`[Webhook] サブスク更新: customer=${customerId} plan=${plan} status=${status} cancelAtEnd=${cancelAtEnd}`);

        const customer = await stripe.customers.retrieve(customerId);
        const email    = customer.email;
        if (email) {
          if (status === 'active' && !cancelAtEnd) {
            console.log(`[Webhook] → ${email} プラン更新: ${plan}`);
            // TODO: DB更新 → users.update({ email }, { plan, isPro: true, cancelScheduled: false })
          } else if (cancelAtEnd) {
            console.log(`[Webhook] → ${email} 解約予約済み（期間末に停止）`);
            // TODO: DB更新 → users.update({ email }, { cancelScheduled: true })
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
          console.log(`[Webhook] → ${email} プラン無効化`);
          // TODO: DB更新 → users.update({ email }, { plan: 'free', isPro: false, cancelScheduled: false })
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
