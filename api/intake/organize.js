// api/intake/organize.js
// AI: Anthropic Claude（@anthropic-ai/sdk）

import Anthropic from "@anthropic-ai/sdk";
import { getStoredUser, verifyPassword, putStoredUser, normalizeEmail } from "../../lib/authStore.js";
import {
  evaluateOrganizeAccess,
  isPaidSubscriptionActive,
  pickUserMessage,
} from "../../lib/trialAccess.js";

const ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";

const PLACEHOLDER_STRINGS = new Set([
  // JP
  "要確認",
  "該当情報なし",
  "不明",
  // EN
  "Unknown",
  "Not provided",
  "To confirm",
  "To be confirmed",
  "Not specified",
  "N/A",
  "TBD",
  "None",
  "No information",
  "Pending confirmation",
  "To be determined",
]);

/** US titles / issues that must never be shown as final output */
const US_BOILERPLATE_TITLE_RE =
  /intake title to be confirmed|to be confirmed after review|pending review of the narrative/i;

const US_BOILERPLATE_ISSUE_RE =
  /issue themes to be confirmed|themes to be confirmed after counsel/i;

function isBoilerplateUsTitle(s) {
  const t = typeof s === "string" ? s.trim() : "";
  if (!t) return true;
  if (t === "要確認") return true;
  return US_BOILERPLATE_TITLE_RE.test(t);
}

function isBoilerplateUsIssue(s) {
  const t = typeof s === "string" ? s.trim() : "";
  if (!t) return true;
  return US_BOILERPLATE_ISSUE_RE.test(t);
}

/** Max length for compact US consultationTitle (5–8 words target). */
const US_CONSULTATION_TITLE_MAX_LEN = 80;

const US_CONSULTATION_TITLE_PLACEHOLDER =
  "Legal intake — title unavailable";

/** When the model leaves relatedStatutes empty, attach typical anchors from issue + memo (not legal advice). */
function suggestUsStatutesForIssue(issueText, stateCode, sourceText = "") {
  const blob = `${issueText || ""} ${sourceText || ""}`.slice(0, 2500);
  const lower = blob.toLowerCase();
  const out = [];
  const pushU = (arr) => {
    for (const x of arr) {
      const c = cleanText(x);
      if (c && !out.includes(c)) out.push(c);
    }
  };

  if (
    /non[\s-]?compete|restrictive\s+covenant|covenants?\s+not\s+to\s+compete|noncompete/i.test(
      blob
    )
  ) {
    pushU([
      "Cal. Bus. & Prof. Code § 16600 — restraint of employment in California (broadly disfavored for employees)",
      "Tex. Bus. & Com. Code § 15.50 — reasonableness and ancillary covenant requirements in Texas",
      "Delaware contract/equity — covenant enforceability often turns on reasonableness and protectable interests",
    ]);
  }
  if (
    /wage|overtime|final\s+pay|paycheck|payroll|flsa|unpaid\s+wages|meal\s+break|rest\s+break/i.test(
      blob
    )
  ) {
    pushU([
      "Cal. Labor Code §§ 201–203 — wage payment timing on discharge or quit",
      "29 U.S.C. §§ 206–207 — federal minimum wage and overtime (FLSA)",
      "Tex. Labor Code § 61.014 — wage payment to terminated employees",
    ]);
  }
  if (/discriminat|harass|retaliat|title\s*vii|ada\b|fmla/i.test(blob)) {
    pushU([
      "42 U.S.C. § 2000e et seq. — Title VII framework (if employment discrimination alleged)",
      "42 U.S.C. § 12101 et seq. — ADA framework (if disability accommodation alleged)",
    ]);
  }
  if (/wrongful\s+terminat|at-?will|whistleblow/i.test(blob)) {
    pushU([
      "State common law / contract — wrongful termination and public-policy exceptions (fact-specific)",
      "Federal retaliation statutes — if protected activity and adverse action are alleged",
    ]);
  }
  if (/contract\s+breach|material\s+breach|specific\s+performance/i.test(blob)) {
    pushU([
      "Uniform Commercial Code (as applicable) — sale/goods issues if commercial transaction",
      "State contract law — breach, damages, and remedies (fact-specific)",
    ]);
  }

  if (stateCode === "CA" && out.length) {
    const caFirst = out.filter((s) => /cal\.|california|b&p|labor code/i.test(s));
    const rest = out.filter((s) => !caFirst.includes(s));
    return [...caFirst, ...rest].slice(0, 3);
  }
  if (stateCode === "TX" && out.length) {
    const txFirst = out.filter((s) => /tex\.|texas/i.test(s));
    const rest = out.filter((s) => !txFirst.includes(s));
    return [...txFirst, ...rest].slice(0, 3);
  }
  return out.slice(0, 3);
}

function enrichUsPotentialIssues(issues, stateCode, sourceText) {
  if (!Array.isArray(issues) || !issues.length) return issues;
  return issues.map((row) => {
    if (!row || typeof row !== "object") return row;
    let statutes = normalizeStringArray(row.relatedStatutes);
    let issue = cleanText(row.issue) || "";
    if (isBoilerplateUsIssue(issue)) {
      const hint = (sourceText || "").trim().slice(0, 88).replace(/\s+/g, " ");
      issue = hint
        ? `Themes from intake: ${hint}${(sourceText || "").trim().length > 88 ? "…" : ""}`
        : "Themes derived from the intake narrative";
    }
    if (!statutes.length) {
      statutes = suggestUsStatutesForIssue(issue, stateCode, sourceText);
    }
    if (!statutes.length) {
      statutes = [
        "Identify governing federal/state statutes after confirming claims and venue (typical anchors may include contract, employment, or tort codes).",
      ];
    }
    return { ...row, issue: issue || row.issue, relatedStatutes: statutes };
  });
}

function isGenericUsBoilerplateSentence(s) {
  const t = (typeof s === "string" ? s.trim() : "").toLowerCase();
  if (!t) return true;
  if (/^based on the provided information[,.]?\s*$/.test(t)) return true;
  if (t.startsWith("based on the provided information") && t.length < 140) return true;
  if (/\bnot provided\b/.test(t) && t.length < 100) return true;
  if (/\bto be confirmed\b/.test(t) && t.length < 120) return true;
  return false;
}

function cleanText(value) {
  if (value == null) return "";
  const s =
    typeof value === "string" ? value.trim() : String(value ?? "").trim();
  if (!s) return "";
  if (PLACEHOLDER_STRINGS.has(s)) return "";
  return s;
}

/** Date/time tokens that must not appear in factsChronology (treated as unspecified). */
const BANNED_FACT_DATE_TOKENS = new Set([
  "不明",
  "unknown",
  "Unknown",
  "UNKNOWN",
  "日時不明",
  "n/a",
  "N/A",
  "tbd",
  "TBD",
  "not specified",
  "Not specified",
  "not stated",
  "Not stated",
  "date unknown",
  "Date unknown",
  "unspecified",
  "Unspecified",
  "unknown date",
  "Unknown date",
  "unknown date/time",
  "Unknown date/time",
]);

function isUnspecifiedDateOrTime(s) {
  const t = typeof s === "string" ? s.trim() : "";
  if (!t) return true;
  if (BANNED_FACT_DATE_TOKENS.has(t)) return true;
  if (/^unknown(\s+date)?(\s*\/\s*time)?$/i.test(t)) return true;
  if (/^不明$/u.test(t)) return true;
  return false;
}

/** Scrub banned wording from narrative facts (model slip-through). */
function sanitizeFactProse(s, jurisdiction = "JP") {
  if (!s || typeof s !== "string") return "";
  let t = s.trim();
  if (!t) return "";
  if (jurisdiction === "US") {
    t = t.replace(/\bUnknown\b/gi, "unclear in the intake narrative");
    t = t.replace(/不明/gu, "unclear in the intake narrative");
  } else {
    t = t.replace(/\bUnknown\b/gi, "相談文に明示されていない");
  }
  return t.trim();
}

/**
 * Remove repeated intake disclaimers from each fact line (section title states intake basis).
 */
function stripFactIntakePreamble(text, jurisdiction = "JP") {
  if (!text || typeof text !== "string") return text;
  let t = text.trim();
  if (!t) return t;
  // English disclaimers (apply for US and for JP when uiLang outputs English facts)
  t = t
    .replace(/^Based on the (?:provided )?intake(?: narrative| note)?[,;]\s*/i, "")
    .replace(/^According to the intake[,;]\s*/i, "")
    .replace(/^From the intake(?: narrative| note)?[,;]\s*/i, "")
    .replace(/^Per the intake[,;]\s*/i, "")
    .replace(/^As described in the intake[,;]\s*/i, "")
    .replace(/^The intake (?:states|indicates|describes) that[,;]\s*/i, "");
  if (jurisdiction !== "US") {
    t = t
      .replace(/^相談文に基づく限り[、,]\s*/gu, "")
      .replace(/^相談文に基づいて[、,]\s*/gu, "")
      .replace(/^相談文によれば[、,]\s*/gu, "")
      .replace(/^相談文上[、,]\s*/gu, "")
      .replace(/^相談文から読み取れる限り[、,]\s*/gu, "")
      .replace(/^相談文から合理的に読み取れる範囲では[、,]\s*/gu, "");
  }
  return t.trim();
}

/** Strip English boilerplate from verification lines (JP uiLang=en and US). */
function stripVerificationEnglishBoilerplate(t) {
  let s = typeof t === "string" ? t.trim() : String(t ?? "").trim();
  if (!s) return "";
  s = s.replace(/^whether\s+/i, "");
  s = s.replace(/^(please\s+)?confirm\s+/i, "");
  s = s.replace(/^it is unclear whether\s+/i, "");
  s = s.replace(/^clarify\s+/i, "");
  s = s.replace(/\s+is not (?:specified|provided|clear|available|stated)(?:\s+in\s+the\s+intake)?[^.!?]*[.!?]?$/i, "");
  s = s.replace(/\s+was not specified[^.!?]*[.!?]?$/i, "");
  s = s.replace(/\s+cannot be determined from\s+(?:the\s+)?intake[^.!?]*[.!?]?$/i, "");
  s = s.replace(/\s+requires?\s+(?:clarification|confirmation|further confirmation)[^.!?]*[.!?]?$/i, "");
  s = s.replace(/\s+needs?\s+to be confirmed[^.!?]*[.!?]?$/i, "");
  s = s.replace(/\s+should be confirmed with the client[^.!?]*[.!?]?$/i, "");
  s = s.replace(/\s+must be verified[^.!?]*[.!?]?$/i, "");
  return s.trim();
}

/**
 * verificationItems: noun phrase only — strip boilerplate about intake gaps (JP/US).
 */
function compactVerificationItem(text, jurisdiction = "JP") {
  let t = typeof text === "string" ? text.trim() : String(text ?? "").trim();
  if (!t) return "";
  t = stripVerificationEnglishBoilerplate(t);
  if (jurisdiction === "US") {
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length > 10) t = words.slice(0, 10).join(" ");
    return t.trim();
  }
  const m1 = t.match(/^(.+?)は相談文に記載がなく/u);
  if (m1 && m1[1].trim().length >= 2) return m1[1].trim();
  const m2 = t.match(/^(.+?)は相談文からは判別できず/u);
  if (m2 && m2[1].trim().length >= 2) return m2[1].trim();
  const m3 = t.match(/^(.+?)は、?相談文のみでは判別できず/u);
  if (m3 && m3[1].trim().length >= 2) return m3[1].trim();
  const m4 = t.match(/^(.+?)については相談文/u);
  if (m4 && m4[1].trim().length >= 2) return m4[1].trim();
  t = t.replace(/は相談文に記載がなく[、,]?.+$/u, "").trim();
  t = t.replace(/は相談文上明示されていないため.+$/u, "").trim();
  t = t.replace(/[、,]\s*クライアントに確認が必要である[。.]?$/u, "").trim();
  t = t.replace(/[、,]\s*確認が必要である[。.]?$/u, "").trim();
  t = t.replace(/[、,]\s*要確認[。.]?$/u, "").trim();
  return t.trim();
}

