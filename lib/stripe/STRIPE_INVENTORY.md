# Stripe Price / Product インベントリ（コードベース準拠）

内部 tier は **starter / standard / pro**（JP・US 共通）。Checkout の `plan` は従来どおり **personal | small | large**。

---

## 1. USED（現行 Checkout + 表示と整合すべき Price）

`STRIPE_PRICE_IDS`（`lib/stripe/priceIds.js`）の **12 本**。

| 法域 | Tier | Checkout plan | Monthly Price ID | Yearly Price ID |
|------|------|---------------|------------------|-----------------|
| US | starter | personal | price_1TEJBQAPYDSR7srN3H8Rilap | price_1TEJBnAPYDSR7srNC5KAlRiB |
| US | standard | small | price_1TEJCYAPYDSR7srNcHs9HkAa | price_1TEJD0APYDSR7srNfekIF78A |
| US | pro | large | price_1TEJDNAPYDSR7srNQysgPkBV | price_1TEJDkAPYDSR7srNfZdL42JU |
| JP | starter | personal | price_1T8v3PAPYDSR7srNMboKV12t | price_1TE2iuAPYDSR7srN7qicvdR5 |
| JP | standard | small | price_1TE2ljAPYDSR7srNHzGKB9E3 | price_1TE2hWAPYDSR7srNiD3ty5yy |
| JP | pro | large | price_1T9E61APYDSR7srNHlKLA9VT | price_1TE2iLAPYDSR7srNqWsmnOx3 |

---

## 2. LEGACY_BUT_KEEP（Webhook のみ）

`LEGACY_USD_WEBHOOK_PRICE_TO_UI_PLAN` の **6 本**（旧 US 価格帯）。サブスク 0 件確認後にコードから削除可。

---

## 3. 参照の集約

| 用途 | ファイル |
|------|----------|
| Price ID 定義・Checkout・Webhook マップ | `lib/stripe/priceIds.js` |
| 画面表示の金額 | `public/js/pricing-catalog.js` |
