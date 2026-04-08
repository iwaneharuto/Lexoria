-- Lexoria: history に lexoria_users.id を紐づける（任意・NULL 許容）
ALTER TABLE public.history ADD COLUMN IF NOT EXISTS user_id UUID;

CREATE INDEX IF NOT EXISTS idx_history_user_updated_active
  ON public.history (user_id, updated_at DESC)
  WHERE deleted = false AND user_id IS NOT NULL;

COMMENT ON COLUMN public.history.user_id IS 'lexoria_users.id when resolved at upsert';
