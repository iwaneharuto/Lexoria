// api/intake/organize.js
// Vercel Serverless Function - Anthropic APIをサーバー側で呼ぶ
// フロントからは consultationText と isPro を受け取り、整理結果のJSONを返す

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { consultationText, isPro } = req.body || {};

  if (!consultationText || typeof consultationText !== 'string' || consultationText.trim().length < 10) {
    return res.status(400).json({ error: 'consultationText is required (10+ chars)' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[Lexoria] ANTHROPIC_API_KEY が設定されていません');
    return res.status(503).json({ error: 'AI service unavailable' });
  }

  const text = consultationText.trim().slice(0, 2500);

  // title フィールドを追加したシステムプロンプト
  const systemPrompt = `相談メモを以下のJSON形式のみで出力してください（前置き・後文・マークダウン不要）。
出力形式：{"title":"相談タイトル","caseType":"案件類型","keyIssues":"主要論点","priority":"初動確認事項","facts":"事実関係","claims":"依頼者の主張","issues":"想定される論点","todo":"確認対象事項","nextActions":"初動で確認したい事項"}

記載ルール：
- title: 相談内容を一言で表す日本語タイトル（20〜40文字程度）。例:「交通事故（後遺障害の相談）」「離婚と財産分与の相談」「未払い残業代請求の相談」
- caseType: 案件類型を1行で
- keyIssues: 法的論点を1〜2点、条文番号付きで
- priority: 初動確認事項を1点、「〜の確認」形式で
- facts: 箇条書き（・）で事実関係を3〜4点
- claims: 箇条書き（・）で依頼者の要求を2〜3点
- issues: 箇条書き（・）で法的論点を3〜4点、条文番号付きで
- todo: 箇条書き（・）で確認・収集が必要な事項を3〜4点
- nextActions: 箇条書き（・）で初動確認事項を3〜4点、「〜の確認」「〜の有無を確認」形式で`;

  const model  = 'claude-haiku-4-5-20251001';
  const maxTok = isPro ? 800 : 500;

  console.time('[Lexoria] anthropic_call');
  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTok,
        system: systemPrompt,
        messages: [{ role: 'user', content: '以下の相談内容を整理してください。\n\n' + text }],
      }),
    });
    console.timeEnd('[Lexoria] anthropic_call');

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text().catch(() => '');
      console.error('[Lexoria] FULL_ANTHROPIC_ERROR=' + errText);
      return res.status(502).json({ error: 'AI処理でエラーが発生しました。再試行してください。' });
    }

    const rawText = await anthropicRes.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      console.error('[Lexoria] Anthropicレスポンスのパース失敗:', rawText.slice(0, 200));
      return res.status(502).json({ error: 'AIの応答形式が不正でした。再試行してください。' });
    }

    if (!data.content || !data.content.length) {
      return res.status(502).json({ error: 'AIから応答が返りませんでした。再試行してください。' });
    }

    const rawAIText = data.content.map(b => b.text || '').join('');

    let cleaned = rawAIText
      .replace(/^```json[\r\n]*/i, '')
      .replace(/^```[\r\n]*/,      '')
      .replace(/[\r\n]*```\s*$/,   '')
      .trim();

    let parsed = null;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e1) {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); }
        catch (e2) { console.error('[Lexoria] JSONパース失敗（両試行）:', cleaned.slice(0, 400)); }
      }
    }

    if (parsed) {
      // titleが空またはない場合のフォールバック
      if (!parsed.title || !parsed.title.trim()) {
        parsed.title = parsed.caseType ? parsed.caseType + 'の相談' : '無題の相談';
      }
      console.log('RETURN_SHAPE', { hasParsed: true, keys: Object.keys(parsed), ok: true });
      return res.status(200).json({ ok: true, parsed, raw: rawAIText });
    } else {
      return res.status(502).json({ ok: false, error: 'parse_failed', raw: rawAIText.slice(0, 2000) });
    }

  } catch (err) {
    console.timeEnd('[Lexoria] anthropic_call');
    console.error('[Lexoria] サーバーエラー:', err.message);
    return res.status(500).json({ error: 'サーバーエラーが発生しました。再試行してください。' });
  }
}
