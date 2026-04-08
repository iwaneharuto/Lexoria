/**
 * メール正規化（ログイン・DB 照合用）
 * よくある誤記は canonical に寄せる（DB・KV のキーと一致させる）
 */
export const EMAIL_ALIAS_TO_CANONICAL = Object.freeze({
  /** 誤: lexoriaaai（a が多い）→ 正: lexoriaai */
  "support@lexoriaaai.com": "support@lexoriaai.com",
  /** 既存アカウントの表記ゆれ（_ 有無）を統一 */
  "iwaharu.422@icloud.com": "iwa_haru.422@icloud.com",
});

export function canonicalizeEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  return EMAIL_ALIAS_TO_CANONICAL[e] || e;
}

/** canonical から照合候補（旧別名含む）を返す */
export function getEmailLookupCandidates(email) {
  const canonical = canonicalizeEmail(email);
  const set = new Set([canonical]);
  for (const [alias, canon] of Object.entries(EMAIL_ALIAS_TO_CANONICAL)) {
    if (canon === canonical) set.add(alias);
  }
  return Array.from(set);
}

/** サポート用: DB に誤記のまま残っている行を検索するときの別名 */
export const SUPPORT_DB_EMAIL_TYPOS = Object.freeze(["support@lexoriaaai.com"]);
