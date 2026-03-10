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

  const freeSystem = `以下の相談メモを分類し、指定のJSON形式のみで出力してください（前置き・後文・マークダウン不要）。
出力形式：{"caseType":"案件類型","keyIssues":"主要論点","priority":"初動確認事項","facts":"事実関係","claims":"依頼者の主張","issues":"想定される論点","todo":"追加で確認すべき事項","nextActions":"初動で確認したい事項"}

記載ルール：
- caseType: 相談内容から判断される案件の類型を短く1行で記載する（入力内容に基づき決定する）
- keyIssues: 関連する法的論点を1〜2点、条文番号を付記して列挙する
- priority: 初動で確認対象となる事項を1点、「〜の確認」「〜の有無を確認」の形式で記載する
- facts: 箇条書き（・）で、相談メモに記載された日時・当事者・出来事・状況を3〜4点抽出する
- claims: 箇条書き（・）で、依頼者が求める結果・要求事項を2〜3点抽出する
- issues: 箇条書き（・）で、相談内容に関連する法的論点を3〜4点列挙する。各論点に対応する日本法の条文番号（法律名・条番号）を「（○○法○条）」の形式で付記する
- todo: 箇条書き（・）で、事実確認・証拠収集・書類取得に必要な項目を3〜4点列挙する
- nextActions: 箇条書き（・）で、初動において確認対象となる事項を3〜4点列挙する。「〜の確認」「〜の有無を確認」「〜資料の取得状況を確認」「〜事情の整理」「〜経過の確認」の形式を使用する。「〜すべき」「〜してください」「〜した方がよい」「〜すること」等の命令・助言表現は使用しない`;
  const proSystem  = `以下の相談メモを分類し、指定のJSON形式のみで出力してください（前置き・後文・マークダウン不要）。
出力形式：{"caseType":"案件類型","keyIssues":"主要論点","priority":"初動確認事項","facts":"事実関係","claims":"依頼者の主張","issues":"想定される論点と関連条文","todo":"追加で確認すべき事項","nextActions":"初動で確認したい事項"}

記載ルール：
- caseType: 相談内容から判断される案件の類型を短く1行で記載する（入力内容に基づき決定する）
- keyIssues: 関連する法的論点を1〜2点、条文番号を付記して列挙する
- priority: 初動で確認対象となる事項を1点、「〜の確認」「〜の有無を確認」の形式で記載する
- facts: 箇条書き（・）で、相談メモに記載された日時・当事者・出来事・状況・背景を時系列順に4〜6点抽出する
- claims: 箇条書き（・）で、依頼者が求める結果・法的請求の内容・要求事項を3〜5点抽出する
- issues: 箇条書き（・）で、相談内容に関連する法的論点を4〜6点列挙する。各論点の末尾に対応する日本法の条文番号（法律名・条番号）を「（関連条文：○○法○条、○条）」の形式で付記する。判例が確立している論点については判例番号（最判年月日等）を付記する
- todo: 箇条書き（・）で、事実確認・証拠収集・書類取得に必要な項目を4〜6点列挙する
- nextActions: 箇条書き（・）で、初動において確認対象となる事項を4〜6点列挙する。「〜の確認」「〜の有無を確認」「〜資料の取得状況を確認」「〜事情の整理」「〜経過の確認」「〜可能性の検討材料を整理」の形式を使用する。「〜すべき」「〜してください」「〜した方がよい」「〜すること」「〜を行う」「〜を検討する」等の命令・助言・断定表現は使用しない`;

  const model  = isPro ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';
  const maxTok = isPro ? 1800 : 1000;
  const system = isPro ? proSystem : freeSystem;

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
        system,
        messages: [{ role: 'user', content: '以下の相談内容を整理してください。\n\n' + consultationText.trim() }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text().catch(() => '');
      console.error(
        `[IntakeAI] Anthropic API エラー\n` +
        `  status : ${anthropicRes.status} ${anthropicRes.statusText}\n` +
        `  model  : ${model}\n` +
        `  isPro  : ${isPro}\n` +
        `  body   : ${errText.slice(0, 400)}`
      );
      const isDev = process.env.NODE_ENV !== 'production';
      return res.status(502).json({
        error: 'upstream_error',
        ...(isDev && { status: anthropicRes.status, detail: errText.slice(0, 200) }),
      });
    }

    const data = await anthropicRes.json();
    if (!data.content || !data.content.length) {
      return res.status(502).json({ error: 'empty_response' });
    }

    const text = data.content.map(b => b.text || '').join('');
    // 整理結果テキストのみをフロントに返す（APIキー・内部情報は一切含まない）
    return res.status(200).json({ result: text });

  } catch (err) {
    console.error('[IntakeAI] サーバーエラー:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }
}