function normalizeStringArray(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const s = cleanText(item);
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** Tags must name substance (field / charge / issue), not process or generic counsel activity */
const ABSTRACT_TAG_PATTERNS_EN = [
  /^legal intake$/i,
  /^issue identification$/i,
  /^fact review$/i,
  /^intake review$/i,
  /^follow[- ]?up$/i,
  /^legal issues?$/i,
  /^issue review$/i,
  /^client intake$/i,
  /^general legal matter$/i,
  /^attorney work$/i,
  /^counsel activity$/i,
  /^legal services?$/i,
  /^case management$/i,
  /^document review$/i,
  /^intake process$/i,
  /^initial assessment$/i,
  /^legal matter$/i,
  /^matter review$/i,
  /^practice of law$/i,
];
const OVERLY_BROAD_US_TAGS = new Set([
  "criminal law",
  "civil law",
  "employment law",
  "family law",
  "tax law",
  "immigration law",
  "corporate law",
  "real estate law",
  "intellectual property law",
  "administrative law",
  "general civil",
  "general legal matter",
]);

function isAbstractOrProcessTag(s, jurisdiction) {
  const t = typeof s === "string" ? s.trim() : String(s ?? "").trim();
  if (!t) return true;
  if (jurisdiction === "US") {
    if (OVERLY_BROAD_US_TAGS.has(t.toLowerCase())) return true;
    if (ABSTRACT_TAG_PATTERNS_EN.some((re) => re.test(t))) return true;
    if (/^(legal |case )?intake\b/i.test(t) && t.length < 28) return true;
    if (/^fact(s)?\s+review$/i.test(t)) return true;
    if (/^issue(s)?\s+identification$/i.test(t)) return true;
    return false;
  }
  if (t.includes("弁護活動")) return true;
  if (
    /^(法律相談|相談|論点整理|確認事項|要確認|相談対応|整理作業|初回相談)$/u.test(
      t
    )
  )
    return true;
  return false;
}

/** Order: field → offense/cause → supporting / stage */
function sortTagsBySubstantivePriority(tags, jurisdiction) {
  const isUS = jurisdiction === "US";
  const tier = (s) => {
    const t = typeof s === "string" ? s : String(s);
    if (isUS) {
      if (
        /\b(criminal law|civil law|employment law|family law|tax law|immigration|corporate law|real estate|intellectual property|administrative law)\b/i.test(
          t
        )
      )
        return 0;
      if (/\b(law|litigation)\s*$/i.test(t) && t.length < 22) return 0;
      if (
        /\b(homicide|murder|manslaughter|assault|fraud|theft|burglary|robbery|dui|dwi|drug|sexual|battery|breach of contract|wrongful termination|discrimination|non-?compete|wage|overtime|harassment|defamation|negligence)\b/i.test(
          t
        )
      )
        return 1;
      if (
        /\b(investigation|pre-?arrest|pre-?trial|post-?conviction|arrest|indictment|sentencing|appeal stage)\b/i.test(
          t
        )
      )
        return 2;
      return 3;
    }
    if (/刑事|刑法|刑事事件/u.test(t)) return 0;
    if (/民事|民法/u.test(t) && t.length < 12) return 0;
    if (/労働|雇用|家族|行政|税/u.test(t) && t.length < 14) return 0;
    if (
      /殺人|傷害|詐欺|窃盗|横領|放火|性犯罪|交通|過失|名誉毀損|不法行為|契約|債務不履行|解雇|競業|賃金/u.test(
        t
      )
    )
      return 1;
    if (/捜査|逮捕前|起訴|公判|示談/u.test(t)) return 2;
    return 3;
  };
  return [...tags].sort((a, b) => {
    const d = tier(a) - tier(b);
    if (d !== 0) return d;
    return String(a).localeCompare(String(b), isUS ? "en" : "ja");
  });
}

function inferSubstantiveTagsFromBlob(blob, jurisdiction) {
  const isUS = jurisdiction === "US";
  const b = (blob || "").slice(0, 1200);
  if (isUS) {
    if (/homicid|murder|manslaughter|killed|stabb?ing|dead body|mutilat/i.test(b))
      return ["Criminal law", "Homicide", "Evidence"];
    if (/fraud|embezzl|wire fraud|securities/i.test(b))
      return ["Criminal law", "Fraud", "Evidence"];
    if (/employ|terminat|wage|overtime|discriminat|harass|fmla|ada\b/i.test(b))
      return ["Termination", "Wages", "Retaliation"];
    if (/non-?compete|restrictive covenant/i.test(b))
      return ["Non-compete", "Contract", "Termination"];
    if (/contract|breach|msa|sow|invoice/i.test(b))
      return ["Contract", "Breach", "Damages"];
    if (/divorce|custody|alimony|marriage/i.test(b))
      return ["Family law", "Custody", "Support"];
    return ["Liability", "Remedies", "Damages"];
  }
  if (/殺人|死体|死傷|刺傷|被害者死亡/u.test(b))
    return ["刑事", "殺人", "証拠"];
  if (/詐欺|横領|窃盗/u.test(b)) return ["刑事", "詐欺・財産犯", "証拠"];
  if (/解雇|賃金|残業|雇用|労働|ハラスメント/u.test(b))
    return ["労働", "解雇", "賃金"];
  if (/競業避止|退職/u.test(b)) return ["労働", "競業避止", "契約"];
  if (/離婚|親権|養育費/u.test(b)) return ["家族法", "親権", "財産分与"];
  if (/契約|債務不履行|損害賠償/u.test(b))
    return ["民事", "契約", "損害賠償"];
  return ["民事", "紛争", "立証"];
}

function toTitleCaseWords(s) {
  return String(s || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function sanitizeSingleTagLabel(raw, jurisdiction) {
  const isUS = jurisdiction === "US";
  let s = typeof raw === "string" ? raw : String(raw ?? "");
  s = s.trim();
  if (!s) return "";
  // Remove bullets / numbering ("1.", "(1)", "- ", etc.)
  s = s.replace(/^[\s\u3000]*(?:[-*•]+|\(?\d+\)?[.)]?|[A-Za-z][.)])\s*/g, "");
  // Remove trailing standalone counts ("Employment law 1")
  s = s.replace(/\s+\d{1,2}$/g, "");
  // Keep a compact first segment only
  s = s.split(/[|:/\n\r;]+/)[0].trim();
  s = s.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  s = s.replace(/\s{2,}/g, " ");
  if (!s) return "";

  if (isUS) {
    const lower = s.toLowerCase();
    if (
      /^(identify|list|summarize|extract|primary|main|concrete|suggested)\b/i.test(
        lower
      )
    )
      return "";
    if (
      /\b(theme|themes|suggested by|analysis|summary|description|explanation)\b/i.test(
        lower
      )
    )
      return "";
    const words = s.split(/\s+/).filter(Boolean);
    if (words.length === 0) return "";
    // Keep noun-like compact labels: 1-3 words max
    const compact = words.slice(0, 3).join(" ");
    if (compact.length > 28) return compact.slice(0, 27).trim() + "…";
    return toTitleCaseWords(compact);
  }

  if (/[。！？]/u.test(s)) s = s.split(/[。！？]/u)[0].trim();
  if (s.length > 16) s = s.slice(0, 15).trim() + "…";
  return s;
}

/** 3–5 short issue labels; US = English, JP = Japanese */
function normalizeTagsArray(raw, jurisdiction) {
  const isUS = jurisdiction === "US";
  const arr = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const s = sanitizeSingleTagLabel(item, jurisdiction);
    if (!s || s.length < 2) continue;
    if (isAbstractOrProcessTag(s, jurisdiction)) continue;
    const key = isUS ? s.toLowerCase() : s;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= 5) break;
  }
  return out;
}

function buildTagsFallbackFromIssues(mainIssues, potentialIssues, jurisdiction) {
  const isUS = jurisdiction === "US";
  const out = [];
  const seen = new Set();
  const add = (s) => {
    const t = typeof s === "string" ? s.trim() : cleanText(s);
    if (!t || t.length < 2) return;
    if (isAbstractOrProcessTag(t, jurisdiction)) return;
    const key = isUS ? t.toLowerCase() : t;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };

  if (Array.isArray(potentialIssues)) {
    for (const pi of potentialIssues.slice(0, 3)) {
      if (!pi || typeof pi !== "object") continue;
      const iss = cleanText(pi.issue);
      if (!iss) continue;
      if (isUS) {
        const words = iss
          .replace(/[,;:]/g, " ")
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 3)
          .join(" ");
        if (words) add(sanitizeSingleTagLabel(words, jurisdiction));
      } else {
        const chunk = iss.split(/[。．\n]/u)[0].trim();
        add(sanitizeSingleTagLabel(chunk, jurisdiction));
      }
    }
  }
  if (Array.isArray(mainIssues)) {
    for (const mi of mainIssues.slice(0, 3)) {
      const s = cleanText(String(mi));
      if (!s) continue;
      if (isUS) {
        const words = s
          .replace(/[,;:]/g, " ")
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 3)
          .join(" ");
        if (words) add(sanitizeSingleTagLabel(words, jurisdiction));
      } else {
        const chunk = s.split(/[。．\n]/u)[0].trim();
        add(sanitizeSingleTagLabel(chunk, jurisdiction));
      }
    }
  }
  return out.slice(0, 8);
}

function finalizeIssueTags(
  baseTags,
  mainIssues,
  potentialIssues,
  jurisdiction,
  sourceText = ""
) {
  let tags = normalizeTagsArray(baseTags, jurisdiction);
  if (tags.length < 2) {
    const extra = buildTagsFallbackFromIssues(
      mainIssues,
      potentialIssues,
      jurisdiction
    );
    for (const t of extra) {
      if (tags.length >= 5) break;
      if (isAbstractOrProcessTag(t, jurisdiction)) continue;
      const key = jurisdiction === "US" ? t.toLowerCase() : t;
      const dup = tags.some((x) =>
        jurisdiction === "US" ? x.toLowerCase() === key : x === key
      );
      if (dup) continue;
      tags.push(t);
    }
  }
  tags = sortTagsBySubstantivePriority(tags, jurisdiction);
  tags = tags.slice(0, 5);
  if (jurisdiction === "US") {
    const blob = [
      sourceText || "",
      ...(Array.isArray(mainIssues) ? mainIssues : []).map(String),
      ...(Array.isArray(potentialIssues) ? potentialIssues : [])
        .map((p) => (p && typeof p === "object" ? String(p.issue || "") : String(p || ""))),
      ...tags,
    ]
      .join(" ")
      .toLowerCase();
    const preferred = [
      { key: "Retaliation", re: /retaliat|whistleblow|protected activity/ },
      { key: "Termination", re: /terminat|fired|dismiss|layoff|wrongful discharge/ },
      { key: "Wages", re: /wage|overtime|unpaid|salary|payroll|final pay/ },
      { key: "Non-compete", re: /non-?compete|restrictive covenant|solicit/ },
    ].filter((it) => it.re.test(blob)).map((it) => it.key);
    if (preferred.length) {
      const picked = [...new Set(preferred)].slice(0, 3);
      tags = picked.concat(tags.filter((t) => !picked.some((p) => p.toLowerCase() === String(t).toLowerCase()))).slice(0, 5);
    }
  }
  if (tags.length < 2) {
    const blob = [
      sourceText,
      ...(Array.isArray(mainIssues) ? mainIssues : []).map(String),
      ...(Array.isArray(potentialIssues) ? potentialIssues : [])
        .filter((p) => p && typeof p === "object")
        .map((p) => cleanText(p.issue)),
    ].join(" ");
    tags = inferSubstantiveTagsFromBlob(blob, jurisdiction);
    tags = tags.filter((t) => !isAbstractOrProcessTag(t, jurisdiction));
    tags = sortTagsBySubstantivePriority(tags, jurisdiction).slice(0, 5);
  }
  return tags;
}

const SECTION_ORDER = [
  "consultationTitle",
  "tags",
  "mainIssues",
  "initialChecks",
  "factsChronology",
  "verificationItems",
  "potentialIssues",
  "clientClaims",
  "possibleEvidence",
];

function buildEmptyResult(sourceText = "", jurisdiction = "JP", state = null) {
  const isUS = jurisdiction === "US";
  return {
    jurisdiction,
    state,
    consultationTitle: isUS
      ? sourceText.trim()
        ? "US legal intake — structured output unavailable; review narrative manually"
        : "Intake narrative (empty)"
      : "要確認",
    tags: isUS
      ? ["Civil law", "Liability", "Remedies"]
      : ["民事", "紛争", "立証"],
    mainIssues: isUS
      ? [
          sourceText.trim()
            ? "Review the intake narrative below and isolate 2–4 concrete dispute themes."
            : "Obtain a factual narrative from the client before isolating legal themes.",
        ]
      : ["該当情報なし"],
    initialChecks: isUS
      ? [
          sourceText.trim()
            ? "Confirm identities, key dates, written agreements, and any HR or agency filings mentioned in the intake."
            : "Collect party IDs, timeline, contracts, and communications from the client.",
        ]
      : ["要確認"],
    factsChronology: isUS
      ? [
          sourceText.trim()
            ? factRowFromSourceExcerpt(sourceText)
            : {
                dateOrTime: "",
                event:
                  "No intake text was supplied; obtain a chronological narrative from the client.",
                source: "Intake note",
              },
        ]
      : [
          {
            dateOrTime: "",
            event:
              "相談文が空のため、ここでは事実経過を整理できない。受任後に経過（時系列）をヒアリングして整理するとよい。",
            source: "相談文",
          },
        ],
    verificationItems: isUS
      ? [
          sourceText.trim()
            ? "Dates, amounts, document custody"
            : "Intake narrative detail",
        ]
      : ["要確認"],
    potentialIssues: isUS
      ? [
          {
            issue: "Primary legal themes suggested by the intake narrative",
            relatedStatutes: suggestUsStatutesForIssue(
              "employment contract wages",
              null,
              sourceText
            ),
            supremeCourtPrecedents: [],
          },
        ]
      : [
          {
            issue: "要確認",
            relatedStatutes: ["要確認"],
            supremeCourtPrecedents: [],
          },
        ],
    clientClaims: isUS
      ? [
          sourceText.trim()
            ? "The intake narrative should be reread to extract the client’s stated concerns and desired outcomes in the client’s own terms."
            : "No client narrative was provided; record the client’s objectives after interview.",
        ]
      : ["該当情報なし"],
    possibleEvidence: isUS
      ? [
          sourceText.trim()
            ? "Identify emails, agreements, pay records, policies, and HR correspondence referenced or implied by the intake."
            : "No intake text; ask the client which documents exist (contracts, pay stubs, warnings, filings).",
        ]
      : ["該当情報なし"],
    ...(isUS
      ? {
          governingLawChoice: {
            primary: "Undetermined pending review of contacts and written clauses",
            secondary: "",
            otherPossible: [],
            reasoning:
              "No intake text was supplied; rank contacts using client interview and any agreements.",
            uncertaintyNote:
              "Confirm choice-of-law and forum clauses and material contacts before fixing applicable law.",
          },
          keyLegalIssuesStateComparison: [
            {
              topic: "No themes (empty intake)",
              california:
                "California treatment depends on the claims and facts once the narrative is obtained.",
              texas:
                "Texas treatment depends on the claims and facts once the narrative is obtained.",
              delaware:
                "Delaware treatment (contract/equity) depends on the claims and facts once the narrative is obtained.",
              impact:
                "Cross-state comparison requires a concrete fact pattern and claimed relief.",
            },
          ],
        }
      : {}),
    supremeCourtCase: null,
    meta: {
      sourceTextLength: sourceText ? sourceText.length : 0,
      normalized: true,
      fallbackUsed: true,
    },
  };
}

