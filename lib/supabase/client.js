import { createClient } from "@supabase/supabase-js";

/**
 * Browser-safe client: publishable (or legacy anon) key only.
 *
 * Note: This app’s history CRUD goes through POST /api/history (secret key + email/password).
 * Use this client when you add Supabase Auth, Realtime, or other public-key-only features.
 *
 * Env:
 * - NEXT_PUBLIC_SUPABASE_URL
 * - NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (preferred)
 * - NEXT_PUBLIC_SUPABASE_ANON_KEY (legacy fallback)
 */
export function createBrowserSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const publishableKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    "";
  if (!url || !publishableKey) {
    return null;
  }
  return createClient(url, publishableKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
