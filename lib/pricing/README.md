# Pricing catalog (JP / US)

| Item | Source of truth |
|------|-----------------|
| **UI 表示（ブラウザ）** | `public/js/pricing-catalog.js` の `amounts` |
| **Stripe Checkout の Price ID** | `lib/stripe/priceIds.js` の `STRIPE_PRICE_IDS` |
| **Webhook: priceId → UI plan** | `buildPriceToUiPlanMap()` |
| **一覧** | `lib/stripe/STRIPE_INVENTORY.md` |

内部 tier は **starter / standard / pro**（JP・US 共通）。Checkout の `plan` は **personal / small / large**（従来どおり）。

## US（USD）

- Starter: $69/mo, $690/yr  
- Standard: $139/mo, $1,390/yr  
- Pro: $279/mo, $2,790/yr  

年額 = 月額 × 10。

## JP（JPY）

- Starter: ¥9,800 / ¥98,000  
- Standard（UI: small）: ¥19,800 / ¥198,000  
- Pro（UI: large）: ¥39,800 / ¥398,000  

変更時は **`pricing-catalog.js` と `priceIds.js`** をセットで更新してください。
