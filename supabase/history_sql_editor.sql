-- =============================================================================
-- Lexoria: history テーブル整合用（Supabase SQL Editor にそのまま貼り付け可）
-- ・既に history がある前提でも再実行しやすい（CREATE TABLE / CREATE INDEX IF NOT EXISTS）
-- ・手動作成で欠けた source_local_id を ALTER で追加
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_email TEXT NOT NULL,
  title TEXT,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary TEXT,
  result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  jurisdiction TEXT NOT NULL DEFAULT 'JP',
  ui_lang TEXT NOT NULL DEFAULT 'ja',
  pinned BOOLEAN NOT NULL DEFAULT false,
  favorite BOOLEAN NOT NULL DEFAULT false,
  deleted BOOLEAN NOT NULL DEFAULT false,
  assignee TEXT,
  memo TEXT,
  source_local_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.history ADD COLUMN IF NOT EXISTS source_local_id TEXT;
-- lexoria_users.id（migration: 20260327120000_history_user_id.sql と同等）
ALTER TABLE public.history ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE public.history ADD COLUMN IF NOT EXISTS assignee TEXT;
ALTER TABLE public.history ADD COLUMN IF NOT EXISTS memo TEXT;
ALTER TABLE public.history ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.history ADD COLUMN IF NOT EXISTS result_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.history ADD COLUMN IF NOT EXISTS jurisdiction TEXT NOT NULL DEFAULT 'JP';
ALTER TABLE public.history ADD COLUMN IF NOT EXISTS ui_lang TEXT NOT NULL DEFAULT 'ja';
ALTER TABLE public.history ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.history ADD COLUMN IF NOT EXISTS favorite BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.history ADD COLUMN IF NOT EXISTS deleted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.history ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE public.history ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$
BEGIN
  ALTER TABLE public.history
    ADD CONSTRAINT history_jurisdiction_chk CHECK (jurisdiction IN ('JP', 'US'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE public.history
    ADD CONSTRAINT history_ui_lang_chk CHECK (ui_lang IN ('ja', 'en'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_history_owner_updated_active
  ON public.history (owner_email, updated_at DESC)
  WHERE deleted = false;

CREATE INDEX IF NOT EXISTS idx_history_owner_jurisdiction_active
  ON public.history (owner_email, jurisdiction)
  WHERE deleted = false;

CREATE INDEX IF NOT EXISTS idx_history_user_updated_active
  ON public.history (user_id, updated_at DESC)
  WHERE deleted = false AND user_id IS NOT NULL;

COMMENT ON COLUMN public.history.user_id IS 'lexoria_users.id when resolved at upsert';

CREATE UNIQUE INDEX IF NOT EXISTS history_owner_source_local_unique
  ON public.history (owner_email, source_local_id)
  WHERE deleted = false AND source_local_id IS NOT NULL;

ALTER TABLE public.history ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.history IS 'AI intake history; CRUD via /api/history with server secret key';
