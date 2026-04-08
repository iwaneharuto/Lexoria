# 既存ユーザーを Supabase `lexoria_users` に移行する

## 1. テーブル作成

`supabase/migrations/20260324120000_lexoria_users.sql` または `supabase/lexoria_users_sql_editor.sql` を実行。

## 2. 自動移行（推奨）

Vercel/KV/`.data/auth-users.json` にだけ存在するユーザーは、**次回ログイン時**に `getStoredUser` が検出して `lexoria_users` へ `upsert` します（`[auth/migrate]` ログ）。

## 3. 手動で開発者アカウントを入れる（例: iwaharu.422@outlook.jp）

パスワード `Haruto55` の SHA-256（hex）は次のとおりです。

`92a9ee20834ba568445008271c77c39d3f8dfe25683b41b31a8beb7d378ee9f6`

```sql
INSERT INTO public.lexoria_users (
  id, email, password_hash, name, created_at, updated_at
) VALUES (
  gen_random_uuid(),
  'iwaharu.422@outlook.jp',
  '92a9ee20834ba568445008271c77c39d3f8dfe25683b41b31a8beb7d378ee9f6',
  '開発者',
  now(),
  now()
)
ON CONFLICT (email) DO UPDATE SET
  password_hash = EXCLUDED.password_hash,
  name = EXCLUDED.name,
  updated_at = now();
```

## 4. history との整合

- `history.owner_email` は **小文字化したメール**で保存（アプリの `normalizeEmail` と一致）。
- 将来 `owner_user_id`（UUID）を足す場合は `lexoria_users.id` を参照すればよい。