function uniqueStrings(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const result = [];

  for (const item of arr) {
    const value = cleanText(item);

    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }

  return result;
}

function ensureNonEmptyArray(arr, fallbackValue) {
  const cleaned = uniqueStrings(arr);
  return cleaned.length > 0 ? cleaned : [fallbackValue];
}

function sanitizeTitle(value) {
  const text =
    typeof value === "string" && value.trim() ? value.trim() : "要確認";
  return text.length > 80 ? text.slice(0, 80) : text;
}

function normalizeUsConsultationTitleLength(title) {
  const t = typeof title === "string" ? title.trim() : "";
  if (!t) return "";
  if (t.length <= US_CONSULTATION_TITLE_MAX_LEN) return t;
  const words = t.split(/\s+/).filter(Boolean);
  const clipped = [];
  let chars = 0;
  for (const w of words) {
    const add = clipped.length ? 1 + w.length : w.length;
    if (chars + add > US_CONSULTATION_TITLE_MAX_LEN) break;
    clipped.push(w);
    chars += add;
  }
  return clipped.join(" ").trim() || t.slice(0, US_CONSULTATION_TITLE_MAX_LEN).trim();
}

/**
 * Fallback when the model title is missing, boilerplate, or looks copied from the opening sentence.
 * Uses normalized themes only (not the raw first line of the intake).
 */
function buildUsConsultationTitleFallback(mainIssues, potentialIssues) {
  const mains = Array.isArray(mainIssues)
    ? mainIssues.map((x) => cleanText(String(x))).filter(Boolean)
    : [];
  const firstIssue =
    Array.isArray(potentialIssues) && potentialIssues[0]
      ? cleanText(potentialIssues[0].issue)
      : "";

  if (mains[0] && firstIssue) {
    const a = mains[0].replace(/\.$/, "");
    const b = firstIssue.replace(/\.$/, "");
    const combined = `${a} — ${b}`;
    return normalizeUsConsultationTitleLength(combined);
  }
  if (firstIssue) return normalizeUsConsultationTitleLength(firstIssue);
  if (mains[0]) return normalizeUsConsultationTitleLength(mains[0]);
  return "Legal intake — client narrative and dispute themes pending review";
}

function isLikelyCopiedOpeningSentence(title, sourceText) {
  const t = (title || "").trim();
  const raw = (sourceText || "").trim();
  if (!t || !raw) return false;

  const firstLine =
    raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) || "";
  if (!firstLine) return false;

  const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const nt = norm(t).replace(/[.…]+$/u, "");
  const nf = norm(firstLine).replace(/[.…]+$/u, "");
  const n = Math.min(52, nt.length, nf.length);
  if (n >= 24 && nf.slice(0, n) === nt.slice(0, n)) return true;

  if (/^(i|we)\s+(was|were|am|is|are|have|had|work|worked)\b/i.test(t))
    return true;

  return false;
}

function buildUsCaseNameFromSignals(sourceText, mainIssues, potentialIssues) {
  const blob = [
    sourceText || "",
    ...(Array.isArray(mainIssues) ? mainIssues : []).map(String),
    ...(Array.isArray(potentialIssues) ? potentialIssues : [])
      .map((p) => (p && typeof p === "object" ? String(p.issue || "") : String(p || ""))),
  ]
    .join(" ")
    .toLowerCase();

  const signals = [];
  if (/retaliat|whistleblow|complain|protected activity/.test(blob)) signals.push("Retaliation");
  if (/terminat|fired|dismiss|wrongful discharge|layoff/.test(blob)) signals.push("Termination");
  if (/wage|overtime|unpaid|salary|payroll|final pay/.test(blob)) signals.push("Wage");
  if (/non-?compete|restrictive covenant|solicit/.test(blob)) signals.push("Non-compete");

  const uniq = [...new Set(signals)];
  if (uniq.length >= 3) {
    if (uniq.includes("Retaliation") && uniq.includes("Termination") && uniq.includes("Wage")) {
      return "Retaliation, Termination and Wage Dispute";
    }
    return `${uniq.slice(0, 3).join(", ")} Dispute`;
  }
  if (uniq.length === 2) return `${uniq[0]} and ${uniq[1]} Dispute`;
  if (uniq.length === 1) return `${uniq[0]} Employment Dispute`;
  return "Employment Dispute and Wage Issues";
}

function enforceUsCaseNameWordRange(title) {
  const t = String(title || "").replace(/[.!?]+$/g, "").replace(/\s+/g, " ").trim();
  if (!t) return "Employment Dispute and Wage Issues";
  let words = t.split(" ").filter(Boolean);
  if (words.length > 8) words = words.slice(0, 8);
  if (words.length < 5) {
    const filler = ["Case", "Issues"];
    while (words.length < 5 && filler.length) words.push(filler.shift());
  }
  return normalizeUsConsultationTitleLength(words.join(" "));
}

