import crypto from "crypto";
import { kv } from "@vercel/kv";
import fs from "fs/promises";
import path from "path";
import {
  isSupabaseAuthConfigured,
  fetchLexoriaUserRowWithMeta,
  upsertLexoriaUser,
  rowToStoredUser,
  normalizeLegacyUserForDb,
  getLexoriaUsersTableName,
  getLexoriaUserReadTableOrder,
} from "./lexoriaUserDb.js";
import { readSupabaseServerEnv } from "./supabase/server.js";
import { canonicalizeEmail, getEmailLookupCandidates } from "./emailAliases.js";

/** ログ・クライアント向けに揃えるソースラベル（4値） */
export const AUTH_SOURCE = Object.freeze({
  supabase: "supabase",
  legacy_kv: "legacy_kv",
  local_file: "local_file",
  not_found: "not_found",
});

function normalizeAuthSourceLabel(raw) {
  if (raw === AUTH_SOURCE.supabase) return AUTH_SOURCE.supabase;
  if (raw === AUTH_SOURCE.local_file) return AUTH_SOURCE.local_file;
  if (raw === AUTH_SOURCE.legacy_kv) return AUTH_SOURCE.legacy_kv;
  if (raw === "legacy_kv_fallback" || raw === "legacy_rescue") return AUTH_SOURCE.legacy_kv;
  if (!raw || raw === AUTH_SOURCE.not_found) return AUTH_SOURCE.not_found;
  return AUTH_SOURCE.legacy_kv;
}

function attachAuthTrace(user, emailNorm, authSourceRaw, readTablesTried, hitTable) {
  const authSource = normalizeAuthSourceLabel(authSourceRaw);
  if (!user) return null;
  delete user._authSource;
  delete user._authMeta;
  const meta = {
    authSource,
    readTablesTried: Array.isArray(readTablesTried) ? [...readTablesTried] : [],
    hitTable: hitTable != null ? hitTable : null,
    email: emailNorm,
  };
  Object.defineProperty(user, "_authSource", { value: authSource, enumerable: false, writable: true });
  Object.defineProperty(user, "_authMeta", { value: meta, enumerable: false, writable: true });
  return user;
}

/** API ログイン成功時など、stored からメタを取り出す（スプレッドで落ちないようここで読む） */
export function getAuthMetaForLog(stored, emailNorm) {
  const em = normalizeEmail(emailNorm);
  const m = stored && stored._authMeta;
  const authSource = stored
    ? normalizeAuthSourceLabel(m?.authSource ?? stored._authSource)
    : AUTH_SOURCE.not_found;
  const readTablesTried =
    m && Array.isArray(m.readTablesTried) && m.readTablesTried.length > 0
      ? [...m.readTablesTried]
      : getLexoriaUserReadTableOrder();
  return {
    authSource,
    readTablesTried,
    hitTable: m?.hitTable ?? null,
    email: em,
    writeTable: getLexoriaUsersTableName(),
  };
}

/**
 * getStoredUser の全 return 直前で呼ぶ（本番でも追いやすい固定 prefix）
 */
function logGetStoredUserAlways(user, emailNorm, authSourceRaw, readTablesTried, hitTable) {
  const authSource = normalizeAuthSourceLabel(authSourceRaw);
  const dbEmail = user && user.email != null ? normalizeEmail(user.email) : "";
  console.log(`[auth/getStoredUser] authSource=${authSource}`);
  console.log(`[auth/getStoredUser] hitTable=${hitTable ?? ""}`);
  console.log(`[auth/getStoredUser] normalizedEmail=${emailNorm}`);
  console.log(`[auth/getStoredUser] dbEmail=${dbEmail}`);
  console.log("[auth/getStoredUser] readTablesTried", readTablesTried);
  console.log(`[auth/getStoredUser] authSource=${authSource} email=${emailNorm}`);
}

function returnGetStoredUser(user, emailNorm, authSourceRaw, readTablesTried, hitTable) {
  logGetStoredUserAlways(user, emailNorm, authSourceRaw, readTablesTried, hitTable);
  if (!user) return null;
  return attachAuthTrace(user, emailNorm, authSourceRaw, readTablesTried, hitTable);
}

export function normalizeEmail(email) {
  return canonicalizeEmail(email);
}

/** 登録・ログイン・reset 共通: UTF-8 文字列の SHA-256 → 小文字 hex（64 文字） */
export function hashPassword(password) {
  return crypto.createHash("sha256").update(String(password), "utf8").digest("hex");
}

function normalizeHexHash(value) {
  return String(value || "").trim().toLowerCase();
}

