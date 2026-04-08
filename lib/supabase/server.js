import { createClient } from "@supabase/supabase-js";

/**
 * 本番で空白混入すると createClient が失敗し isSupabaseAuthConfigured が false → 常に legacy_kv になる。
 * URL / 秘密鍵の解決はここだけ（createClient と診断で同一ロジック）。
 *
 * URL（先勝ち）: NEXT_PUBLIC_SUPABASE_URL → SUPABASE_URL
 * 秘密鍵（先勝ち）: SUPABASE_SECRET_KEY → SUPABASE_SERVICE_ROLE_KEY
 *   ※ service_role（ダッシュボードの service_role JWT）を使うこと。anon だけだと RLS で 0 件になりやすい。
 */
export function readSupabaseServerEnv() {
  const url = String(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ""
  ).trim();
  const secretFromSecretKey = String(process.env.SUPABASE_SECRET_KEY || "").trim();
  const secretFromServiceRole = String(
    process.env.SUPABASE_SERVICE_ROLE_KEY || ""
  ).trim();
  const secretKey = secretFromSecretKey || secretFromServiceRole;
  const secretFrom = secretFromSecretKey
    ? "SUPABASE_SECRET_KEY"
    : secretFromServiceRole
      ? "SUPABASE_SERVICE_ROLE_KEY"
      : null;
  return {
    url,
    secretKey,
    secretFrom,
    ok: Boolean(url && secretKey),
  };
}

export function createServerSupabase() {
  const { url, secretKey, ok } = readSupabaseServerEnv();
  if (!ok) {
    return null;
  }
  return createClient(url, secretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

/**
 * ログ用（秘密は出さない）。login ハンドラ先頭で呼ぶと接続切り分けに使える。
 */
export function getSupabaseConnectionDiagnostics() {
  const { url, secretFrom, ok } = readSupabaseServerEnv();
  let urlHost = null;
  try {
    if (url) urlHost = new URL(url).host;
  } catch {
    urlHost = "invalid_url";
  }
  return {
    hasUrl: Boolean(url),
    urlHost,
    hasSecretKey: Boolean(secretFrom),
    secretFrom,
    clientWouldInit: ok,
  };
}
