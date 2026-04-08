// Stripe Price ID — 本リポジトリ内の price_* 文字列はこのファイルのみ（集約）
//
// 内部 tier: starter / standard / pro（JP・US 共通）
// UI キー: personal(small/large は従来どおり checkout 用) → starter/standard/pro
//
// @see lib/stripe/STRIPE_INVENTORY.md

export const JURISDICTION = Object.freeze({ JP: "JP", US: "US" });
export const BILLING_CYCLE = Object.freeze({ monthly: "monthly", yearly: "yearly" });

export const PLAN_TIER = Object.freeze({
  starter: "starter",
  standard: "standard",
  pro: "pro",
});

/** UI の plan キー ↔ 内部 tier（checkout の plan パラメータは従来どおり personal | small | large） */
export const UI_PLAN_TO_TIER = Object.freeze({
  personal: PLAN_TIER.starter,
  small: PLAN_TIER.standard,
  large: PLAN_TIER.pro,
});

const TIER_TO_UI_PLAN = Object.freeze({
  [PLAN_TIER.starter]: "personal",
  [PLAN_TIER.standard]: "small",
  [PLAN_TIER.pro]: "large",
});

/**
 * Checkout / resolvePriceId が参照する現行 Price（JP: JPY / US: USD）
 * 表示金額は public/js/pricing-catalog.js と揃えること。
 */
export const STRIPE_PRICE_IDS = Object.freeze({
  usd: {
    [PLAN_TIER.starter]: {
      [BILLING_CYCLE.monthly]: "price_1TEJBQAPYDSR7srN3H8Rilap",
      [BILLING_CYCLE.yearly]: "price_1TEJBnAPYDSR7srNC5KAlRiB",
    },
    [PLAN_TIER.standard]: {
      [BILLING_CYCLE.monthly]: "price_1TEJCYAPYDSR7srNcHs9HkAa",
      [BILLING_CYCLE.yearly]: "price_1TEJD0APYDSR7srNfekIF78A",
    },
    [PLAN_TIER.pro]: {
      [BILLING_CYCLE.monthly]: "price_1TEJDNAPYDSR7srNQysgPkBV",
      [BILLING_CYCLE.yearly]: "price_1TEJDkAPYDSR7srNfZdL42JU",
    },
  },
  jpy: {
    [PLAN_TIER.starter]: {
      [BILLING_CYCLE.monthly]: "price_1T8v3PAPYDSR7srNMboKV12t",
      [BILLING_CYCLE.yearly]: "price_1TE2iuAPYDSR7srN7qicvdR5",
    },
    [PLAN_TIER.standard]: {
      [BILLING_CYCLE.monthly]: "price_1TE2ljAPYDSR7srNHzGKB9E3",
      [BILLING_CYCLE.yearly]: "price_1TE2hWAPYDSR7srNiD3ty5yy",
    },
    [PLAN_TIER.pro]: {
      [BILLING_CYCLE.monthly]: "price_1T9E61APYDSR7srNHlKLA9VT",
      [BILLING_CYCLE.yearly]: "price_1TE2iLAPYDSR7srNqWsmnOx3",
    },
  },
});

/**
 * LEGACY_BUT_KEEP — Checkout では使わない。過去の US 価格帯で残っているサブスクの Webhook 用。
 */
export const LEGACY_USD_WEBHOOK_PRICE_TO_UI_PLAN = Object.freeze({
  price_1TBnuoAPYDSR7srND1Tq8dVj: "personal",
  price_1TBnxRAPYDSR7srNwQ4Hco6m: "personal",
  price_1TBnwnAPYDSR7srNJi8awoIS: "small",
  price_1TBnxiAPYDSR7srNqRylD9yp: "small",
  price_1TBnxDAPYDSR7srNrk6iKfSP: "large",
  price_1TBny2APYDSR7srN6NU5gZik: "large",
});

function collectActivePriceIdToUiPlan() {
  const map = {};
  const currencies = ["jpy", "usd"];
  const tiers = [PLAN_TIER.starter, PLAN_TIER.standard, PLAN_TIER.pro];
  const cycles = [BILLING_CYCLE.monthly, BILLING_CYCLE.yearly];
  for (const cur of currencies) {
    const byTier = STRIPE_PRICE_IDS[cur];
    if (!byTier) continue;
    for (const tier of tiers) {
      const uiPlan = TIER_TO_UI_PLAN[tier];
      const byCycle = byTier[tier];
      if (!byCycle) continue;
      for (const cycle of cycles) {
        const id = byCycle[cycle];
        if (id) map[id] = uiPlan;
      }
    }
  }
  return map;
}

/** Webhook / 通知: subscription の price.id → UI plan（personal | small | large） */
export function buildPriceToUiPlanMap() {
  return {
    ...collectActivePriceIdToUiPlan(),
    ...LEGACY_USD_WEBHOOK_PRICE_TO_UI_PLAN,
  };
}

export function resolveCurrencyByJurisdiction(jurisdiction) {
  return jurisdiction === JURISDICTION.US ? "usd" : "jpy";
}

export function resolveTierFromUiPlan(uiPlan) {
  return UI_PLAN_TO_TIER[uiPlan] || null;
}

export function resolvePriceId({ jurisdiction, uiPlan, billingCycle }) {
  const j = jurisdiction === JURISDICTION.US ? JURISDICTION.US : JURISDICTION.JP;
  const cycle =
    billingCycle === BILLING_CYCLE.yearly ? BILLING_CYCLE.yearly : BILLING_CYCLE.monthly;
  const tier = resolveTierFromUiPlan(uiPlan);
  if (!tier) return { ok: false, error: `Invalid plan: ${uiPlan}` };

  const currency = resolveCurrencyByJurisdiction(j);
  const price = STRIPE_PRICE_IDS?.[currency]?.[tier]?.[cycle];
  if (!price) {
    return {
      ok: false,
      error: `Price ID not configured for ${j}/${currency}/${tier}/${cycle}`,
    };
  }
  return { ok: true, priceId: price, currency, tier, cycle, jurisdiction: j };
}

/** 監査用: 現行 Checkout で使う Price ID の一覧（重複なし） */
export function listActiveCheckoutPriceIds() {
  const m = collectActivePriceIdToUiPlan();
  return Object.keys(m).sort();
}
