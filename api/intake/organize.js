// api/intake/organize.js
// Vercel Serverless Function - Anthropic APIをサーバー側で呼ぶ
// フロントからは consultationText と isPro を受け取り、整理結果のJSONを返す

export default async function handler(req, res) {
  // CORS / メソッドチェック
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { consultationText, isPro } = req.body || {};

  // 入力バリデーション
  if (!consultationText || typeof consultationText !== 'string' || consultationText.trim().length < 10) {
    return res.status(400).json({ error: 'consultationText is required (10+ chars)' });
  }

  // 環境変数からAPIキーを取得（クライアントには一切露出しない）
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[IntakeAI] ANTHROPIC_API_KEY が設定されていません');
    return res.status(503).json({ error: 'AI service unavailable' });
  }

  // 入力を先頭2500文字に制限（速度改善・超過分は切り捨て）
  const text = consultationText.trim().slice(0, 2500);

  // システムプロンプト（簡潔版）
  const systemPrompt = `相談メモを以下のJSON形式のみで出力してください（前置き・後文・マークダウン不要）。
出力形式：{"caseType":"案件類型","keyIssues":"主要論点","priority":"初動確認事項","facts":"事実関係","claims":"依頼者の主張","issues":"想定される論点","todo":"確認対象事項","nextActions":"初動で確認したい事項"}

記載ルール：
- caseType: 案件類型を1行で
- keyIssues: 法的論点を1〜2点、条文番号付きで
- priority: 初動確認事項を1点、「〜の確認」形式で
- facts: 箇条書き（・）で事実関係を3〜4点
- claims: 箇条書き（・）で依頼者の要求を2〜3点
- issues: 箇条書き（・）で法的論点を3〜4点、条文番号付きで
- todo: 箇条書き（・）で確認・収集が必要な事項を3〜4点
- nextActions: 箇条書き（・）で初動確認事項を3〜4点、「〜の確認」「〜の有無を確認」形式で`;

  // free/pro ともに haiku に統一（速度優先）
  const model  = 'claude-haiku-4-5-20251001';
  const maxTok = isPro ? 800 : 500;

  console.time('[IntakeAI] anthropic_call');
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
    console.timeEnd('[IntakeAI] anthropic_call');

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text().catch(() => '');
      console.error('[IntakeAI] FULL_ANTHROPIC_ERROR=' + errText);
      return res.status(502).json({ error: 'AI処理でエラーが発生しました。再試行してください。' });
    }

    // response.text()で受けてJSON.parseする（json()待ちで止まる問題を回避）
    const rawText = await anthropicRes.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      console.error('[IntakeAI] Anthropicレスポンスのパース失敗:', rawText.slice(0, 200));
      return res.status(502).json({ error: 'AIの応答形式が不正でした。再試行してください。' });
    }

    if (!data.content || !data.content.length) {
      return res.status(502).json({ error: 'AIから応答が返りませんでした。再試行してください。' });
    }

    // Anthropic content ブロックのテキストを結合
    const rawAIText = data.content.map(b => b.text || '').join('');

    // ```json ``` を除去
    let cleaned = rawAIText
      .replace(/^```json[\r\n]*/i, '')
      .replace(/^```[\r\n]*/,      '')
      .replace(/[\r\n]*```\s*$/,   '')
      .trim();

    // それでもパース失敗する場合は { ... } を抜き出して再試行
    let parsed = null;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e1) {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          parsed = JSON.parse(m[0]);
        } catch (e2) {
          console.error('[IntakeAI] JSONパース失敗（両試行）:', cleaned.slice(0, 400));
        }
      }
    }

    if (parsed) {
      return res.status(200).json({ ok: true, parsed, raw: rawAIText });
    } else {
      return res.status(502).json({ error: 'parse_failed', raw: rawAIText.slice(0, 2000) });
    }

  } catch (err) {
    console.timeEnd('[IntakeAI] anthropic_call');
    console.error('[IntakeAI] サーバーエラー:', err.message);
    return res.status(500).json({ error: 'サーバーエラーが発生しました。再試行してください。' });
  }
}
