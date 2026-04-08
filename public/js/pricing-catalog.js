/**
 * Lexoria 料金カタログ（表示専用）
 * - jurisdiction: JP → JPY / US → USD（ハードコードせずキーで分岐）
 * - 年額 = 月額 × 10（2ヶ月分ディスカウント）
 *
 * Stripe の実請求額は Price ID 側が正。ここは UI 表示と同期させること。
 * @see lib/stripe/priceIds.js（STRIPE_PRICE_IDS）
 * @see lib/stripe/STRIPE_INVENTORY.md
 */
(function (global) {
  "use strict";

  var JP = "JP";
  var US = "US";

  var amounts = {};
  amounts[JP] = {
    personal: { monthly: 9800, yearly: 98000 },
    small: { monthly: 19800, yearly: 198000 },
    large: { monthly: 39800, yearly: 398000 },
  };
  amounts[US] = {
    personal: { monthly: 69, yearly: 690 },
    small: { monthly: 139, yearly: 1390 },
    large: { monthly: 279, yearly: 2790 },
  };

  function jurisdictionKey(j) {
    return j === US ? US : JP;
  }

  function formatJpy(n) {
    return "¥" + Math.round(Number(n)).toLocaleString("ja-JP");
  }

  function formatUsd(n) {
    return "$" + Math.round(Number(n)).toLocaleString("en-US");
  }

  /**
   * @param {'JP'|'US'} jurisdiction
   * @param {'personal'|'small'|'large'} planTier
   * @param {'monthly'|'yearly'} cycle
   */
  function formatPrice(jurisdiction, planTier, cycle) {
    var j = jurisdictionKey(jurisdiction);
    var tier = amounts[j][planTier];
    if (!tier) return "—";
    var n = cycle === "yearly" ? tier.yearly : tier.monthly;
    return j === US ? formatUsd(n) : formatJpy(n);
  }

  /** 年払い時の「月12回払い」との差 = 月額×2 */
  function yearlySavingsAmount(jurisdiction, planTier) {
    var j = jurisdictionKey(jurisdiction);
    var tier = amounts[j][planTier];
    if (!tier) return 0;
    return tier.monthly * 2;
  }

  function formatYearlySavings(jurisdiction, planTier, isEn) {
    var j = jurisdictionKey(jurisdiction);
    var s = yearlySavingsAmount(jurisdiction, planTier);
    if (j === US) {
      var fs = formatUsd(s);
      return isEn !== false
        ? "Save " + fs + " per year vs paying monthly (2 months free)"
        : "Save " + fs + " per year (2 months free)";
    }
    var fj = formatJpy(s);
    return isEn ? "Save " + fj + " yearly (2 months free)" : "年額で" + fj + "お得（2ヶ月無料）";
  }

  global.LexoriaPricingCatalog = {
    JURISDICTION: { JP: JP, US: US },
    amounts: amounts,
    formatPrice: formatPrice,
    formatJpy: formatJpy,
    formatUsd: formatUsd,
    yearlySavingsAmount: yearlySavingsAmount,
    formatYearlySavings: formatYearlySavings,
  };
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : this);
