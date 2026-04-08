import crypto from "crypto";
import { createServerSupabase } from "./supabase/server.js";
import { canonicalizeEmail, getEmailLookupCandidates, SUPPORT_DB_EMAIL_TYPOS } from "./emailAliases.js";
import { UI_PLAN_TO_TIER } from "./stripe/priceIds.js";

/** 書き込み先テーブル（明示 env または既定 lexoria_users） */
export function getLexoriaUsersTableName() {
  const t = String(process.env.SUPABASE_LEXORIA_USERS_TABLE || "lexoria_users").trim();
  return t || "lexoria_users";
}

/**
 * 読み取りはこのテーブルのみ（public.users へのフォールバックは廃止して警告を減らす）。
 * 別テーブルを使う場合のみ SUPABASE_LEXORIA_USERS_TABLE を設定。
 */
export function getLexoriaUserReadTableOrder() {
  return [getLexoriaUsersTableName()];
}

function normEmail(email) {
  return canonicalizeEmail(email);
}

/** ILIKE で「完全一致」に近づける（% _ をエスケープ） */
function escapeIlikeExact(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

function sha256Hex(password) {
  return crypto.createHash("sha256").update(String(password)).digest("hex");
}

function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(s || "").trim()
  );
}

export function isSupabaseAuthConfigured() {
  return Boolean(createServerSupabase());
}

export function rowToStoredUser(row) {
  if (!row || typeof row !== "object") return null;
  const out = {
    id: row.id,
    email: normEmail(row.email),
    name: row.name != null ? row.name : row.email,
    passwordHash:
      row.password_hash != null
        ? String(row.password_hash)
        : row.passwordHash != null
          ? String(row.passwordHash)
          : null,
    password_sha256: row.legacy_password_sha256 || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    trialStart: row.trial_start != null ? row.trial_start : null,
    trialStartedAt: row.trial_started_at != null ? row.trial_started_at : null,
    trialEndsAt: row.trial_ends_at != null ? row.trial_ends_at : null,
    trialCount: row.trial_count != null ? Number(row.trial_count) : 0,
    trialStatus: row.trial_status != null ? row.trial_status : null,
    plan_tier: row.plan_tier,
    billing_cycle: row.billing_cycle,
    seat_limit: row.seat_limit,
    subscription_status: row.subscription_status,
    jurisdiction_default: row.jurisdiction_default,
    ui_lang_default: row.ui_lang_default,
    stripe_customer_id: row.stripe_customer_id,
    stripe_subscription_id: row.stripe_subscription_id,
    team_id: row.team_id,
    role: row.role,
    _authSource: "supabase",
  };
  return out;
}

function baseRowFromStored(u, nowIso) {
  const emailNorm = normEmail(u.email);
  let planTier = u.plan_tier ?? null;
  if (planTier == null && u.plan != null) {
    const p = String(u.plan).toLowerCase().trim();
    planTier = UI_PLAN_TO_TIER[p] ?? null;
  }
  let subStatus = u.subscription_status ?? null;
  if (subStatus == null && u.subscriptionStatus != null) {
    subStatus = String(u.subscriptionStatus);
  }
  let seatLimit = u.seat_limit != null ? Number(u.seat_limit) : null;
  if (seatLimit == null && u.seatLimit != null) {
    seatLimit = Number(u.seatLimit);
  }
  let billingCycle = u.billing_cycle ?? null;
  if (billingCycle == null && u.billingCycle != null) {
    billingCycle = u.billingCycle;
  }
  const stripeSub =
    u.stripe_subscription_id != null ? u.stripe_subscription_id : u.stripeSubscriptionId ?? null;
  const stripeCust = u.stripe_customer_id != null ? u.stripe_customer_id : u.stripeCustomerId ?? null;
  return {
    email: emailNorm,
    password_hash: u.passwordHash,
    name: (u.name && String(u.name).trim()) || emailNorm,
    plan_tier: planTier,
    billing_cycle: billingCycle,
    seat_limit: seatLimit,
    subscription_status: subStatus,
    jurisdiction_default: u.jurisdiction_default ?? null,
    ui_lang_default: u.ui_lang_default ?? null,
    stripe_customer_id: stripeCust,
    stripe_subscription_id: stripeSub,
    team_id: u.team_id ?? null,
    role: u.role ?? null,
    trial_start: u.trialStart != null ? u.trialStart : null,
    trial_started_at: u.trialStartedAt != null ? u.trialStartedAt : null,
    trial_ends_at: u.trialEndsAt != null ? u.trialEndsAt : null,
    trial_count: Number.isFinite(Number(u.trialCount)) ? Number(u.trialCount) : 0,
    trial_status: u.trialStatus != null ? u.trialStatus : null,
    legacy_password_sha256: u.password_sha256 ?? null,
    updated_at: nowIso,
  };
}

async function fetchLexoriaUserRowFromTable(sb, emailNorm, table) {
  const em = normEmail(emailNorm);
  if (!em) return null;

  const { data: byEq, error: errEq } = await sb
    .from(table)
    .select("*")
    .eq("email", em)
    .maybeSingle();
  if (errEq) {
    if (/does not exist|schema cache|Could not find the table/i.test(String(errEq.message))) {
      console.warn("[auth/supabase] table or relation not usable", {
        table,
        message: errEq.message,
        code: errEq.code,
      });
      return null;
    }
    console.error("[auth/error] supabase fetch user", {
      table,
      message: errEq.message,
      code: errEq.code,
    });
    throw errEq;
  }

  let data = byEq ?? null;

  if (!data) {
    const pat = escapeIlikeExact(em);
    const { data: rows, error: errIlike } = await sb
      .from(table)
      .select("*")
      .ilike("email", pat)
      .limit(1);
    if (errIlike) {
      if (/does not exist|schema cache/i.test(String(errIlike.message))) {
        console.warn("[auth/supabase] ilike skip (table missing?)", { table, message: errIlike.message });
        return null;
      }
      console.error("[auth/error] supabase fetch user (ilike)", {
        table,
        message: errIlike.message,
        code: errIlike.code,
      });
      throw errIlike;
    }
    data = rows?.[0] ?? null;
    if (data) {
      console.log("[auth/supabase] row matched via ilike (normalize email in DB if possible)", {
        table,
        emailNorm: em,
      });
    }
  }

  if (data && data.password_hash == null && data.passwordHash == null) {
    console.warn("[auth/supabase] row loaded but no password_hash column", {
      table,
      email: em,
      columns: Object.keys(data),
    });
  }
  return data || null;
}