function finalizeUsConsultationTitle(rawTitle, sourceText, mainIssues, potentialIssues) {
  let t =
    typeof rawTitle === "string" && rawTitle.trim()
      ? rawTitle.trim()
      : "";

  if (!t || t === "要確認" || isBoilerplateUsTitle(t)) {
    return enforceUsCaseNameWordRange(
      buildUsCaseNameFromSignals(sourceText, mainIssues, potentialIssues)
    );
  }

  if (isLikelyCopiedOpeningSentence(t, sourceText)) {
    return enforceUsCaseNameWordRange(
      buildUsCaseNameFromSignals(sourceText, mainIssues, potentialIssues)
    );
  }

  t = sanitizeFactProse(t, "US") || t;
  // Compact case name: 5–8 words, noun-style, no trailing sentence punctuation.
  t = t.replace(/[.!?]+$/g, "").replace(/\s+/g, " ").trim();
  let words = t.split(" ").filter(Boolean).slice(0, 8);
  if (words.length < 5) {
    const fb = buildUsCaseNameFromSignals(sourceText, mainIssues, potentialIssues)
      .replace(/[.!?]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    words = fb.split(" ").filter(Boolean).slice(0, 8);
  }
  return enforceUsCaseNameWordRange(words.join(" "));
}

function normalizeFactsChronology(input, jurisdiction = "JP") {
  const isUS = jurisdiction === "US";
  const defaultSource = isUS ? "Intake note" : "相談文";
  const emptyChronologyFallback = isUS
    ? {
        dateOrTime: "",
        event:
          "No dated timeline was extracted; reconstruct sequence and dates with the client from the intake narrative.",
        source: defaultSource,
      }
    : {
        dateOrTime: "",
        event:
          "時系列上の具体的な日付・順序は整理されていない。受任後にクライアントへ経過（年月日・順序）を確認するとよい。",
        source: defaultSource,
      };

  if (!Array.isArray(input) || input.length === 0) {
    return [emptyChronologyFallback];
  }

  const normalized = input
    .map((item) => {
      if (typeof item === "string") {
        const raw = stripFactIntakePreamble(
          sanitizeFactProse(String(item).trim(), jurisdiction),
          jurisdiction
        );
        const text = cleanText(raw);
        if (!text) return null;
        return {
          dateOrTime: "",
          event: text,
          source: defaultSource,
        };
      }

      if (!item || typeof item !== "object") return null;

      let dateOrTime = cleanText(item.dateOrTime);
      if (isUnspecifiedDateOrTime(dateOrTime)) dateOrTime = "";

      const rawEvent = stripFactIntakePreamble(
        sanitizeFactProse(
          typeof item.event === "string" ? item.event : "",
          jurisdiction
        ),
        jurisdiction
      );
      const event = cleanText(rawEvent);
      if (!event) return null;

      const source = cleanText(item.source) || defaultSource;

      return { dateOrTime, event, source };
    })
    .filter(Boolean);

  return normalized.length > 0 ? normalized : [emptyChronologyFallback];
}

function normalizePotentialIssues(input, jurisdiction = "JP") {
  const defaultPrecedents = [];
  const isUS = jurisdiction === "US";
  const defaultIssue = isUS
    ? "Primary legal themes suggested by the intake narrative"
    : "要確認";
  if (!Array.isArray(input) || input.length === 0) {
    return [
      {
        issue: defaultIssue,
        relatedStatutes: isUS ? [] : ["要確認"],
        supremeCourtPrecedents: defaultPrecedents,
      },
    ];
  }

  const normalized = input
    .map((item) => {
      if (typeof item === "string") {
        const text = cleanText(item);
        if (!text) return null;
        return {
          issue: text,
          relatedStatutes: isUS ? [] : ["要確認"],
          supremeCourtPrecedents: defaultPrecedents,
        };
      }

      if (!item || typeof item !== "object") return null;

      const issue = cleanText(item.issue) || defaultIssue;

      const relatedStatutes = normalizeStringArray(item.relatedStatutes);

      let supremeCourtPrecedents = normalizeStringArray(
        item.supremeCourtPrecedents ?? item.precedentCategories
      );

      if (isUS && supremeCourtPrecedents.length) {
        supremeCourtPrecedents = supremeCourtPrecedents.filter((s) => {
          const v = cleanText(s);
          if (!v) return false;
          const lower = v.toLowerCase();
          if (
            lower.includes("cir.") ||
            lower.includes("circuit") ||
            lower.includes("district") ||
            lower.includes("d. ") ||
            lower.includes("app.") ||
            lower.includes("court of appeals")
          ) {
            return false;
          }
          return true;
        });
      }

      return { issue, relatedStatutes, supremeCourtPrecedents };
    })
    .filter(Boolean);

  return normalized.length > 0
    ? normalized
    : [
        {
          issue: defaultIssue,
          relatedStatutes: isUS ? [] : ["要確認"],
          supremeCourtPrecedents: defaultPrecedents,
        },
      ];
}

const US_GOVERNING_LAW_FALLBACK = {
  primary: "Undetermined pending review of contacts and written clauses",
  secondary: "",
  otherPossible: [],
  reasoning:
    "Party domicile, performance location, and contractual choice-of-law language are not yet sufficient to rank CA / TX / DE contacts.",
  uncertaintyNote:
    "Review operative agreements for choice-of-law and forum-selection clauses and confirm key contacts.",
};

/**
 * US-only: structured choice-of-law (primary / secondary / other / reasoning / uncertainty).
 * Accepts legacy array of strings for backward compatibility.
 */
function normalizeGoverningLawChoiceObject(input) {
  if (input == null) return { ...US_GOVERNING_LAW_FALLBACK };

  if (Array.isArray(input)) {
    const parts = input
      .map((x) => sanitizeFactProse(cleanText(x), "US"))
      .filter(Boolean);
    if (!parts.length) return { ...US_GOVERNING_LAW_FALLBACK };
    return {
      primary: parts[0],
      secondary: parts[1] || "",
      otherPossible: parts.slice(2),
      reasoning: parts.join(" "),
      uncertaintyNote:
        "Choice-of-law contacts and any written clauses should be confirmed; the ranking above is provisional based on the intake alone.",
    };
  }

  if (typeof input !== "object") return { ...US_GOVERNING_LAW_FALLBACK };

  const primary = sanitizeFactProse(
    cleanText(input.primary) || cleanText(input.primaryLaw) || "",
    "US"
  );
  const secondary = sanitizeFactProse(
    cleanText(input.secondary) || cleanText(input.secondaryLaw) || "",
    "US"
  );
  let otherPossible = [];
  if (Array.isArray(input.otherPossible)) {
    otherPossible = input.otherPossible
      .map((o) => sanitizeFactProse(cleanText(o), "US"))
      .filter(Boolean);
  }
  const reasoning = sanitizeFactProse(
    cleanText(input.reasoning) || cleanText(input.rationale) || "",
    "US"
  );
  let uncertaintyNote = sanitizeFactProse(
    cleanText(input.uncertaintyNote) || cleanText(input.uncertainty) || "",
    "US"
  );

  if (!primary) return { ...US_GOVERNING_LAW_FALLBACK };

  const weakRanking =
    !reasoning ||
    reasoning.length < 50 ||
    /\b(unclear|not specified|pending|confirm|provisional)\b/i.test(
      reasoning
    );
  const competing = Boolean(secondary) || otherPossible.length > 0;

  if (!uncertaintyNote && (weakRanking || competing)) {
    uncertaintyNote =
      "Applicable law cannot be determined definitively without reviewing any choice-of-law and forum-selection clauses and confirming key contacts.";
  }

  return {
    primary,
    secondary: secondary || "",
    otherPossible,
    reasoning:
      reasoning ||
      "Rank contacts using the intake narrative; confirm with operative agreements and client interview.",
    uncertaintyNote: uncertaintyNote || "",
  };
}

function stateComparisonFallbackLine(stateLabel) {
  return `${stateLabel}-specific treatment turns on the claims and facts stated in the intake; analyze ${stateLabel} law once themes are fixed.`;
}

/**
 * US-only: per-state columns + practical impact (legacy { topic, comparison } supported).
 */
function normalizeKeyLegalIssuesStateComparison(input) {
  if (!Array.isArray(input) || input.length === 0) return [];

  const out = [];
  for (const item of input) {
    if (typeof item === "string") {
      const impact = sanitizeFactProse(cleanText(item), "US");
      if (!impact) continue;
      out.push({
        topic: "Issue theme",
        california: stateComparisonFallbackLine("California"),
        texas: stateComparisonFallbackLine("Texas"),
        delaware: stateComparisonFallbackLine("Delaware"),
        impact,
      });
      continue;
    }
    if (!item || typeof item !== "object") continue;

    const topic =
      sanitizeFactProse(
        cleanText(item.topic) || cleanText(item.issueTheme) || "",
        "US"
      ) || "Issue theme";

    let california = sanitizeFactProse(
      cleanText(item.california) || cleanText(item.California) || "",
      "US"
    );
    let texas = sanitizeFactProse(
      cleanText(item.texas) || cleanText(item.Texas) || "",
      "US"
    );
    let delaware = sanitizeFactProse(
      cleanText(item.delaware) || cleanText(item.Delaware) || "",
      "US"
    );

    let impact = sanitizeFactProse(
      cleanText(item.impact) ||
        cleanText(item.practicalImpact) ||
        cleanText(item.outcomeImpact) ||
        "",
      "US"
    );
    const legacy = sanitizeFactProse(
      cleanText(item.comparison) || cleanText(item.analysis) || "",
      "US"
    );
    if (!impact && legacy) impact = legacy;
    if (!impact) continue;

    if (!california) california = stateComparisonFallbackLine("California");
    if (!texas) texas = stateComparisonFallbackLine("Texas");
    if (!delaware) delaware = stateComparisonFallbackLine("Delaware");

    out.push({ topic, california, texas, delaware, impact });
  }
  return out;
}

/** US facts: strict memo-style (used when relaxing acceptance). */
function isUsMemoQualityFactSentence(s) {
  const t = typeof s === "string" ? s.trim() : "";
  if (t.length < 25) return false;
  if (!/^[A-Z]/.test(t)) return false;
  if (!/[.!?]"?$/.test(t)) return false;
  if (/\bUnknown\b/i.test(t) || /不明/.test(t)) return false;
  return true;
}

function isAcceptableUsFactSentence(raw) {
  const t = typeof raw === "string" ? raw.trim() : "";
  if (t.length < 12) return false;
  if (isGenericUsBoilerplateSentence(t)) return false;
  if (/\bUnknown\b/i.test(t) || /不明/.test(t)) return false;
  if (isUsMemoQualityFactSentence(t)) return true;
  if (/[A-Za-z]{4,}/.test(t) && t.length >= 20 && /[.!?]$/.test(t)) return true;
  if (/[A-Za-z]{4,}/.test(t) && t.length >= 28) return true;
  return false;
}

function factRowFromSourceExcerpt(sourceText) {
  const raw = typeof sourceText === "string" ? sourceText.trim() : "";
  if (!raw) {
    return {
      dateOrTime: "",
      event:
        "The client narrative was empty; obtain a dated timeline and key documents from the client.",
      source: "Intake note",
    };
  }
  const one = raw.replace(/\s+/g, " ").slice(0, 320);
  let sent = one.match(/^.{20,280}?[.!?](?=\s|$)/);
  let text = sent ? sent[0].trim() : one.slice(0, 200).trim();
  if (!/[.!?]$/.test(text)) text += ".";
  text = text.charAt(0).toUpperCase() + text.slice(1);
  return { dateOrTime: "", event: text, source: "Intake note" };
}

function refineUsFactsChronologyAndVerification(
  factsChronology,
  verificationItems,
  sourceText = ""
) {
  const ver = Array.isArray(verificationItems)
    ? [...verificationItems]
    : [];
  let dropped = false;
  const kept = [];

  for (const row of factsChronology || []) {
    if (!row || typeof row !== "object") continue;
    const rawEv =
      typeof row.event === "string" ? row.event : String(row.event || "");
    const prose = stripFactIntakePreamble(
      sanitizeFactProse(rawEv, "US"),
      "US"
    );
    const ev = cleanText(prose);
    if (!ev) continue;
    if (isAcceptableUsFactSentence(prose)) {
      kept.push({
        ...row,
        event: prose,
        dateOrTime: cleanText(row.dateOrTime) || "",
        source: cleanText(row.source) || "Intake note",
      });
    } else {
      dropped = true;
    }
  }

  if (dropped) {
    const note = "Dates, parties, chronology sequence";
    if (!ver.some((v) => typeof v === "string" && /chronology sequence/i.test(v))) {
      ver.unshift(note);
    }
  }

  if (!kept.length && (factsChronology || []).length > 0) {
    return {
      facts: [factRowFromSourceExcerpt(sourceText)],
      verificationItems: ver,
    };
  }

  if (!kept.length) {
    return {
      facts: factsChronology || [],
      verificationItems: ver,
    };
  }

  return { facts: kept, verificationItems: ver };
}

function removeOverlap(
  initialChecks,
  verificationItems,
  jurisdiction = "JP"
) {
  const isUS = jurisdiction === "US";
  const fbInit = isUS
    ? "Confirm parties, material dates, and any written terms referenced in the intake."
    : "要確認";
  const fbVer = isUS
    ? "Missing dates, amounts, documents"
    : "要確認";
  const baseInitial = ensureNonEmptyArray(initialChecks, fbInit);
  const baseVerification = ensureNonEmptyArray(verificationItems, fbVer);

  const initialSet = new Set(baseInitial);
  const filteredVerification = baseVerification.filter(
    (item) => !initialSet.has(item)
  );

  return {
    initialChecks: baseInitial.length > 0 ? baseInitial : [fbInit],
    verificationItems:
      filteredVerification.length > 0 ? filteredVerification : [fbVer],
  };
}

function normalizeStructuredOutput(raw, sourceText = "") {
  const base = raw && typeof raw === "object" ? raw : {};
  const jurisdiction =
    typeof base.jurisdiction === "string" && base.jurisdiction.trim()
      ? base.jurisdiction.trim()
      : "JP";
  const state =
    base.state == null
      ? null
      : typeof base.state === "string" && base.state.trim()
      ? base.state.trim()
      : null;

  const fallback = buildEmptyResult(sourceText, jurisdiction, state);

  let consultationTitle =
    jurisdiction === "US" ? null : sanitizeTitle(base.consultationTitle);

  const mainIssues =
    jurisdiction === "US"
      ? (() => {
          const arr = normalizeStringArray(base.mainIssues)
            .map((s) => sanitizeFactProse(s, "US"))
            .filter(Boolean)
            .filter((s) => !isGenericUsBoilerplateSentence(s));
          return arr.length
            ? arr
            : [
                "Identify 3–4 concrete themes from the parties, timeline, and dispute trigger described in the intake.",
              ];
        })()
      : ensureNonEmptyArray(base.mainIssues, "該当情報なし");

  const overlapHandled = removeOverlap(
    base.initialChecks,
    base.verificationItems,
    jurisdiction
  );

  let factsChronology = normalizeFactsChronology(
    base.factsChronology,
    jurisdiction
  );

  let potentialIssues = normalizePotentialIssues(
    base.potentialIssues,
    jurisdiction
  );
  if (jurisdiction === "US") {
    potentialIssues = enrichUsPotentialIssues(
      potentialIssues,
      state,
      sourceText
    );
  }

  if (jurisdiction === "US") {
    consultationTitle = finalizeUsConsultationTitle(
      base.consultationTitle,
      sourceText,
      mainIssues,
      potentialIssues
    );
  }

  const firstPrecedent =
    potentialIssues.find(
      (pi) =>
        pi &&
        Array.isArray(pi.supremeCourtPrecedents) &&
        pi.supremeCourtPrecedents.length > 0 &&
        typeof pi.supremeCourtPrecedents[0] === "string" &&
        pi.supremeCourtPrecedents[0].trim()
    )?.supremeCourtPrecedents[0] ?? null;

  const supremeCourtCase =
    typeof firstPrecedent === "string" && firstPrecedent.trim()
      ? firstPrecedent.trim()
      : null;

  const clientClaims =
    jurisdiction === "US"
      ? (() => {
          const arr = normalizeStringArray(base.clientClaims)
            .map((s) => sanitizeFactProse(s, "US"))
            .filter(Boolean)
            .filter((s) => !isGenericUsBoilerplateSentence(s));
          return arr.length
            ? arr
            : [
                "Re-read the intake and list the client’s stated grievances, objectives, and requested outcomes in short memo bullets.",
              ];
        })()
      : ensureNonEmptyArray(base.clientClaims, "該当情報なし");

  const possibleEvidence =
    jurisdiction === "US"
      ? (() => {
          const arr = normalizeStringArray(base.possibleEvidence)
            .map((s) => sanitizeFactProse(s, "US"))
            .filter(Boolean)
            .filter((s) => !isGenericUsBoilerplateSentence(s));
          return arr.length
            ? arr
            : [
                "List documents the intake implies exist (contracts, pay records, emails, policies, warnings, filings) even if not named verbatim.",
              ];
        })()
      : ensureNonEmptyArray(base.possibleEvidence, "該当情報なし");

  let initialChecksOut = overlapHandled.initialChecks;
  let verificationItemsOut = overlapHandled.verificationItems;
  if (jurisdiction === "US") {
    initialChecksOut = initialChecksOut
      .map((s) => sanitizeFactProse(String(s), "US"))
      .filter(Boolean)
      .filter((s) => !isGenericUsBoilerplateSentence(s));
    verificationItemsOut = verificationItemsOut
      .map((s) => sanitizeFactProse(String(s), "US"))
      .filter(Boolean)
      .filter((s) => !isGenericUsBoilerplateSentence(s));
    if (!initialChecksOut.length) {
      initialChecksOut = [
        sourceText.trim()
          ? "Confirm parties, governing documents, and any agency filings referenced in the intake."
          : "Obtain a fuller narrative from the client to set initial priorities.",
      ];
    }
    if (!verificationItemsOut.length) {
      verificationItemsOut = [
        sourceText.trim()
          ? "Dates, amounts, missing documents"
          : "Intake narrative detail",
      ];
    }
    const refined = refineUsFactsChronologyAndVerification(
      factsChronology,
      verificationItemsOut,
      sourceText
    );
    factsChronology = refined.facts;
    verificationItemsOut = refined.verificationItems;
  }

  factsChronology = (factsChronology || []).map((row) => {
    if (!row || typeof row !== "object") return row;
    const ev0 =
      typeof row.event === "string" ? row.event : String(row.event || "");
    const ev1 = stripFactIntakePreamble(
      sanitizeFactProse(ev0, jurisdiction),
      jurisdiction
    );
    let event = cleanText(ev1);
    if (!event && ev1.trim()) event = ev1.trim();
    if (!event) event = ev0.trim();
    let dateOrTime = cleanText(row.dateOrTime);
    if (isUnspecifiedDateOrTime(dateOrTime)) dateOrTime = "";
    return {
      ...row,
      dateOrTime,
      event,
    };
  });

  verificationItemsOut = uniqueStrings(
    verificationItemsOut
      .map((v) => compactVerificationItem(String(v), jurisdiction))
      .map((s) => cleanText(s))
      .filter(Boolean)
  );
  if (!verificationItemsOut.length) {
    verificationItemsOut =
      jurisdiction === "US"
        ? [
            "Key dates and amounts",
            "Written terms referenced",
            "Party identities and roles",
          ]
        : ["重要日付・順序", "契約・書面の有無", "当事者・関係性"];
  }

  // Neutral internal schema (stable for UI)
  const facts = factsChronology
    .map((f) => ({
      dateOrTime: cleanText(f?.dateOrTime) || "",
      event: typeof f?.event === "string" ? f.event.trim() : "",
    }))
    .filter((f) => f.dateOrTime || f.event);

  const claims = normalizeStringArray(clientClaims);

  const additionalInfoNeeded =
    jurisdiction === "US"
      ? verificationItemsOut
      : normalizeStringArray(verificationItemsOut);

  const issues = (potentialIssues || [])
    .map((it) => {
      if (!it || typeof it !== "object") return null;
      return {
        issue: cleanText(it.issue) || "",
        relevantLaw: normalizeStringArray(it.relatedStatutes),
        relevantCaseLaw: normalizeStringArray(it.supremeCourtPrecedents),
      };
    })
    .filter(Boolean);

  const relevantLaw = uniqueStrings(
    issues.flatMap((x) => x.relevantLaw || [])
  );
  const relevantCaseLaw = uniqueStrings(
    issues.flatMap((x) => x.relevantCaseLaw || [])
  );

  let governingLawChoice = null;
  let keyLegalIssuesStateComparison = null;
  if (jurisdiction === "US") {
    governingLawChoice = normalizeGoverningLawChoiceObject(
      base.governingLawChoice
    );
    keyLegalIssuesStateComparison = normalizeKeyLegalIssuesStateComparison(
      base.keyLegalIssuesStateComparison
    );
  }

  const tags = finalizeIssueTags(
    base.tags,
    mainIssues,
    potentialIssues,
    jurisdiction,
    sourceText
  );

  return {
    jurisdiction,
    state,
    practiceArea:
      base.practiceArea == null
        ? null
        : typeof base.practiceArea === "string" && base.practiceArea.trim()
        ? base.practiceArea.trim()
        : null,
    consultationTitle:
      consultationTitle ||
      fallback.consultationTitle ||
      (jurisdiction === "US"
        ? buildUsConsultationTitleFallback(mainIssues, potentialIssues)
        : "要確認"),
    tags,
    mainIssues,
    initialChecks: initialChecksOut,
    factsChronology,
    verificationItems: verificationItemsOut,
    potentialIssues,
    clientClaims,
    possibleEvidence,
    // neutral schema for UI (preferred)
    facts,
    claims,
    issues,
    additionalInfoNeeded,
    relevantLaw,
    relevantCaseLaw,
    supremeCourtCase: supremeCourtCase ?? fallback.supremeCourtCase ?? null,
    governingLawChoice,
    keyLegalIssuesStateComparison,
    meta: {
      sourceTextLength: sourceText ? sourceText.length : 0,
      normalized: true,
      fallbackUsed: false,
    },
  };
}

function extractJson(text) {
  if (!text || typeof text !== "string") return null;

  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch (_) {}

  const codeBlockMatch = trimmed.match(/```json\s*([\s\S]*?)```/i);
  if (codeBlockMatch && codeBlockMatch[1]) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch (_) {}
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch (_) {}
  }

  return null;
}

const ALLOWED_JURISDICTIONS = ["JP", "US"];
const ALLOWED_US_STATES = ["CA", "NY", "TX", "FL", "DE", "GENERAL"];

function normalizeUsStateInput(state) {
  if (state == null) return "GENERAL";
  const s = String(state).trim();
  if (!s) return "GENERAL";
  const up = s.toUpperCase();
  if (up === "GENERAL" || up === "US-GENERAL" || up === "UNITED STATES (GENERAL)")
    return "GENERAL";
  if (up === "CA" || up === "CALIFORNIA") return "CA";
  if (up === "NY" || up === "NEW YORK") return "NY";
  if (up === "TX" || up === "TEXAS") return "TX";
  if (up === "FL" || up === "FLORIDA") return "FL";
  if (up === "DE" || up === "DELAWARE") return "DE";
  return up;
}

const US_STATE_CONFIG = {
  GENERAL: {
    displayName: "United States (General)",
    jurisdictionPrompt:
      "No specific state is selected. Consider federal law and generally applicable principles. State-law nuances may be relevant, but they are not specified.",
    priorityRules: [
      "Keep issue spotting neutral across common civil/criminal domains.",
      "Include federal-law and generally applicable framing where relevant.",
    ],
    issueSpottingGuidance: [
      "Identify the legal relationship between the parties (contract / employment / family / tort / property / criminal).",
      "Focus on timelines, key communications, and any written agreements.",
      "Flag limitations periods, notice requirements, and jurisdiction/venue facts to confirm.",
    ],
    additionalInfoFocus: [
      "Parties' identities and contact info; where events happened; key dates.",
      "Any contracts/policies; communications; prior disputes or claims.",
      "Damages/loss details (amounts, medical treatment, wage loss, documents).",
    ],
    relevantLawNotes: [
      "For each potentialIssues entry, include 1–3 relatedStatutes strings (Citation — short legal function) keyed to the intake themes (e.g., wage/hour, non-compete, contract breach). Use generally recognized anchors when the theme is clear even if the client did not cite a code section.",
    ],
  },
  CA: {
    displayName: "California",
    jurisdictionPrompt:
      "State focus: California. Prioritize California law when relevant, and consider federal law where applicable.",
    priorityRules: [
      "When listing potentialIssues, incorporate California-specific framing (e.g., 'California wage/hour', 'California arbitration' when supported by the intake topic).",
      "For each issue, supply 1–3 relatedStatutes tied to the narrative theme (California codes when relevant, plus federal anchors such as FLSA or Title VII if the facts support it).",
    ],
    issueSpottingGuidance: [
      "Check arbitration clauses, wage/hour classification issues, and consumer protection angles when supported by the intake.",
      "Confirm any pre-suit notice, administrative exhaustion, or agency filings that may apply.",
    ],
    additionalInfoFocus: [
      "Employment: pay records, schedules, classification, policies, and arbitration agreements.",
      "Consumer/contract: marketing representations, written terms, and transaction details.",
    ],
    relevantLawNotes: [
      "List 1–3 relatedStatutes per issue for themes supported by the intake (e.g., Cal. Labor Code, B&P § 16600) using standard citations and a short em-dash descriptor.",
    ],
  },
  NY: {
    displayName: "New York",
    jurisdictionPrompt:
      "State focus: New York. Prioritize New York law when relevant, and consider federal law where applicable.",
    priorityRules: [
      "When listing potentialIssues, incorporate New York-specific framing (e.g., choice-of-law/forum and NY-contract/employment topics when supported by the intake).",
      "For each issue, supply 1–3 relatedStatutes tied to the narrative theme (California codes when relevant, plus federal anchors such as FLSA or Title VII if the facts support it).",
    ],
    issueSpottingGuidance: [
      "Clarify choice-of-law/forum clauses and New York-specific statutory claims if supported by the intake.",
      "Confirm corporate entities, authority, and key contract formation/interpretation facts.",
    ],
    additionalInfoFocus: [
      "Contract/commercial: signed copies, amendments, performance history, and breach timeline.",
      "Employment: offer letters, policies, wage statements, and termination details.",
    ],
    relevantLawNotes: [
      "List 1–3 relatedStatutes per issue when the intake supports a theme (NY statutory or common-law anchors with short descriptors).",
    ],
  },
  TX: {
    displayName: "Texas",
    jurisdictionPrompt:
      "State focus: Texas. Prioritize Texas law when relevant, and consider federal law where applicable.",
    priorityRules: [
      "When listing potentialIssues, incorporate Texas-specific framing (e.g., pre-suit notice/caps/limitations topics when supported by the intake).",
      "For each issue, supply 1–3 relatedStatutes tied to the narrative theme (California codes when relevant, plus federal anchors such as FLSA or Title VII if the facts support it).",
    ],
    issueSpottingGuidance: [
      "Clarify pre-suit notice and potential caps/limitations issues where supported by the intake.",
      "Confirm the location of events and parties for jurisdiction/venue analysis.",
    ],
    additionalInfoFocus: [
      "Injury/accident: incident reports, witnesses, medical timeline, and insurance info.",
      "Contract: written terms, performance, and damages calculation basis.",
    ],
    relevantLawNotes: [
      "List 1–3 relatedStatutes per issue when the intake supports a theme (e.g., Tex. Bus. & Com. Code, Tex. Labor Code) with em-dash descriptors.",
    ],
  },
  FL: {
    displayName: "Florida",
    jurisdictionPrompt:
      "State focus: Florida. Prioritize Florida law when relevant, and consider federal law where applicable.",
    priorityRules: [
      "When listing potentialIssues, incorporate Florida-specific framing (e.g., insurance/notice/property topics when supported by the intake).",
      "For each issue, supply 1–3 relatedStatutes tied to the narrative theme (California codes when relevant, plus federal anchors such as FLSA or Title VII if the facts support it).",
    ],
    issueSpottingGuidance: [
      "Check insurance-related facts and pre-suit notice requirements when supported by the intake.",
      "Clarify property/real-estate documentation and recorded instruments if applicable and supported by the intake.",
    ],
    additionalInfoFocus: [
      "Insurance: policy, claim communications, denial letters, and timelines.",
      "Real estate: deeds, leases, HOA documents, notices, and correspondence.",
    ],
    relevantLawNotes: [
      "List 1–3 relatedStatutes per issue when the intake supports a theme (Florida statutory anchors with short descriptors).",
    ],
  },
};

const PRACTICE_AREA_CONFIG = {
  general_civil: {
    label: "General Civil",
    guidance: [
      "Identify the cause of action candidates and required elements without providing legal advice.",
      "Focus on actionable facts, documents, and timeline inconsistencies to confirm.",
    ],
  },
  family: {
    label: "Family",
    guidance: [
      "Confirm relationship status, children, living arrangements, and key dates.",
      "Focus on custody/support/property facts and existing court orders (if any).",
    ],
  },
  employment: {
    label: "Employment",
    guidance: [
      "Confirm employment status, role, pay, classification, policies, and key communications.",
      "Capture timelines for hiring, incidents, complaints, discipline, and termination.",
    ],
  },
  contract: {
    label: "Contract",
    guidance: [
      "Identify the contract documents, parties, formation, key terms, performance, and breach timeline.",
      "Capture damages/loss calculation inputs and mitigation facts.",
    ],
  },
  personal_injury: {
    label: "Personal Injury",
    guidance: [
      "Capture incident details, parties, witnesses, photos/videos, and medical timeline.",
      "Focus on causation facts and damages documentation without conclusions.",
    ],
  },
  criminal: {
    label: "Criminal",
    guidance: [
      "Capture alleged conduct, dates/locations, police contact, charges/citations, and bail/custody status.",
      "List counsel-critical deadlines and documents to obtain (reports, bodycam, discovery).",
    ],
  },
  real_estate: {
    label: "Real Estate",
    guidance: [
      "Capture property address, ownership/lease status, key documents, notices, and timeline.",
      "Focus on payment history, defects, disclosures, and communications.",
    ],
  },
};

function validateJurisdictionState(jurisdiction, state) {
  const j =
    typeof jurisdiction === "string" && jurisdiction.trim()
      ? jurisdiction.trim()
      : "JP";
  if (!ALLOWED_JURISDICTIONS.includes(j)) {
    return { ok: false, error: "Invalid jurisdiction" };
  }
  if (j !== "US") {
    if (state == null || state === "") {
      return { ok: true, jurisdiction: j, state: null };
    }
    return { ok: false, error: "state is only allowed for US" };
  }
  const s = normalizeUsStateInput(state);
  if (!s) return { ok: true, jurisdiction: j, state: "GENERAL" };
  if (!ALLOWED_US_STATES.includes(s)) {
    return { ok: false, error: "Invalid US state" };
  }
  return { ok: true, jurisdiction: j, state: s };
}

function outputLanguageBlockUS(uiLang) {
  if (uiLang === "ja") {
    return `
[OUTPUT LANGUAGE — CRITICAL]
- All user-facing string values in the JSON (mainIssues, initialChecks, factsChronology.event, verificationItems, potentialIssues.issue and relatedStatutes descriptors, clientClaims, possibleEvidence, governingLawChoice fields, keyLegalIssuesStateComparison text) MUST be written in professional Japanese suitable for a law-firm intake memo.
- Exception: consultationTitle MUST still be natural professional English only, per [consultationTitle — US] rules below (5–8 words, objective, no emotional language).
- Exception: tags MUST be 3–5 short English labels (one word or a very short phrase each), using common U.S. legal/business terminology — never Japanese in tags.
- Keep JSON keys exactly as specified in the schema. Statute labels may keep standard English abbreviations where customary, with a brief Japanese gloss after an em dash when helpful.
`.trim();
  }
  return "";
}

function outputLanguageBlockJP(uiLang) {
  if (uiLang === "en") {
    return `
[OUTPUT LANGUAGE — CRITICAL]
- uiLang is English: every string value in the JSON (titles, facts, issues, statute lines, evidence, etc.) MUST be natural professional English for a law-firm memo. Keep JSON keys as in the schema. Japanese statute names may stay in Japanese romanization or official English where standard; explain briefly in English if needed.
- Exception: tags MUST remain 3–5 short Japanese labels (legal practice terminology), not English — same rules as [tags — JP] in the schema section.
`.trim();
  }
  return "";
}

function buildPrompt(consultationText, jurisdiction, state, practiceAreaRaw, uiLang) {
  const j = jurisdiction === "US" ? "US" : "JP";
  const s = j === "US" && state ? state : null;
  const resolvedUiLang = uiLang === "en" || uiLang === "ja" ? uiLang : j === "US" ? "en" : "ja";
  const usLangExtra = outputLanguageBlockUS(resolvedUiLang);
  if (j === "US") {
    const stateCfg = s && US_STATE_CONFIG[s] ? US_STATE_CONFIG[s] : US_STATE_CONFIG.GENERAL;
    const practiceArea = cleanText(practiceAreaRaw != null ? practiceAreaRaw : null) || "";
    const paCfg = practiceArea && PRACTICE_AREA_CONFIG[practiceArea] ? PRACTICE_AREA_CONFIG[practiceArea] : null;
    const paLine = paCfg ? `Practice area: ${paCfg.label}` : `Practice area: Not specified`;
    const paGuidance = paCfg ? paCfg.guidance.map((g) => `- ${g}`).join("\n") : "- Keep issue spotting general across common civil/criminal domains.";
    const statePriority = (stateCfg.priorityRules || []).map((r) => `- ${r}`).join("\n");
    const stateGuidance = (stateCfg.issueSpottingGuidance || []).map((g) => `- ${g}`).join("\n");
    const stateAdditional = (stateCfg.additionalInfoFocus || []).map((g) => `- ${g}`).join("\n");
    const stateLawNotes = (stateCfg.relevantLawNotes || []).map((n) => `- ${n}`).join("\n");
    return `
You are an AI assistant that ONLY organizes a lawyer's initial intake note. JSON only, no markdown, no extra keys.
No legal advice. Never use "Unknown" or "不明". No N/A/TBD fillers.

[FORBIDDEN PHRASES — DO NOT OUTPUT]
- Do not use these as titles, issues, facts, claims, or standalone sentences: "Not provided", "To be confirmed", "To confirm", "Based on the provided information" (especially as a vague opener), "Intake title to be confirmed", "Issue themes to be confirmed", "pending review of the narrative".
- Every bullet must restate or paraphrase concrete intake content (who, what, when, where, how communicated).

[EXTRACTION PRIORITY — READ THE INTAKE FIRST]
- Scan for concrete anchors: state names (California, Texas, Delaware, etc.), dates or relative timing ("last week", "March 2024"), employment terms (signed, remote, relocation), incorporation (Delaware entity), termination, discipline, complaints (HR, OSHA), warning letters, non-compete / restrictive covenant, unpaid wages / overtime / final pay / vacation / bonuses.
- When ANY such detail appears, you MUST reflect it in factsChronology, clientClaims, possibleEvidence, mainIssues, keyLegalIssuesStateComparison topics, and potentialIssues — do not substitute a generic summary.
- Paraphrase concrete facts with neutral memo tone (e.g. "The intake states the employee signed in California and later relocated to Texas."). Do NOT use vague boilerplate like "Based on the provided information, no memo-style sentences…" or "Based on the provided information…" as a standalone fact row when specific intake content exists.
- Generic fallback sentences are allowed ONLY if the intake truly contains zero extractable concrete facts (extremely rare); otherwise every section must cite at least one intake-specific element.

[consultationTitle — US]
- Generate consultationTitle in the same JSON response as all other fields (do not defer or copy-paste the intake opening).
- Write a compact case-name title in English using 5–8 words (not a full sentence).
- Natural English; objective and neutral; no emotional wording, no first-person narrative, no rhetorical questions.
- Do NOT copy, quote, or lightly edit the first sentence or first line of the intake. Paraphrase into a legal-issue headline.
- Focus on who/what relationship, triggering event, and legal concern (e.g. termination, restrictive covenant, wage payment, discrimination allegation, contract breach).
- Prefer dispute-name patterns: "Retaliation, Termination and Wage Dispute", "Termination and Unpaid Wage Dispute", "Employment Retaliation and Wage Issues".

[tags — US]
- Include a "tags" array with 2 to 5 items. Each tag: 1–2 words (or one tight phrase), content-based only.
- Tags MUST be concrete issue labels (e.g., "Termination", "Wages", "Retaliation", "Non-compete", "Evidence"), not broad legal domains.
- ORDER the array by specificity: primary issue first, then supporting issues/elements.
- FORBIDDEN (never output): generic or process tags such as "Legal intake", "Issue identification", "Fact review", "Intake review", "Follow-up", "Client intake", "Legal matter", "Case management", "Document review", or any tag that only describes lawyer workflow.
- ALSO FORBIDDEN as overly broad: "Employment law", "Civil law", "Criminal law", "Family law", "Corporate law", "General legal matter".
- GOOD examples: "Homicide", "Evidence", "Motive"; "Termination", "Wages", "Retaliation".

[factsChronology — US]
- Each event is ONE clear English sentence with subject and predicate; neutral, objective memo tone.
- Do NOT start event lines with "Based on the intake", "According to the intake", "The intake states/indicates/describes that", "From the intake", or similar — the section title already signals intake basis; repeating this on every row is forbidden.
- No throat-clearing or repeated disclaimers across rows.

[verificationItems — US]
- Each array entry is ONE short noun phrase only (hard cap: 10 words). Title-style phrasing is fine.
- NO full sentences; NO verbs such as "confirm", "requires", "needs", "is", "was", "clarify"; NO "whether"; NO explanations that something is "not specified in the intake" or "requires clarification".
- List ONLY the checklist item to verify (e.g. "Year of the incident", "Identity of the victim", "Written non-compete terms", "Final pay calculation method").
- One line = one item; no semicolon-run lists inside one string.

[BREVITY + SUBSTANCE]
- Be concise, but ground every section in the intake narrative (parties, role, location, contract type, dispute trigger). Avoid generic template phrases (e.g. "Potential issue spotting…", "TBD", "to be determined").
- governingLawChoice.reasoning: max 2 short sentences tied to stated contacts; uncertaintyNote: one short sentence or "".
- keyLegalIssuesStateComparison: 3–5 objects when intake supports; each topic names the concrete controversy. california / texas / delaware: ONE tight clause each (~15–35 words) on how that jurisdiction typically treats the issue; Delaware may emphasize doctrine (reasonableness, protectable interest, equity) not only statutes. impact: ONE sentence.
- mainIssues: 3–4 bullets; each bullet must echo a specific fact or risk from the intake (employer, remote work, termination, wage claim, contract breach, etc.). No abstract filler.
- factsChronology: each event = one clear English sentence drawn from the intake; dateOrTime use intake text when present, else "". Order events logically; when timing is unclear, still state the fact and put timing precision in verificationItems.
- clientClaims: reconstruct likely client objectives from the narrative (e.g. challenge non-compete, recover final wages/vacation/bonus, contest termination as retaliatory) using "The client indicates…" / "The client seeks…" only when supported by intake tone; do not invent unsupported demands.
- possibleEvidence: list items tied to the dispute (agreements, emails, payroll, time records, HR complaints, warning letters, recordings, photos) that plausibly match what the intake references.
- Gaps → verificationItems as short noun phrases (checklist labels), not facts.

[CITATIONS — potentialIssues]
- Include 3–5 potentialIssues objects; each object MUST have a concrete "issue" headline tied to the intake AND a non-empty relatedStatutes array (minimum 1 string, target 2–3).
- For EACH issue, relatedStatutes MUST use "Citation — short legal function" (real federal/state citations). Examples by theme: non-compete → Cal. Bus. & Prof. Code § 16600; Tex. Bus. & Com. Code § 15.50 | wage/final pay → Cal. Labor Code §§ 201–203; 29 U.S.C. §§ 206–207; Tex. Labor Code § 61.014 (when facts match).
- Supreme Court: only if confident; else [].
- Delaware: you may include doctrine lines like "Delaware law — reasonableness and protectable-interest analysis for covenants" when the issue is DE/contract equity–driven.
- Never leave relatedStatutes as [] unless the intake is truly empty; if thin, still supply the best-fitting generally recognized anchors for the stated fact pattern.

[CONTEXT]
Jurisdiction: United States | State: ${stateCfg.displayName}
${stateCfg.jurisdictionPrompt}
${paLine}
State rules: ${statePriority}
${paGuidance}
${stateGuidance ? "State focus:\n" + stateGuidance : ""}
Additional info to flag: ${stateAdditional}
Law notes: ${stateLawNotes}

[SCHEMA — OBJECTS]
- governingLawChoice: one object { primary, secondary, otherPossible[], reasoning, uncertaintyNote }.
- keyLegalIssuesStateComparison: [ { topic, california, texas, delaware, impact } ].

{
  "practiceArea": null,
  "consultationTitle": "string",
  "tags": ["Homicide", "Corpse mutilation", "Evidence"],
  "governingLawChoice": {
    "primary": "California",
    "secondary": "Texas",
    "otherPossible": ["Delaware"],
    "reasoning": "CA contacts from signing and employer HQ; TX from residence. DE if entity angle.",
    "uncertaintyNote": "Confirm choice-of-law and forum clauses in agreements."
  },
  "keyLegalIssuesStateComparison": [
    {
      "topic": "Non-compete",
      "california": "Typically unenforceable under B&P § 16600 except narrow exceptions.",
      "texas": "May enforce if reasonable scope/duration and tied to valid agreement.",
      "delaware": "Contract/equity-dependent; common in M&A or DE entity contexts.",
      "impact": "Enforceability risk flips materially by governing law."
    }
  ],
  "mainIssues": ["bullet", "bullet"],
  "initialChecks": ["bullet"],
  "factsChronology": [{ "dateOrTime": "", "event": "English sentence.", "source": "Intake note" }],
  "verificationItems": ["Year of the incident", "Identity of the counterparty", "Written agreement terms"],
  "potentialIssues": [
    {
      "issue": "Restrictive covenant enforceability",
      "relatedStatutes": [
        "Cal. Bus. & Prof. Code § 16600 — general voidness of employee non-competes",
        "Tex. Bus. & Com. Code § 15.50 — reasonableness requirements for covenants",
        "Delaware law — equity-driven enforcement; reasonableness and protectable-interest tests"
      ],
      "supremeCourtPrecedents": []
    }
  ],
  "clientClaims": ["bullet"],
  "possibleEvidence": ["bullet"]
}

${usLangExtra ? `${usLangExtra}\n\n` : ""}[INTAKE NOTE]
${consultationText}
`.trim();
  }

  // JP (default)
  const jpLangExtra = outputLanguageBlockJP(resolvedUiLang);
  return `
あなたは弁護士向けの「初回相談メモ整理専用AI」です。
あなたの役割は、相談文に書かれている情報を客観的・構造的に整理することだけです。
法律判断、結論、助言、勝敗見通し、感想、推測的な評価は一切してはいけません。

【最重要ルール】
- 必ずJSONオブジェクトのみを返す
- JSON以外の文字を一切出力しない
- 説明文、前置き、注釈、markdown、コードブロックを付けない
- 9項目を必ずすべて返す
- 項目順も固定する
- 本文（特に factsChronology の event、governingLawChoice、keyLegalIssuesStateComparison、clientClaims、verificationItems、possibleEvidence）では、「Unknown」「不明」「日時不明」「N/A」「TBD」などを単独の欠損表現として使わない
- 主観的・評価的表現は避ける
- 相談文に書かれていない具体的事実（日付・金額・特定の当事者名など）は捏造しない
- factsChronology の各 event では「相談文に基づく限り、」「相談文によれば、」などの前置きを付けない（全行で繰り返さない）。事実は主語・述語で簡潔に書く。相談文ベースであることはセクション見出し側で示す想定である。
- 特定できない重要事項は factsChronology に断片やプレースホルダを置かず、verificationItems に「確認すべき項目名」だけを体言止め（名詞・短い名詞句）で列挙する。相談文に記載がないことの説明・理由・「確認が必要」などの文末表現は書かない（例：NG「〇〇の正確な時期は相談文に記載がなく…」→ OK「〇〇の正確な時期」）
- 初動確認事項と確認対象事項は重複させない
- 想定される論点は、論点名・relatedStatutes・supremeCourtPrecedents を付ける
- 条文・法律名は正式名称で出力する
- relatedStatutes は「法令名＋条番号 — 一言説明」の形式で統一する（例: 民法709条 — 不法行為による損害賠償責任）
- relatedStatutes の一言説明は 10〜20 文字程度で簡潔にし、条文の趣旨のみを書く（法的評価・結論は禁止）
- relatedStatutes は各条文ごとに shortDescription を付ける意図で出力する（重複・冗長な説明を避ける）
- 手続法系の条文は、可能なら効果を短く示す（例: 民事訴訟法247条 — 自由心証主義（証拠評価の自由））
- 条文見出しの単純反復は避け、必要な場合のみ括弧で補足する（例: 民法96条 — 詐欺・強迫による意思表示の取消し）
- 相談タイトルは短く客観的に要約し、ユーザーが後で編集しやすい表現にする

【判例に関する厳守ルール】
- 判例は日本の最高裁判例のみ出力する。下級審判例は出力しない。
- 存在しない判例を推測して作成してはいけない。
- 実在する最高裁判例が特定できる場合のみ supremeCourtPrecedents に入れる。
- 特定できない場合は supremeCourtPrecedents を空配列 [] にする。
- 特定できない場合でも、その旨の文章は出力せず、supremeCourtPrecedents は空配列 [] のままとすること。
- 最高裁判例を出す場合は、事件名または年月日を含める。
- 推測は禁止。特定できない場合は supremeCourtPrecedents を空配列 [] にする。
【出力スキーマ】
{
  "consultationTitle": "短い客観的タイトル",
  "tags": ["刑事", "殺人", "刑事責任", "動機", "証拠"],
  "mainIssues": ["主要論点1", "主要論点2"],
  "initialChecks": ["初動で優先確認すべき事項1", "事項2"],
  "factsChronology": [
    {
      "dateOrTime": "2024年3月",
      "event": "当事者間で参照されている契約について書面の変更が行われた。",
      "source": "相談文"
    },
    {
      "dateOrTime": "",
      "event": "相談者はテキサス州に居住しながらリモートで勤務を継続している。",
      "source": "相談文"
    }
  ],
  "verificationItems": ["転居の正確な時期", "競業避止に関する書面の有無"],
  "potentialIssues": [
    {
      "issue": "論点名",
      "relatedStatutes": ["民法709条 — 不法行為による損害賠償責任", "民法415条 — 債務不履行による損害賠償"],
      "supremeCourtPrecedents": ["最判昭和50年7月8日（事件名）"]
    }
  ],
  "clientClaims": ["依頼者の主張1", "依頼者の要望2"],
  "possibleEvidence": ["証拠・資料候補1", "証拠・資料候補2"]
}

【各項目の定義】
1. consultationTitle
- 相談内容を客観的に表す短いタイトル
- 感情表現や評価語を入れない

2. tags
- 分野・罪名・具体論点のみを表す短いタグを3〜5個、日本語で出力する（各1〜2語程度の名詞・名詞句）。配列の順は「分野 → 罪名・主たる論点 → 補助論点（構成要件・証拠・段階など）」とする
- 禁止: 「弁護活動」「法律相談」「相談」「論点整理」「確認事項」など手続・抽象のみのラベル。処理内容や業務工程を表す語は付けない
- 例: 「刑事」「殺人」「刑事責任」「動機」「証拠」／「労働」「解雇」「未払賃金」

3. mainIssues
- この相談で中心になる法的争点・論点候補
- 箇条書き配列

4. initialChecks
- 初回対応・受任判断前後で優先的に確認すべき事項
- 緊急性、時効、保全、相手方対応状況、資料確保などを必要に応じて含める
- verificationItems と同じ文言を入れない

5. factsChronology
- 相談文に書かれた事実・出来事を時系列で整理する
- 各 event は法律事務所向けメモのように完結した文で書く（主語・述語で簡潔に）。「相談文に基づく限り、」等の前置きは各行に付けない
- 日付が相談文にない場合、dateOrTime は空文字 "" とする。「不明」「Unknown」は使わない
- 日時や重要事実が特定できないときは、event にプレースホルダを置かず verificationItems に回す

6. verificationItems
- 追加で確認すべき項目を、体言止め（名詞または短い名詞句）のみで列挙する。1行＝1項目。理由説明・「相談文に記載がなく」「判別できず」「確認が必要」などの文末は禁止
- initialChecks より後順位の確認事項
- initialChecks と重複禁止

7. potentialIssues
- 想定される法的論点を整理
- 各論点ごとに 論点(issue)、関連条文(relatedStatutes)、参考最高裁判例(supremeCourtPrecedents) を付ける
- 関連条文は法律の正式名称で出力
- 関連条文は必ず「法令名・条番号 — 一言説明（10〜20文字程度）」で出力
- 参考最高裁判例は最高裁判例のみ。

8. clientClaims
- 依頼者が主張している事実、相手方への不満、求めている対応、争いたい点

9. possibleEvidence
- 相談文から客観的に想定できる証拠・資料候補
- 例：契約書、LINE、メール、録音、請求書、診断書、就業規則など

【禁止事項】
- 法的助言
- 結論提示
- 勝敗予測
- 過度な推測
- 存在しない判例の推測・創作
- スキーマ外のキー追加

${jpLangExtra ? `${jpLangExtra}\n\n` : ""}【相談文】
${consultationText}
`.trim();
}

async function callAnthropic(prompt, apiKey, options = {}) {
  const anthropic = new Anthropic({ apiKey });
  const maxTokens =
    Number.isFinite(options.maxTokens) && options.maxTokens > 0
      ? Math.min(options.maxTokens, 8192)
      : 2000;

  const t0 = Date.now();
  let response;
  try {
    response = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });
  } catch (err) {
    const elapsed = Date.now() - t0;
    console.error("[Lexoria] Anthropic API error", {
      elapsedMs: elapsed,
      maxTokens,
      message: err?.message || String(err),
    });
    throw err;
  }
  const anthropicMs = Date.now() - t0;

  const textBlock = response.content?.find((b) => b.type === "text");
  const text = textBlock?.text;
  if (!text || typeof text !== "string") {
    console.error("[Lexoria] Anthropic empty content", { anthropicMs });
    throw new Error("Anthropic response content was empty.");
  }

  const usage = response.usage || {};
  console.log("[Lexoria] Anthropic round-trip", {
    anthropicMs,
    maxTokens,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  });

  const tParse = Date.now();
  const parsed = extractJson(text);
  const parseMs = Date.now() - tParse;

  return {
    rawText: text,
    parsed,
    model: ANTHROPIC_MODEL,
    _timings: { anthropicMs, jsonParseMs: parseMs },
  };
}