export function verifyPassword(storedUser, plainPassword) {
  const password = String(plainPassword || "");
  if (!storedUser || !password) {
    return { ok: false, reason: "user_not_found", shouldUpgradeHash: false };
  }
  const inputHash = normalizeHexHash(hashPassword(password));
  if (storedUser.passwordHash) {
    const storedNorm = normalizeHexHash(storedUser.passwordHash);
    const ok = Boolean(storedNorm) && storedNorm === inputHash;
    return { ok, reason: ok ? "password_matched" : "password_mismatch", shouldUpgradeHash: false };
  }
  if (storedUser.password_sha256) {
    const storedNorm = normalizeHexHash(storedUser.password_sha256);
    const ok = Boolean(storedNorm) && storedNorm === inputHash;
    return { ok, reason: ok ? "legacy_password_sha256_matched" : "password_mismatch", shouldUpgradeHash: ok };
  }
  if (storedUser.pass != null) {
    const ok = String(storedUser.pass) === password;
    return { ok, reason: ok ? "legacy_pass_matched" : "password_mismatch", shouldUpgradeHash: ok };
  }
  if (storedUser.password != null) {
    const ok = String(storedUser.password) === password;
    return { ok, reason: ok ? "legacy_password_matched" : "password_mismatch", shouldUpgradeHash: ok };
  }
  return { ok: false, reason: "password_hash_missing", shouldUpgradeHash: false };
}

export function getUserKey(email) {
  return `user:${normalizeEmail(email)}`;
}

const FILE_DB_DIR = path.join(process.cwd(), ".data");
const FILE_DB_PATH = path.join(FILE_DB_DIR, "auth-users.json");

