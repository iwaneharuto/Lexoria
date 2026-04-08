import { normalizeEmail } from "./authStore.js";

/** UUID v1–v8 style (Postgres gen_random_uuid) */
export function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(s || "").trim()
  );
}

function cloneJson(obj) {
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {
    return {};
  }
}

const HISTORY_SUMMARY_FALLBACK = "要約未生成";

function trimStr(v) {
  if (v == null) return "";
  return String(v).trim();
}

/** mainIssues / potentialIssues / memo（クライアントの computeHistorySummaryForStorage に準拠） */
function summaryFromStructuredFields(entry) {
  if (!entry || typeof entry !== "object") return "";
  const out = entry.output && typeof entry.output === "object" ? entry.output : null;
  const main = Array.isArray(entry.mainIssues) ? entry.mainIssues : Array.isArray(out?.mainIssues) ? out.mainIssues : null;
  const bits = [];
  if (Array.isArray(main)) {
    for (let i = 0; i < main.length && bits.length < 3; i++) {
      const line = trimStr(main[i]);
      if (line) bits.push(line);
    }
  }
  if (bits.length) return bits.join(" / ");
  const pot = Array.isArray(entry.potentialIssues)
    ? entry.potentialIssues
    : Array.isArray(out?.potentialIssues)
      ? out.potentialIssues
      : null;
  if (Array.isArray(pot)) {
    const bits2 = [];
    for (let j = 0; j < pot.length && bits2.length < 2; j++) {
      const pi = pot[j];
      let one = "";
      if (pi && typeof pi === "object")
        one = trimStr(pi.issue != null ? pi.issue : pi.title != null ? pi.title : "");
      else one = trimStr(pi);
      if (one) bits2.push(one);
    }
    if (bits2.length) return bits2.join(" / ");
  }
  if (entry.memo != null) {
    const memo = String(entry.memo).replace(/\s+/g, " ").trim();
    if (memo) return memo.length > 280 ? memo.slice(0, 280) : memo;
  }
  return "";
}

/**
 * DB の summary NOT NULL 用。undefined / 空はフォールバックで必ず非空文字列。
 */
export function resolveHistorySummaryForDb(entry) {
  if (!entry || typeof entry !== "object") return HISTORY_SUMMARY_FALLBACK;
  const out = entry.output && typeof entry.output === "object" ? entry.output : null;
  const candidates = [
    trimStr(entry.summary),
    trimStr(out?.summary),
    trimStr(entry.consultationTitle),
    trimStr(entry.title),
    trimStr(out?.consultationTitle),
    trimStr(out?.title),
    summaryFromStructuredFields(entry),
  ];
  for (const t of candidates) {
    if (t) return t;
  }
  return HISTORY_SUMMARY_FALLBACK;
}

/**
 * DB row → アプリ履歴エントリ（showResult / renderHist 互換）
 */
export function mapDbRowToAppEntry(row) {
  if (!row || typeof row !== "object") return null;
  const rj =
    row.result_json && typeof row.result_json === "object" ? cloneJson(row.result_json) : {};
  const out = { ...rj };
  out.id = row.id;
  if (row.title != null) out.title = row.title;
  out.consultationTitle = out.consultationTitle || out.title || row.title || "";
  if (row.memo != null) out.memo = row.memo;
  out.pinned = row.pinned === true;
  out.favorite = row.favorite === true;
  out.jurisdiction = row.jurisdiction || out.jurisdiction || "JP";
  out.user_id = row.user_id || out.user_id || null;
  out.userId = out.userId || out.user_id || null;
  out.uiLang = row.ui_lang || out.uiLang;
  out.createdBy = row.owner_email;
  if (!out.createdByName) out.createdByName = row.assignee || row.owner_email;
  out.savedAt = row.updated_at || out.savedAt;
  out.createdAt = row.created_at || out.createdAt;
  out.updated_at = row.updated_at || out.updated_at || null;
  out.created_at = row.created_at || out.created_at || null;
  if (row.summary != null) out.summary = row.summary;
  if (row.source_local_id != null && String(row.source_local_id).trim() !== "") {
    out.sourceLocalId = String(row.source_local_id).trim();
  }
  const tg = Array.isArray(row.tags) ? row.tags : [];
  if (tg.length) {
    out.tags = tg;
    if (!out.output || typeof out.output !== "object") out.output = {};
    out.output.tags = tg;
  }
  out._supabase = true;
  return out;
}

/**
 * アプリ履歴エントリ → history テーブル用ペイロード（insert/update）
 * @param {string} emailNorm
 * @param {object} entry
 * @param {{ lexoriaUserId?: string|null }} [meta]
 */
export function appEntryToDbRow(emailNorm, entry, meta = {}) {
  const em = normalizeEmail(emailNorm);
  const tagsRaw = entry.output?.tags ?? entry.tags ?? [];
  const tagArr = Array.isArray(tagsRaw) ? tagsRaw : [];
  const title = String(entry.title || entry.consultationTitle || "").trim();
  const summary = resolveHistorySummaryForDb(entry);
  const jurisdiction = entry.jurisdiction === "US" ? "US" : "JP";
  const uiLang = entry.uiLang === "en" ? "en" : "ja";
  const result_json = cloneJson(entry);
  const row = {
    owner_email: em,
    title: title || null,
    tags: tagArr,
    summary,
    result_json,
    jurisdiction,
    ui_lang: uiLang,
    pinned: !!entry.pinned,
    favorite: !!entry.favorite,
    deleted: false,
    memo: entry.memo != null ? String(entry.memo) : "",
    assignee: entry.assignee || entry.createdByName || null,
    source_local_id: isUuid(entry.id) ? null : String(entry.id),
  };
  const uid =
    meta.lexoriaUserId != null && meta.lexoriaUserId !== ""
      ? String(meta.lexoriaUserId).trim()
      : "";
  if (uid && isUuid(uid)) {
    row.user_id = uid;
  }
  return row;
}