function appendSectionMarkdown(markdownLines, section) {
  markdownLines.push(`## ${section.label}`);

  if (section.type === "text") {
    markdownLines.push(section.value || "要確認");
    markdownLines.push("");
    return;
  }

  if (section.type === "tags") {
    const arr = Array.isArray(section.value) ? section.value : [];
    if (!arr.length) {
      markdownLines.push("(none)");
    } else {
      for (const t of arr) {
        markdownLines.push(`- ${t}`);
      }
    }
    markdownLines.push("");
    return;
  }

  if (section.type === "list") {
    for (const item of section.value) {
      markdownLines.push(`- ${item}`);
    }
    markdownLines.push("");
    return;
  }

    if (section.type === "timeline") {
      for (const item of section.value) {
        const d = (item.dateOrTime && String(item.dateOrTime).trim()) || "";
        if (d) {
          markdownLines.push(`- ${d}：${item.event}`);
        } else {
          markdownLines.push(`- ${item.event}`);
        }
      }
      markdownLines.push("");
      return;
    }

  if (section.type === "governingLawBox") {
    const g = section.value && typeof section.value === "object" ? section.value : {};
    markdownLines.push(
      `**Most likely governing law:** ${g.primary || ""}`.trim()
    );
    if (g.secondary && String(g.secondary).trim()) {
      markdownLines.push(`**Secondary possibility:** ${g.secondary}`);
    }
    if (Array.isArray(g.otherPossible) && g.otherPossible.length) {
      markdownLines.push(
        `**Other possible law(s):** ${g.otherPossible.join("; ")}`
      );
    }
    markdownLines.push(`**Reasoning:** ${g.reasoning || ""}`);
    if (g.uncertaintyNote && String(g.uncertaintyNote).trim()) {
      markdownLines.push(`**Uncertainty:** ${g.uncertaintyNote}`);
    }
    markdownLines.push("");
    return;
  }

  if (section.type === "stateComparisonList") {
    if (!section.value || section.value.length === 0) {
      markdownLines.push(
        "(No state-comparison themes were produced from the intake; counsel may confirm material facts and legal context.)"
      );
      markdownLines.push("");
      return;
    }
    for (const item of section.value) {
      markdownLines.push(`### ${item.topic || "Issue theme"}`);
      markdownLines.push(`- **California:** ${item.california || ""}`);
      markdownLines.push(`- **Texas:** ${item.texas || ""}`);
      markdownLines.push(`- **Delaware:** ${item.delaware || ""}`);
      markdownLines.push(`- **Practical impact:** ${item.impact || ""}`);
      markdownLines.push("");
    }
    return;
  }

  if (section.type === "comparisonList") {
    if (!section.value || section.value.length === 0) {
      markdownLines.push(
        "(No state-comparison themes were produced from the intake; counsel may confirm material facts and legal context.)"
      );
      markdownLines.push("");
      return;
    }
    for (const item of section.value) {
      markdownLines.push(`### ${item.topic || "Issue theme"}`);
      markdownLines.push(item.comparison || item.impact || "");
      markdownLines.push("");
    }
    return;
  }

  if (section.type === "issueList") {
    const L =
      section.locale === "en"
        ? {
            issue: "Issue:",
            statutes: "Related statutes:",
            precedents: "U.S. Supreme Court (if any):",
            joiner: ", ",
          }
        : {
            issue: "論点:",
            statutes: "関連条文:",
            precedents: "参考最高裁判例:",
            joiner: "、",
          };
    for (const item of section.value) {
      markdownLines.push(`- ${L.issue} ${item.issue}`);
      markdownLines.push(
        `  - ${L.statutes} ${(item.relatedStatutes || []).join(L.joiner)}`
      );
      const precedents = (item.supremeCourtPrecedents || []).filter(
        (v) => typeof v === "string" && v.trim()
      );
      if (precedents.length > 0) {
        markdownLines.push(`  - ${L.precedents} ${precedents.join(L.joiner)}`);
      }
    }
    markdownLines.push("");
  }
}

