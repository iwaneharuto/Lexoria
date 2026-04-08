-- Supabase SQL Editor 用（再実行しやすい）
CREATE TABLE IF NOT EXISTS public.lexoria_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT,
  plan_tier TEXT,
  billing_cycle TEXT,
  seat_limit INTEGER,
  subscription_status TEXT,
  jurisdiction_default TEXT,
  ui_lang_default TEXT,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  team_id UUID,
  role TEXT,
  trial_start TIMESTAMPTZ,
  trial_started_at TIMESTAMPTZ,
  trial_ends_at TIMESTAMPTZ,
  trial_count INTEGER NOT NULL DEFAULT 0,
  trial_status TEXT,
  legacy_password_sha256 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lexoria_users_email_lower ON public.lexoria_users (lower(email));

ALTER TABLE public.lexoria_users ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.lexoria_users IS 'Lexoria auth users; /api/auth + service_role (SUPABASE_SECRET_KEY). history.owner_email matches email. 認証の読み取りは lexoria_users のみ（public.users フォールバック廃止）。別テーブル名は SUPABASE_LEXORIA_USERS_TABLE。';