async function readFileDb() {
  try {
    const raw = await fs.readFile(FILE_DB_PATH, "utf8");
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error && error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeFileDb(db) {
  await fs.mkdir(FILE_DB_DIR, { recursive: true });
  await fs.writeFile(FILE_DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

export function toPublicUser(storedUser) {
  return {
    id: storedUser.id,
    email: storedUser.email,
    name: storedUser.name,
    created_at: storedUser.created_at,
    trialStart: storedUser.trialStart != null ? storedUser.trialStart : null,
    trialStartedAt: storedUser.trialStartedAt != null ? storedUser.trialStartedAt : null,
    trialEndsAt: storedUser.trialEndsAt != null ? storedUser.trialEndsAt : null,
    trialCount: storedUser.trialCount != null ? storedUser.trialCount : 0,
    trialStatus: storedUser.trialStatus != null ? storedUser.trialStatus : null,
  };
}

/**
 * @returns {Promise<{ user: object|null, legacySource: 'legacy_kv'|'local_file'|null }>}
 */
async function getLegacyUserFromSingleKey(keyEmailNorm) {
  if (!keyEmailNorm) return { user: null, legacySource: null };
  const key = getUserKey(keyEmailNorm);
  if (kv) {
    try {
      const user = await kv.get(key);
      if (user && typeof user === "object") return { user, legacySource: AUTH_SOURCE.legacy_kv };
    } catch (error) {
      console.warn("[auth/error] kv get failed, fallback to file store", {
        key,
        message: error?.message,
      });
    }
  }
  const db = await readFileDb();
  const user = db[keyEmailNorm];
  if (user && typeof user === "object") return { user, legacySource: AUTH_SOURCE.local_file };
  return { user: null, legacySource: null };
}

async function getLegacyUserWithSource(emailNorm) {
  if (!emailNorm) return { user: null, legacySource: null };
  const tryKeys = getEmailLookupCandidates(emailNorm);
  if (emailNorm === "support@lexoriaai.com" && !tryKeys.includes("support@lexoriaaai.com")) {
    tryKeys.push("support@lexoriaaai.com");
  }
  for (const k of tryKeys) {
    const r = await getLegacyUserFromSingleKey(k);
    if (r.user) {
      return {
        user: { ...r.user, email: emailNorm },
        legacySource: r.legacySource,
      };
    }
  }
  return { user: null, legacySource: null };
}

async function putLegacyUserOnly(emailNorm, storedUser) {
  const next = { ...(storedUser || {}), email: emailNorm };
  const key = getUserKey(emailNorm);
  if (kv) {
    try {
      await kv.set(key, next);
    } catch (error) {
      console.warn("[auth/store] kv set failed, fallback to file store", {
        key,
        message: error?.message,
      });
    }
  }
  const db = await readFileDb();
  db[emailNorm] = next;
  await writeFileDb(db);
}

/**
 * Supabase 優先（必ず先に DB を参照）。未設定時のみ legacy。
 * 0 件のときだけ KV/ファイル → 可能なら lexoria_users へ upsert 移行。
 * 全 return 直前に [auth/getStoredUser] ログを出す。
 */
export async function getStoredUser(email) {
  const emailNorm = normalizeEmail(email);
  const readOrder = getLexoriaUserReadTableOrder();
  const emptyTried = [];

  if (!emailNorm) {
    logGetStoredUserAlways("", AUTH_SOURCE.not_found, emptyTried, null);
    return null;
  }

  const supabaseEnv = readSupabaseServerEnv();
  if (!supabaseEnv.ok) {
    console.warn("[auth/error] supabase env incomplete — legacy only", {
      hasUrl: Boolean(supabaseEnv.url),
      hasSecretKey: Boolean(supabaseEnv.secretKey),
      secretFrom: supabaseEnv.secretFrom,
      writeTable: getLexoriaUsersTableName(),
      readTables: readOrder,
    });
    const { user: legOnly, legacySource } = await getLegacyUserWithSource(emailNorm);
    if (!legOnly) {
      return returnGetStoredUser(null, emailNorm, AUTH_SOURCE.not_found, emptyTried, null);
    }
    return returnGetStoredUser(
      { ...legOnly },
      emailNorm,
      legacySource || AUTH_SOURCE.legacy_kv,
      emptyTried,
      null
    );
  }

  if (!isSupabaseAuthConfigured()) {
    console.error("[auth/error] readSupabaseServerEnv ok but createServerSupabase failed (unexpected)");
    const { user: legOnly, legacySource } = await getLegacyUserWithSource(emailNorm);
    if (!legOnly) {
      return returnGetStoredUser(null, emailNorm, AUTH_SOURCE.not_found, emptyTried, null);
    }
    return returnGetStoredUser(
      { ...legOnly },
      emailNorm,
      legacySource || AUTH_SOURCE.legacy_kv,
      emptyTried,
      null
    );
  }

  try {
    const { row, table: hitTable, readTablesTried } = await fetchLexoriaUserRowWithMeta(emailNorm);
    if (row) {
      const rawDb = String(row.email || "").trim().toLowerCase();
      if (rawDb !== emailNorm && canonicalizeEmail(rawDb) === emailNorm) {
        try {
          const uFix = rowToStoredUser(row);
          await upsertLexoriaUser(normalizeLegacyUserForDb(uFix));
          console.log("[auth/migrate] DB email alias canonicalized in lexoria_users", {
            normalizedEmail: emailNorm,
            previousDbEmail: rawDb,
          });
          const meta2 = await fetchLexoriaUserRowWithMeta(emailNorm);
          if (meta2.row) {
            const u2 = rowToStoredUser(meta2.row);
            return returnGetStoredUser(
              u2,
              emailNorm,
              AUTH_SOURCE.supabase,
              meta2.readTablesTried,
              meta2.table
            );
          }
        } catch (e) {
          console.error("[auth/error] canonicalize DB email failed", e?.message || e);
        }
      }
      const u = rowToStoredUser(row);
      return returnGetStoredUser(u, emailNorm, AUTH_SOURCE.supabase, readTablesTried, hitTable);
    }

    const { user: legacy, legacySource } = await getLegacyUserWithSource(emailNorm);
    if (legacy) {
      const normalized = normalizeLegacyUserForDb(legacy);
      if (normalized) {
        try {
          await upsertLexoriaUser(normalized);
          console.log("[auth/migrate] legacy user copied to Supabase", { email: emailNorm });
          const metaAfter = await fetchLexoriaUserRowWithMeta(emailNorm);
          if (metaAfter.row) {
            const u2 = rowToStoredUser(metaAfter.row);
            return returnGetStoredUser(
              u2,
              emailNorm,
              AUTH_SOURCE.supabase,
              metaAfter.readTablesTried,
              metaAfter.table
            );
          }
        } catch (e) {
          console.error("[auth/error] migrate legacy to supabase", e?.message || e);
        }
      }
      console.warn("[auth/error] supabase miss — using legacy", {
        email: emailNorm,
        writeTable: getLexoriaUsersTableName(),
        readTablesTried,
      });
      return returnGetStoredUser(
        { ...legacy },
        emailNorm,
        legacySource || AUTH_SOURCE.legacy_kv,
        readTablesTried,
        null
      );
    }

    return returnGetStoredUser(null, emailNorm, AUTH_SOURCE.not_found, readTablesTried, null);
  } catch (e) {
    console.error("[auth/error] getStoredUser supabase", e?.message || e);
    const { user: leg, legacySource } = await getLegacyUserWithSource(emailNorm);
    if (!leg) {
      return returnGetStoredUser(null, emailNorm, AUTH_SOURCE.not_found, emptyTried, null);
    }
    return returnGetStoredUser(
      { ...leg },
      emailNorm,
      legacySource || AUTH_SOURCE.legacy_kv,
      emptyTried,
      null
    );
  }
}

/**
 * Supabase 設定時は lexoria_users のみ更新。未設定時は従来 KV/ファイル。
 */
export async function putStoredUser(email, storedUser) {
  const emailNorm = normalizeEmail(email);
  if (!emailNorm) throw new Error("email is required");
  const next = { ...(storedUser || {}), email: emailNorm };

  if (readSupabaseServerEnv().ok && isSupabaseAuthConfigured()) {
    const forDb = normalizeLegacyUserForDb(next);
    if (!forDb || !forDb.passwordHash) {
      throw new Error("passwordHash required for Supabase user persist");
    }
    await upsertLexoriaUser(forDb);
    return;
  }

  await putLegacyUserOnly(emailNorm, next);
}