function buildDisplayPayload(structured) {
  if (structured && structured.jurisdiction === "US") {
    const govObj = normalizeGoverningLawChoiceObject(
      structured.governingLawChoice
    );
    const cmp = normalizeKeyLegalIssuesStateComparison(
      structured.keyLegalIssuesStateComparison
    );
    const evidence = normalizeStringArray(structured.possibleEvidence);
    const verification = normalizeStringArray(structured.verificationItems);
    const evidenceBlock = [
      ...evidence.map((e) => `Evidence: ${e}`),
      ...verification.map((v) => `Additional info: ${v}`),
    ];

    const sections = [
      {
        key: "consultationTitle",
        label: "Title",
        type: "text",
        value:
          structured.consultationTitle ||
          US_CONSULTATION_TITLE_PLACEHOLDER,
        editable: true,
      },
      {
        key: "tags",
        label: "Tags",
        type: "tags",
        value: Array.isArray(structured.tags) ? structured.tags : [],
      },
      {
        key: "governingLawChoice",
        label: "1. Governing Law / Choice of Law",
        type: "governingLawBox",
        value: govObj,
      },
      {
        key: "keyLegalIssuesStateComparison",
        label: "2. Key Legal Issues (State-by-State Comparison)",
        type: "stateComparisonList",
        value: cmp,
      },
      {
        key: "mainIssues",
        label: "Overview themes",
        type: "list",
        value: ensureNonEmptyArray(
          structured.mainIssues,
          "Isolate concrete themes (parties, timeline, contract, injury, or termination) from the intake narrative."
        ),
      },
      {
        key: "clientClaims",
        label: "3. Client’s Claims",
        type: "list",
        value: ensureNonEmptyArray(
          structured.clientClaims,
          "Extract the client’s stated grievances and desired outcomes directly from the intake wording."
        ),
      },
      {
        key: "possibleEvidence",
        label: "4. Evidence & Additional Information",
        type: "list",
        value: evidenceBlock.length
          ? evidenceBlock
          : [
              "Name likely documents implied by the intake (agreements, pay records, emails, policies, warnings).",
            ],
      },
      {
        key: "initialChecks",
        label: "Initial checks",
        type: "list",
        value: ensureNonEmptyArray(
          structured.initialChecks,
          "Confirm parties, key dates, written terms, and any agency filings referenced in the intake."
        ),
      },
      {
        key: "factsChronology",
        label: "Facts (based on intake narrative)",
        type: "timeline",
        value: normalizeFactsChronology(structured.factsChronology, "US"),
      },
      {
        key: "potentialIssues",
        label: "Relevant law (issues & statutes)",
        type: "issueList",
        locale: "en",
        value: enrichUsPotentialIssues(
          normalizePotentialIssues(structured.potentialIssues, "US"),
          structured.state || null,
          ""
        ),
      },
    ];

    const markdownLines = [];
    for (const section of sections) {
      appendSectionMarkdown(markdownLines, section);
    }

    return {
      editableTitle:
        structured.consultationTitle || US_CONSULTATION_TITLE_PLACEHOLDER,
      sections,
      markdown: markdownLines.join("\n").trim(),
    };
  }

  const sections = [
    {
      key: "consultationTitle",
      label: "1. 相談タイトル",
      type: "text",
      value: structured.consultationTitle || "要確認",
      editable: true,
    },
    {
      key: "tags",
      label: "2. タグ（論点ラベル）",
      type: "tags",
      value: Array.isArray(structured.tags) ? structured.tags : [],
    },
    {
      key: "mainIssues",
      label: "3. 主要論点",
      type: "list",
      value: ensureNonEmptyArray(structured.mainIssues, "該当情報なし"),
    },
    {
      key: "initialChecks",
      label: "4. 初動確認事項",
      type: "list",
      value: ensureNonEmptyArray(structured.initialChecks, "要確認"),
    },
    {
      key: "factsChronology",
      label: "5. 事実関係（相談内容に基づく整理）",
      type: "timeline",
      value: normalizeFactsChronology(structured.factsChronology),
    },
    {
      key: "verificationItems",
      label: "6. 確認対象事項",
      type: "list",
      value: ensureNonEmptyArray(structured.verificationItems, "要確認"),
    },
    {
      key: "potentialIssues",
      label: "7. 想定される論点（関連する条文・判例）",
      type: "issueList",
      value: normalizePotentialIssues(structured.potentialIssues),
    },
    {
      key: "clientClaims",
      label: "8. 依頼者の主張",
      type: "list",
      value: ensureNonEmptyArray(structured.clientClaims, "該当情報なし"),
    },
    {
      key: "possibleEvidence",
      label: "9. 証拠・資料になりうるもの",
      type: "list",
      value: ensureNonEmptyArray(structured.possibleEvidence, "該当情報なし"),
    },
  ];

  const markdownLines = [];
  for (const section of sections) {
    appendSectionMarkdown(markdownLines, section);
  }

  return {
    editableTitle: structured.consultationTitle || "要確認",
    sections,
    markdown: markdownLines.join("\n").trim(),
  };
}

