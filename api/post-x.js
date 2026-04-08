/**
 * Lexoria 公式 X 自動投稿 API
 * GET /api/post-x … 1回投稿
 * GET /api/post-x?dryrun=1 … 投稿せず生成文だけ JSON で返す
 *
 * 環境変数: ANTHROPIC_API_KEY, X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
 *
 * 直近投稿: /tmp/last-post.txt に保存。同一なら1回だけ再生成、まだ同一なら投稿スキップ。
 * ツイート長は130文字に制限してX APIエラーを防ぐ。
 */

import { TwitterApi } from 'twitter-api-v2';
import { kv } from '@vercel/kv';

const LAST_POST_KEY = 'post-x:last-post';
const MAX_TWEET_LENGTH = 130;

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

const CATEGORIES = [
  { id: 'legal_tips',     weight: 40, themes: [
    '相続相談の初動確認',
    '交通事故相談で整理したい事項',
    '離婚相談で確認したい事実関係',
    '労働相談の時系列整理',
    '契約トラブル相談の確認ポイント',
  ]},
  { id: 'lawyer_aruaru',  weight: 30, themes: [
    '初回相談の聞き取り',
    '時系列整理の大変さ',
    '確認事項の抜け漏れ',
    '証拠整理の手間',
    '相談メモの属人化',
  ]},
  { id: 'build_in_public', weight: 20, themes: [
    'UI改善',
    '出力精度改善',
    'チーム機能追加',
    '招待コード改善',
    '実務向け改善ログ',
  ]},
  { id: 'lexoria_pr',    weight: 10, themes: [
    '相談メモ整理',
    '時系列の自動整理',
    '論点の見える化',
    '確認事項の抽出',
    '事務所の初動効率化',
  ]},
];

function weightedRandomCategory() {
  const total = CATEGORIES.reduce((s, c) => s + c.weight, 0);
  let r = Math.random() * total;
  for (const c of CATEGORIES) {
    r -= c.weight;
    if (r <= 0) return c;
  }
  return CATEGORIES[0];
}

function pickTheme(category) {
  const themes = category.themes;
  return themes[Math.floor(Math.random() * themes.length)];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  const sa = String(a).trim();
  const sb = String(b).trim();
  if (sa === sb) return 1;
  const wordsA = new Set(sa.replace(/\s+/g, ' ').split(' ').filter(Boolean));
  const wordsB = new Set(sb.replace(/\s+/g, ' ').split(' ').filter(Boolean));
  let match = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) match++;
  }
  return wordsA.size ? match / wordsA.size : 0;
}

async function getLastPostText() {
  try {
    const raw = await kv.get(LAST_POST_KEY);
    return (raw && String(raw).trim()) || '';
  } catch {
    return '';
  }
}

async function setLastPostText(text) {
  try {
    await kv.set(LAST_POST_KEY, String(text));
    console.log('[post-x] last post saved to', LAST_POST_KEY);
  } catch (e) {
    console.warn('[post-x] failed to save last post', e?.message);
  }
}

async function generateTweetText(category, theme, lastText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey?.trim()) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }

  const prompt = `あなたは弁護士・法律事務所向けのX（Twitter）投稿文を書く担当です。
以下のテーマで、日本語の投稿文を1つだけ書いてください。他に説明や前置きは一切不要です。

カテゴリ: ${category.id}
テーマ: ${theme}

ルール:
- 投稿文だけを返す（引用符で囲まない、改行はそのまま可）
- 140文字前後
- 誇張しすぎない
- 一般論のみ。個別の法的助言はしない
- ハッシュタグは0〜2個まで
- 絵文字は0〜1個まで
- Lexoriaの宣伝色は強くしすぎない。役立ち感を優先
${lastText ? `- 次の文と似すぎないようにする（直近の投稿例: ${lastText.slice(0, 80)}…）` : ''}`;

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const raw = await res.text();
  if (!res.ok) {
    console.error('[post-x] Anthropic error', res.status, raw);
    throw new Error(`Anthropic API error: ${res.status}`);
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error('Anthropic response parse failed');
  }

  let text = '';
  if (body.content && Array.isArray(body.content)) {
    text = body.content
      .map((b) => (b?.type === 'text' && b.text != null ? b.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  text = text.trim().replace(/^["']|["']$/g, '').trim();
  if (!text) throw new Error('Empty tweet text from AI');
  if (text.length > MAX_TWEET_LENGTH) text = text.slice(0, MAX_TWEET_LENGTH - 1) + '…';
  return text;
}

export default async function handler(req, res) {
  const dryrun = req.query?.dryrun === '1' || req.query?.dryrun === 'true';

  const sendSuccess = (payload = {}) => {
    res.status(200).json({ success: true, ...payload });
  };
  const sendFailure = (message) => {
    res.status(200).json({ success: false, error: message });
  };

  try {
    console.log('[post-x] cron job started');

    const category = weightedRandomCategory();
    const theme = pickTheme(category);
    console.log('[post-x] category=', category.id, 'theme=', theme);

    let lastText = await getLastPostText();

    let text = await generateTweetText(category, theme, lastText);

    if (lastText && similarity(text, lastText) > 0.7) {
      console.log('[post-x] too similar to last tweet, regenerating once');
      text = await generateTweetText(category, theme, lastText);
    }

    if (text === lastText) {
      console.log('[post-x] generated text identical to last post, regenerating once');
      text = await generateTweetText(category, theme, lastText);
    }

    if (text.length > MAX_TWEET_LENGTH) {
      text = text.slice(0, MAX_TWEET_LENGTH - 1) + '…';
    }

    console.log('[post-x] generated tweet text:', text);

    if (dryrun) {
      return res.status(200).json({
        dryrun: true,
        success: true,
        text,
        category: category.id,
        theme,
      });
    }

    if (text === lastText) {
      console.log('[post-x] skipped posting: still identical to last post after regenerate');
      return sendSuccess({ skipped: true, reason: 'duplicate' });
    }

    const appKey = process.env.X_API_KEY;
    const appSecret = process.env.X_API_SECRET;
    const accessToken = process.env.X_ACCESS_TOKEN;
    const accessSecret = process.env.X_ACCESS_SECRET;

    if (!appKey || !appSecret || !accessToken || !accessSecret) {
      console.error('[post-x] X API credentials missing');
      return sendFailure('X API credentials not configured');
    }

    const client = new TwitterApi({
      appKey,
      appSecret,
      accessToken,
      accessSecret,
    });

    await client.v2.tweet(text);
    await setLastPostText(text);

    console.log('[post-x] posting succeeded');
    return sendSuccess();
  } catch (err) {
    console.error('[post-x] posting failed', err?.message, err);
    return sendFailure(err?.message || 'post-x failed');
  }
}
