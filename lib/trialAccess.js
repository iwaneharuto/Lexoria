/**
 * AI整理 API 用: 無料トライアル・有料サブスク判定（サーバー側の単一ソース）。
 * JP / US 共通（法域は問わない）。
 */
import { UI_PLAN_TO_TIER } from "./stripe/priceIds.js";

export const TRIAL_ORGANIZE_LIMIT = 10;
export const TRIAL_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

// Developer special account (STRICT: only this exact email; case-insensitive)
export const DEVELOPER_OVERRIDE_EMAIL = "iwaharu.422@outlook.jp";

export function isDeveloperOverrideEmail(email) {
  return (
    email != null &&
    String(email).trim().toLowerCase() === DEVELOPER_OVERRIDE_EMAIL
  );
}

function parseIsoMs(iso) {
  if (iso == null || iso === "") return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Webhook / DB の UI plan（personal|small|large）または tier から内部 tier を得る */
export function getEffectivePlanTier(stored) {
  if (!stored || typeof stored !== "object") return null;
  const t = String(stored.plan_tier || "").toLowerCase().trim();
  if (t === "starter" || t === "standard" || t === "pro") return t;
  const p = String(stored.plan || "").toLowerCase().trim();
  return UI_PLAN_TO_TIER[p] || null;
}

/**
 * 課金アクティブ（Lexoria の整理機能を無制限に使える状態）
 * - plan tier が starter/standard/pro かつ Stripe subscription が active/trialing
 * - レガシー: subscription 行が無いが stripe_subscription_id のみある場合は互換のため許可
 */
export function isPaidSubscriptionActive(stored) {
  if (!stored || typeof stored !== "object") return false;
  if (isDeveloperOverrideEmail(stored.email)) return true;
  const tier = getEffectivePlanTier(stored);
  if (!tier) return false;
  const st = String(stored.subscription_status || stored.subscriptionStatus || "")
    .toLowerCase()
    .trim();
  if (st === "active" || st === "trialing") return true;
  const subId = String(stored.stripe_subscription_id || stored.stripeSubscriptionId || "").trim();
  if (subId && (!st || st === "")) return true;
  return false;
}

/**
 * @param {object} stored getStoredUser の結果
 * @param {Date} [now]
 * @param {string} [uiLang] "en" | "ja"
 * @returns {{ ok: true } | { ok: false, code: string, message: string, messageEn: string }}
 */
export function evaluateOrganizeAccess(stored, now = new Date(), uiLang = "ja") {
  if (!stored || typeof stored !== "object") {
    return {
      ok: false,
      code: "UNAUTHORIZED",
      message: "ユーザー情報を確認できませんでした。",
      messageEn: "Could not load account.",
    };
  }

  if (isDeveloperOverrideEmail(stored.email)) {
    return { ok: true };
  }

  if (isPaidSubscriptionActive(stored)) {
    return { ok: true };
  }

  const nowMs = now.getTime();
  const usage = Math.max(0, Number(stored.trialCount ?? stored.trial_count ?? 0) || 0);

  const trialStarted =
    stored.trialStartedAt ||
    stored.trial_started_at ||
    stored.trialStart ||
    stored.trial_start ||
    null;
  let endMs = parseIsoMs(stored.trialEndsAt || stored.trial_ends_at);
  const startMs = parseIsoMs(trialStarted);
  if (endMs == null && startMs != null) {
    endMs = startMs + TRIAL_DURATION_MS;
  }
  if (endMs == null) {
    const createdMs = parseIsoMs(stored.created_at);
    if (createdMs != null) {
      endMs = createdMs + TRIAL_DURATION_MS;
    }
  }

  // 期間と件数のどちらかで終了（仕様順: 期間 → 件数）
  if (endMs != null && nowMs > endMs) {
    return {
      ok: false,
      code: "TRIAL_EXPIRED",
      message:
        "無料トライアル期間（7日間）が終了しました。継続利用にはプラン登録が必要です。",
      messageEn:
        "Your 7-day free trial has ended. A paid plan is required to continue.",
    };
  }

  if (usage >= TRIAL_ORGANIZE_LIMIT) {
    return {
      ok: false,
      code: "TRIAL_LIMIT_REACHED",
      message:
        "無料トライアルの利用上限（10件）に達しました。継続利用にはプラン登録が必要です。",
      messageEn:
        "You have reached the free trial limit (10 AI organizations). A paid plan is required to continue.",
    };
  }

  void uiLang;
  return { ok: true };
}

export function pickUserMessage(evalResult, uiLang) {
  const isEn = String(uiLang || "").toLowerCase().startsWith("en");
  return isEn ? evalResult.messageEn : evalResult.message;
}
