-- Lexoria: public.history
-- Idempotent: 手動作成済みテーブルにもそのまま流せる（不足カラムは ADD COLUMN IF NOT EXISTS）。
-- RLS 有効・ポリシーなし = publishable 直叩きは拒否。/api/history は secret で RLS バイパス。

-- 1) 新規環境用（既にある場合はスキップ）
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

-- 2) 手動作成テーブルで欠けがちなカラム（source_local_id 含む）
ALTER TABLE public.history ADD COLUMN IF NOT EXISTS source_local_id TEXT;
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

-- 3) CHECK 制約（無ければ追加。既存データが違反していると失敗するのでその場合は手で修正後に再実行）
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

-- 4) インデックス（IF NOT EXISTS で二重作成回避）
CREATE INDEX IF NOT EXISTS idx_history_owner_updated_active
  ON public.history (owner_email, updated_at DESC)
  WHERE deleted = false;

CREATE INDEX IF NOT EXISTS idx_history_owner_jurisdiction_active
  ON public.history (owner_email, jurisdiction)
  WHERE deleted = false;

CREATE UNIQUE INDEX IF NOT EXISTS history_owner_source_local_unique
  ON public.history (owner_email, source_local_id)
  WHERE deleted = false AND source_local_id IS NOT NULL;

-- 5) RLS（複数回実行しても問題なし）
ALTER TABLE public.history ENABLE ROW LEVEL SECURITY;

-- 6) コメント
COMMENT ON TABLE public.history IS 'AI intake history; CRUD via /api/history with server secret key';
