-- サポート用アカウントのメール誤記を修正（lexoriaaai → lexoriaai）
-- 実行前に該当行があるか確認:
--   SELECT id, email FROM public.lexoria_users WHERE email ILIKE '%support%lexoria%';

UPDATE public.lexoria_users
SET email = 'support@lexoriaai.com', updated_at = now()
WHERE lower(trim(email)) = 'support@lexoriaaai.com';

-- 新規作成が必要な場合（password_hash はアプリの hashPassword(平文) と同じ SHA-256 hex を設定）
-- INSERT INTO public.lexoria_users (id, email, password_hash, name, created_at, updated_at)
-- VALUES (gen_random_uuid(), 'support@lexoriaai.com', '<sha256_hex>', 'Support', now(), now());