/**
 * @returns {Promise<{ row: object|null, table: string, readTablesTried: string[] }>}
 */
export async function fetchLexoriaUserRowWithMeta(emailNorm) {
  const sb = createServerSupabase();
  const em = normEmail(emailNorm);
  const lookupCandidates = getEmailLookupCandidates(em);
  const readOrder = getLexoriaUserReadTableOrder();
  const tried = [];
  if (!sb || !em) {
    return { row: null, table: readOrder[0] || getLexoriaUsersTableName(), readTablesTried: tried };
  }

  for (const table of readOrder) {
    tried.push(table);
    let data;
    try {
      data = await fetchLexoriaUserRowFromTable(sb, em, table);
      if (!data && lookupCandidates.length > 1) {
        for (const candidate of lookupCandidates) {
          if (candidate === em) continue;
          const alt = await fetchLexoriaUserRowFromTable(sb, candidate, table);
          if (alt) {
            console.log("[auth/supabase] row found via email alias", {
              table,
              normalizedEmail: em,
              dbEmail: candidate,
            });
            data = alt;
            break;
          }
        }
      }
      if (!data && em === "support@lexoriaai.com") {
        for (const typo of SUPPORT_DB_EMAIL_TYPOS) {
          const alt = await fetchLexoriaUserRowFromTable(sb, typo, table);
          if (alt) {
            console.log("[auth/supabase] support row found via DB typo email; canonicalize on write recommended", {
              table,
              normalizedEmail: em,
              dbEmail: typo,
            });
            data = alt;
            break;
          }
        }
      }
    } catch (e) {
      console.error("[auth/error] supabase fetch aborted", { table, message: e?.message || e });
      throw e;
    }
    if (data) {
      console.log("[auth/supabase] row found", { table, normalizedEmail: em });
      return { row: data, table, readTablesTried: tried };
    }
  }

  console.log("[auth/supabase] no row in any read table", {
    emailNorm: em,
    readTablesTried: tried,
    writeTable: getLexoriaUsersTableName(),
  });
  return { row: null, table: readOrder[0] || getLexoriaUsersTableName(), readTablesTried: tried };
}

/**
 * @param {string} emailNorm
 * @returns {Promise<object|null>}
 */
export async function fetchLexoriaUserRow(emailNorm) {
  const { row } = await fetchLexoriaUserRowWithMeta(emailNorm);
  return row;
}

/**
 * Insert or update by email (preserves PK id on update).
 */
export async function upsertLexoriaUser(storedUser) {
  const sb = createServerSupabase();
  if (!sb) throw new Error("supabase_not_configured");
  const emailNorm = normEmail(storedUser.email);
  if (!emailNorm) throw new Error("email is required");
  if (!storedUser.passwordHash) throw new Error("passwordHash is required");

  const nowIso = new Date().toISOString();
  const { row: existing, table: existingTable } = await fetchLexoriaUserRowWithMeta(emailNorm);
  const writeTable = getLexoriaUsersTableName();

  if (!existing) {
    const id = isUuid(storedUser.id) ? storedUser.id : crypto.randomUUID();
    const insertRow = {
      id,
      ...baseRowFromStored(storedUser, nowIso),
      created_at: storedUser.created_at || nowIso,
    };
    const { data, error } = await sb.from(writeTable).insert(insertRow).select("*").single();
    if (error) {
      console.error("[auth/error] supabase insert user", { table: writeTable, message: error.message });
      throw error;
    }
    return rowToStoredUser(data);
  }

  const updateRow = {
    ...baseRowFromStored(storedUser, nowIso),
  };
  const updateTable = existingTable || writeTable;
  const { data, error } = await sb
    .from(updateTable)
    .update(updateRow)
    .eq("id", existing.id)
    .select("*")
    .single();
  if (error) {
    console.error("[auth/error] supabase update user", { table: updateTable, message: error.message });
    throw error;
  }
  return rowToStoredUser(data);
}

/**
 * Normalize legacy user object for DB (plain `pass` → passwordHash; never persist pass).
 */
export function normalizeLegacyUserForDb(legacy) {
  if (!legacy || typeof legacy !== "object") return null;
  const emailNorm = normEmail(legacy.email);
  if (!emailNorm) return null;
  let passwordHash = legacy.passwordHash || null;
  if (!passwordHash && legacy.password_sha256) {
    passwordHash = legacy.password_sha256;
  }
  if (!passwordHash && legacy.pass != null) {
    passwordHash = sha256Hex(String(legacy.pass));
  }
  if (!passwordHash && legacy.password != null) {
    passwordHash = sha256Hex(String(legacy.password));
  }
  if (!passwordHash) return null;
  const out = {
    ...legacy,
    email: emailNorm,
    passwordHash,
  };
  delete out.pass;
  delete out.password;
  delete out._authSource;
  delete out._authMeta;
  return out;
}