function inferRegionScopeFromInputs(regionScopeRaw, uiLangRaw, jurisdictionRaw) {
  const rs = String(regionScopeRaw || "")
    .trim()
    .toLowerCase();
  if (rs === "jp" || rs === "us") return rs;
  const ul = String(uiLangRaw || "")
    .trim()
    .toLowerCase();
  if (ul === "ja") return "jp";
  if (ul === "en") return "us";
  return String(jurisdictionRaw || "").toUpperCase() === "US" ? "us" : "jp";
}

function buildSummaryFromStructured(structured, isEn) {
  const mains = Array.isArray(structured?.mainIssues)
    ? structured.mainIssues
        .map((v) => (typeof v === "string" ? v.trim() : String(v || "").trim()))
        .filter(Boolean)
        .slice(0, 2)
    : [];
  if (mains.length) return mains.join(" / ").slice(0, 220);
  const pis = Array.isArray(structured?.potentialIssues)
    ? structured.potentialIssues
        .map((v) =>
          v && typeof v === "object"
            ? String(v.issue || "").trim()
            : String(v || "").trim()
        )
        .filter(Boolean)
        .slice(0, 2)
    : [];
  if (pis.length) return pis.join(" / ").slice(0, 220);
  return isEn ? "Summary unavailable" : "要約なし";
}

function withMinimumResponseShape(structured, regionScope) {
  const s = structured && typeof structured === "object" ? structured : {};
  const isEn = (s.jurisdiction || "JP") === "US";
  const title =
    (typeof s.consultationTitle === "string" && s.consultationTitle.trim()) ||
    (isEn ? US_CONSULTATION_TITLE_PLACEHOLDER : "要確認");
  const tags = Array.isArray(s.tags) ? s.tags.filter(Boolean).slice(0, 5) : [];
  const summary = buildSummaryFromStructured(s, isEn);
  return {
    ...s,
    title,
    tags,
    summary,
    regionScope: regionScope || inferRegionScopeFromInputs(null, isEn ? "en" : "ja", s.jurisdiction),
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: {
        code: "METHOD_NOT_ALLOWED",
        message: "POST only",
      },
      result: normalizeStructuredOutput(null, ""),
      display: buildDisplayPayload(buildEmptyResult("")),
    });
  }

  const requestT0 = Date.now();
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    const consultationText =
      req.body?.consultationText ||
      req.body?.consultation ||
      req.body?.text ||
      req.body?.content ||
      "";

    const jurisdictionRaw = req.body?.jurisdiction;
    const stateRaw = req.body?.state;
    const practiceAreaRaw = req.body?.practiceArea;
    const regionScope = inferRegionScopeFromInputs(
      req.body?.regionScope,
      req.body?.uiLang,
      jurisdictionRaw
    );
    const jv = validateJurisdictionState(jurisdictionRaw, stateRaw);
    if (!jv.ok) {
      const normalizedInvalid = withMinimumResponseShape(
        normalizeStructuredOutput(
          { jurisdiction: "JP", state: null },
          typeof consultationText === "string" ? consultationText.trim() : ""
        ),
        regionScope
      );
      return res.status(400).json({
        ok: false,
        error: {
          code: "INVALID_JURISDICTION",
          message: jv.error || "Invalid jurisdiction/state",
        },
        title: normalizedInvalid.title,
        tags: normalizedInvalid.tags,
        summary: normalizedInvalid.summary,
        result: normalizedInvalid,
        display: buildDisplayPayload(normalizedInvalid),
      });
    }

    const safeText =
      typeof consultationText === "string" ? consultationText.trim() : "";

    if (!safeText) {
      const emptyResult = withMinimumResponseShape(
        normalizeStructuredOutput(null, ""),
        regionScope
      );
      return res.status(400).json({
        ok: false,
        error: {
          code: "EMPTY_INPUT",
          message: "相談文が空です。",
        },
        title: emptyResult.title,
        tags: emptyResult.tags,
        summary: emptyResult.summary,
        result: emptyResult,
        display: buildDisplayPayload(emptyResult),
      });
    }

    const emailNorm = normalizeEmail(req.body?.email || "");
    const password = String(req.body?.password || "");
    const uiLangWire = req.body?.uiLang === "en" ? "en" : "ja";
    const authDenyShape = () =>
      withMinimumResponseShape(normalizeStructuredOutput(null, safeText), regionScope);

    if (!emailNorm || !password) {
      const fb = authDenyShape();
      const msg =
        uiLangWire === "en"
          ? "Email and password are required to use AI organization."
          : "AI整理を利用するにはログイン情報（メールアドレスとパスワード）が必要です。";
      return res.status(401).json({
        ok: false,
        code: "AUTH_REQUIRED",
        message: msg,
        error: { code: "AUTH_REQUIRED", message: msg },
        title: fb.title,
        tags: fb.tags,
        summary: fb.summary,
        result: fb,
        display: buildDisplayPayload(fb),
      });
    }

    const stored = await getStoredUser(emailNorm);
    const auth = verifyPassword(stored, password);
    if (!auth.ok || !stored) {
      const fb = authDenyShape();
      const msg =
        uiLangWire === "en"
          ? "Authentication failed. Check your email and password."
          : "認証に失敗しました。メールアドレスとパスワードを確認してください。";
      return res.status(401).json({
        ok: false,
        code: "UNAUTHORIZED",
        message: msg,
        error: { code: "UNAUTHORIZED", message: msg },
        title: fb.title,
        tags: fb.tags,
        summary: fb.summary,
        result: fb,
        display: buildDisplayPayload(fb),
      });
    }

    const access = evaluateOrganizeAccess(stored, new Date(), uiLangWire);
    if (!access.ok) {
      const fb = authDenyShape();
      const msg = pickUserMessage(access, uiLangWire);
      const trialCountSnap = Math.max(
        0,
        Number(stored.trialCount ?? stored.trial_count ?? 0) || 0
      );
      return res.status(403).json({
        ok: false,
        code: access.code,
        message: msg,
        error: { code: access.code, message: msg },
        title: fb.title,
        tags: fb.tags,
        summary: fb.summary,
        result: fb,
        display: buildDisplayPayload(fb),
        trial: {
          trialCount: trialCountSnap,
          trialEndsAt: stored.trialEndsAt || stored.trial_ends_at || null,
        },
      });
    }

    if (!apiKey) {
      const fallback = withMinimumResponseShape(
        normalizeStructuredOutput(null, safeText),
        regionScope
      );
      return res.status(500).json({
        ok: false,
        error: {
          code: "MISSING_API_KEY",
          message: "ANTHROPIC_API_KEY が設定されていません。",
        },
        title: fallback.title,
        tags: fallback.tags,
        summary: fallback.summary,
        result: fallback,
        display: buildDisplayPayload(fallback),
      });
    }

    // Debug: verify state reaches prompt layer (do not log raw consultationText).
    const uiLangBody =
      req.body?.uiLang === "en" || req.body?.uiLang === "ja"
        ? req.body.uiLang
        : null;

    console.log("[Lexoria] organize jurisdiction/state", {
      jurisdiction: jv.jurisdiction,
      state: jv.state ?? null,
      practiceArea: practiceAreaRaw ?? null,
      uiLang: uiLangBody ?? "(default by jurisdiction)",
    });

    const tPrompt0 = Date.now();
    const prompt = buildPrompt(
      safeText,
      jv.jurisdiction,
      jv.state,
      practiceAreaRaw,
      uiLangBody
    );
    const promptBuildMs = Date.now() - tPrompt0;

    const ai = await callAnthropic(prompt, apiKey, {
      maxTokens: 2400,
    });
    const anthropicMs = ai._timings?.anthropicMs ?? null;
    const jsonParseMs = ai._timings?.jsonParseMs ?? null;

    const tNorm0 = Date.now();
    const normalizedBase = normalizeStructuredOutput(
      { ...(ai.parsed || {}), jurisdiction: jv.jurisdiction, state: jv.state, practiceArea: practiceAreaRaw ?? (ai.parsed || {}).practiceArea ?? null },
      safeText
    );
    const normalized = withMinimumResponseShape(normalizedBase, regionScope);
    const display = buildDisplayPayload(normalized);
    const normalizeAndDisplayMs = Date.now() - tNorm0;

    const totalMs = Date.now() - requestT0;
    const timings = {
      promptBuildMs,
      anthropicMs,
      jsonParseMs,
      normalizeAndDisplayMs,
      totalMs,
    };
    console.log("[Lexoria] organize timings (ms)", timings);

    let trialAfter = null;
    try {
      if (!isPaidSubscriptionActive(stored)) {
        const fresh = await getStoredUser(emailNorm);
        if (fresh) {
          const prev = Math.max(0, Number(fresh.trialCount ?? fresh.trial_count ?? 0) || 0);
          const nextCount = prev + 1;
          const merged = { ...fresh, trialCount: nextCount };
          await putStoredUser(emailNorm, merged);
          trialAfter = {
            trialCount: nextCount,
            trialEndsAt: merged.trialEndsAt ?? merged.trial_ends_at ?? null,
            trialStartedAt:
              merged.trialStartedAt ?? merged.trial_started_at ?? merged.trialStart ?? null,
          };
        }
      }
    } catch (eTri) {
      console.error("[Lexoria] organize trialCount persist failed", eTri?.message || eTri);
    }

    return res.status(200).json({
      ok: true,
      error: null,
      model: ai.model,
      promptVersion: "intake-organize-v12-compact-title-specific-tags",
      schemaVersion: "2026-03-26",
      timings,
      title: normalized.title,
      tags: normalized.tags,
      summary: normalized.summary,
      result: normalized,
      display,
      trial: trialAfter,
      raw: {
        parsed: ai.parsed || null,
      },
    });
  } catch (error) {
    const consultationText =
      req.body?.consultationText ||
      req.body?.consultation ||
      req.body?.text ||
      req.body?.content ||
      "";

    const safeText =
      typeof consultationText === "string" ? consultationText.trim() : "";

    const regionScope = inferRegionScopeFromInputs(
      req.body?.regionScope,
      req.body?.uiLang,
      req.body?.jurisdiction
    );
    const fallback = withMinimumResponseShape(
      normalizeStructuredOutput(null, safeText),
      regionScope
    );

    console.error("[Lexoria] organize failed", {
      elapsedMs: Date.now() - requestT0,
      message: error?.message || String(error),
    });

    let userMessage = "整理処理中にエラーが発生しました。";
    if (error && typeof error === "object") {
      const status = error.status ?? error.statusCode;
      const type = error.type ?? error.error?.type ?? "";
      const msg = (error.message || error.error?.message || "").toString();
      if (
        status === 404 ||
        type === "not_found_error" ||
        /not_found|404|model.*invalid/i.test(msg)
      ) {
        userMessage =
          "Claude のモデル名が無効です。現行モデルへ更新してください。";
      } else if (msg && typeof msg === "string" && msg.length < 200) {
        userMessage = msg;
      }
    } else if (error instanceof Error && error.message) {
      const msg = error.message;
      if (/not_found|404|model.*invalid/i.test(msg)) {
        userMessage =
          "Claude のモデル名が無効です。現行モデルへ更新してください。";
    } else {
        userMessage = msg;
      }
    }

    return res.status(500).json({
      ok: false,
      error: {
        code: "ORGANIZE_FAILED",
        message: userMessage,
      },
      title: fallback.title,
      tags: fallback.tags,
      summary: fallback.summary,
      result: fallback,
      display: buildDisplayPayload(fallback),
    });
  }
}