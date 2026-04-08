import crypto from "crypto";
import {
  normalizeEmail,
  hashPassword,
  verifyPassword,
  getUserKey,
  getStoredUser,
  putStoredUser,
  toPublicUser,
  getAuthMetaForLog,
  AUTH_SOURCE,
} from "../../lib/authStore.js";
import { getLexoriaUsersTableName, getLexoriaUserReadTableOrder } from "../../lib/lexoriaUserDb.js";
import { getSupabaseConnectionDiagnostics } from "../../lib/supabase/server.js";
import {
  evaluateOrganizeAccess,
  getEffectivePlanTier,
  isDeveloperOverrideEmail,
  isPaidSubscriptionActive,
} from "../../lib/trialAccess.js";

const LEGACY_RESCUE_USERS = Object.freeze([
  { email: "iwaharu.422@outlook.jp", password: "Haruto55", name: "開発者" },
]);

async function tryRescueKnownLegacyUser(emailNorm, password) {
  for (const user of LEGACY_RESCUE_USERS) {
    if (normalizeEmail(user.email) !== emailNorm) continue;
    if (String(user.password) !== String(password || "")) continue;
    const rescued = {
      id: crypto.randomUUID(),
      email: emailNorm,
      name: user.name || emailNorm,
      passwordHash: hashPassword(password),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      trialStart: null,
      trialStartedAt: null,
      trialEndsAt: null,
      trialCount: 0,
      trialStatus: null,
    };
    try {
      await putStoredUser(emailNorm, rescued);
    } catch (e) {
      console.error("[auth/error] legacy rescue put failed", e?.message || e);
      return null;
    }
    console.log("[auth/login] legacy rescue user created", { email: emailNorm, key: getUserKey(emailNorm) });
    Object.defineProperty(rescued, "_authSource", { value: AUTH_SOURCE.legacy_kv, enumerable: false, writable: true });
    Object.defineProperty(rescued, "_authMeta", {
      value: {
        authSource: AUTH_SOURCE.legacy_kv,
        readTablesTried: getLexoriaUserReadTableOrder(),
        hitTable: null,
        email: emailNorm,
      },
      enumerable: false,
      writable: true,
    });
    return rescued;
  }
  return null;
}

function extractAction(req) {
  const fromQuery = typeof req.query?.action === "string" ? req.query.action : "";
  const fromBody = typeof req.body?.action === "string" ? req.body.action : "";
  const action = (fromQuery || fromBody || "").trim().toLowerCase();

  if (action) return action;
  if (req.method === "POST" && req.body?.password && req.body?.name) return "register";
  if (req.method === "POST" && req.body?.password) return "login";
  if (req.method === "GET") return "me";
  return "";
}

export default async function handler(req, res) {
  const action = extractAction(req);

  if (req.method === "POST" && action === "register") {
    const { email, name, password } = req.body || {};
    if (!email || typeof email !== "string" || !email.trim()) {
      return res.status(400).json({ ok: false, error: "email is required" });
    }
    if (!password || typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ ok: false, error: "password must be at least 8 characters" });
    }
    const emailNorm = normalizeEmail(email);
    const regHash = hashPassword(password);
    console.log("[auth/register] supabase env", {
      ...getSupabaseConnectionDiagnostics(),
      writeTable: getLexoriaUsersTableName(),
      readTables: getLexoriaUserReadTableOrder(),
    });
    console.log("[auth/register] normalized email", emailNorm);
    console.log("[auth/register] password hash meta", {
      algorithm: "sha256-utf8-hex",
      hexLength: regHash.length,
    });
    try {
      const existing = await getStoredUser(emailNorm);
      if (existing) {
        return res.status(409).json({ ok: false, error: "このメールアドレスは既に登録されています" });
      }

      const storedUser = {
        id: crypto.randomUUID(),
        email: emailNorm,
        name: (name && String(name).trim()) || emailNorm,
        passwordHash: hashPassword(password),
        created_at: new Date().toISOString(),
        trialStart: null,
        trialStartedAt: null,
        trialEndsAt: null,
        trialCount: 0,
        trialStatus: null,
      };
      await putStoredUser(emailNorm, storedUser);
      console.log("[auth/register] user inserted", { email: emailNorm, id: storedUser.id });
      return res.status(200).json({ ok: true, user: toPublicUser(storedUser) });
    } catch (error) {
      console.error("[auth/error] register", error?.message || error);
      return res.status(500).json({ error: error?.message || "registration failed" });
    }
  }

  if (req.method === "POST" && action === "login") {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "email and password are required" });
    }
    const emailRaw = String(email || "").trim();
    const emailNorm = normalizeEmail(email);
    console.log("[auth/login] supabase env", {
      ...getSupabaseConnectionDiagnostics(),
      writeTable: getLexoriaUsersTableName(),
      readTables: getLexoriaUserReadTableOrder(),
    });
    console.log(`[auth/login] emailInput=${emailRaw}`);
    console.log(`[auth/login] normalizedEmail=${emailNorm}`);
    let stored = await getStoredUser(emailNorm);
    if (!stored) {
      console.log("[auth/login] user not found after getStoredUser", { email: emailNorm });
      const rescued = await tryRescueKnownLegacyUser(emailNorm, password);
      if (rescued) {
        stored = await getStoredUser(emailNorm);
        if (!stored) stored = rescued;
      }
    }
    const auth = verifyPassword(stored, password);
    const verifyMeta = getAuthMetaForLog(stored, emailNorm);
    const loginInputHash = hashPassword(password);
    const shRaw = stored?.passwordHash;
    const shNorm =
      shRaw != null ? String(shRaw).trim().toLowerCase() : "";
    console.log("[auth/login] verify", {
      algorithm: "sha256-utf8-hex",
      authSource: verifyMeta.authSource,
      readTables: verifyMeta.readTablesTried,
      writeTable: verifyMeta.writeTable,
      email: verifyMeta.email,
      hasStoredHash: Boolean(shRaw),
      storedHashLen: shRaw != null ? String(shRaw).trim().length : null,
      inputHashLen: loginInputHash.length,
      prefix4Match:
        shNorm.length >= 4 &&
        loginInputHash.slice(0, 4) === shNorm.slice(0, 4),
      fullMatch: auth.ok,
      reason: auth.reason,
    });
    if (!auth.ok) {
      if (auth.reason === "password_hash_missing") {
        console.warn("[auth/error] login password hash missing", { email: emailNorm });
      } else {
        console.warn("[auth/error] login password mismatch", { email: emailNorm, reason: auth.reason });
      }
      return res.status(401).json({ ok: false, error: "メールアドレスまたはパスワードが正しくありません" });
    }

    const successMeta = getAuthMetaForLog(stored, emailNorm);
    const dbEmailSaved = stored && stored.email != null ? String(stored.email).trim().toLowerCase() : null;
    if (dbEmailSaved && dbEmailSaved !== emailNorm) {
      console.warn("[auth/login] stored.email differs from normalized request (unexpected)", {
        normalizedEmail: emailNorm,
        storedEmail: dbEmailSaved,
      });
    }
    console.log(`[auth/login] authSource=${successMeta.authSource}`);
    console.log(`[auth/login] hitTable=${successMeta.hitTable ?? ""}`);
    console.log(`[auth/login] normalizedEmail=${successMeta.email}`);
    console.log(`[auth/login] dbEmail=${dbEmailSaved ?? ""}`);
    console.log("[auth/login] readTables", successMeta.readTablesTried);
    console.log("[auth/login] writeTable", successMeta.writeTable);
    console.log(
      `[auth/login] authSource=${successMeta.authSource} email=${successMeta.email}`
    );

    if (auth.shouldUpgradeHash) {
      stored = { ...stored, passwordHash: hashPassword(password) };
      await putStoredUser(emailNorm, stored);
      console.log("[auth/login] migrated legacy password to passwordHash", {
        email: emailNorm,
        key: getUserKey(emailNorm),
      });
    }
    const subscription_active = isPaidSubscriptionActive(stored);
    const developer_override = isDeveloperOverrideEmail(stored?.email);
    const effective_plan = developer_override ? "pro" : getEffectivePlanTier(stored);
    const access = evaluateOrganizeAccess(stored, new Date(), "ja");
    const trial_expired = !subscription_active && access && access.ok === false && access.code === "TRIAL_EXPIRED";
    const trial_limit_reached = !subscription_active && access && access.ok === false && access.code === "TRIAL_LIMIT_REACHED";
    const usage_count = Number.isFinite(Number(stored?.trialCount)) ? Number(stored.trialCount) : 0;
    const trial_ends_at = stored?.trialEndsAt ?? null;
    return res.status(200).json({
      ok: true,
      user: toPublicUser(stored),
      status: {
        subscription_active,
        trial_expired,
        trial_limit_reached,
        usage_count,
        trial_ends_at,
        effective_plan,
        developer_override,
      },
    });
  }

  if (req.method === "POST" && action === "logout") {
    console.log("[auth/logout] session-only logout (no DB delete)");
    return res.status(200).json({ ok: true });
  }

  if (req.method === "GET" && action === "me") {
    const email = normalizeEmail(req.query?.email || "");
    if (!email) return res.status(400).json({ ok: false, error: "email is required" });
    const stored = await getStoredUser(email);
    if (!stored) return res.status(404).json({ ok: false, error: "user not found" });
    const subscription_active = isPaidSubscriptionActive(stored);
    const developer_override = isDeveloperOverrideEmail(stored?.email);
    const effective_plan = developer_override ? "pro" : getEffectivePlanTier(stored);
    const access = evaluateOrganizeAccess(stored, new Date(), "ja");
    const trial_expired = !subscription_active && access && access.ok === false && access.code === "TRIAL_EXPIRED";
    const trial_limit_reached = !subscription_active && access && access.ok === false && access.code === "TRIAL_LIMIT_REACHED";
    const usage_count = Number.isFinite(Number(stored?.trialCount)) ? Number(stored.trialCount) : 0;
    const trial_ends_at = stored?.trialEndsAt ?? null;
    return res.status(200).json({
      ok: true,
      user: toPublicUser(stored),
      status: {
        subscription_active,
        trial_expired,
        trial_limit_reached,
        usage_count,
        trial_ends_at,
        effective_plan,
        developer_override,
      },
    });
  }

  if (req.method === "POST" && action === "sync-profile") {
    const emailNorm = normalizeEmail(req.body?.email || "");
    const password = req.body?.password || "";
    const profile = req.body?.profile && typeof req.body.profile === "object" ? req.body.profile : {};
    if (!emailNorm || !password) {
      return res.status(400).json({ ok: false, error: "email and password are required" });
    }
    const existing = await getStoredUser(emailNorm);
    console.log("[auth/sync-profile] lookup", {
      key: getUserKey(emailNorm),
      found: Boolean(existing),
      hasPasswordHash: Boolean(existing && existing.passwordHash),
    });
    const auth = verifyPassword(existing, password);
    if (!auth.ok) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    const baseUser = auth.shouldUpgradeHash
      ? { ...existing, passwordHash: hashPassword(password) }
      : existing;

    const updates = {
      email: emailNorm,
      trialStart: profile.trialStart != null ? profile.trialStart : existing.trialStart ?? null,
      trialStartedAt: profile.trialStartedAt != null ? profile.trialStartedAt : existing.trialStartedAt ?? null,
      trialEndsAt: profile.trialEndsAt != null ? profile.trialEndsAt : existing.trialEndsAt ?? null,
      trialCount: Number.isFinite(Number(profile.trialCount)) ? Number(profile.trialCount) : existing.trialCount ?? 0,
      trialStatus: profile.trialStatus != null ? profile.trialStatus : existing.trialStatus ?? null,
    };

    const updated = {
      ...baseUser,
      ...updates,
      passwordHash: baseUser.passwordHash,
    };

    console.log("[auth/sync-profile] before put", {
      key: getUserKey(emailNorm),
      hasPasswordHash: Boolean(existing.passwordHash),
    });
    console.log("[auth/sync-profile] persisting", {
      key: getUserKey(emailNorm),
      hasPasswordHash: Boolean(updated.passwordHash),
    });
    await putStoredUser(emailNorm, updated);
    console.log("[auth/sync-profile] after put", {
      key: getUserKey(emailNorm),
      hasPasswordHash: Boolean(updated.passwordHash),
    });
    return res.status(200).json({ ok: true, user: toPublicUser(updated) });
  }

  /**
   * ログイン中ユーザーが現在パスワードを確認したうえで新パスワードへ更新。
   * （Lexoria は Supabase Auth の GoTrue パスワードではなく、アプリ側 passwordHash を使用）
   */
  if (req.method === "POST" && action === "change-password") {
    const emailNorm = normalizeEmail(req.body?.email || "");
    const currentPassword = String(req.body?.currentPassword ?? "");
    const newPassword = String(req.body?.newPassword ?? "");
    if (!emailNorm || !currentPassword || !newPassword) {
      return res.status(400).json({
        ok: false,
        code: "validation",
        error: "メールアドレス・現在のパスワード・新しいパスワードが必要です",
      });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({
        ok: false,
        code: "password_too_short",
        error: "新しいパスワードは8文字以上にしてください",
      });
    }
    const hasLetter = /[A-Za-z]/.test(newPassword);
    const hasDigit = /[0-9]/.test(newPassword);
    if (!hasLetter || !hasDigit) {
      return res.status(400).json({
        ok: false,
        code: "password_need_alnum",
        error: "新しいパスワードは英字と数字の両方を含めてください",
      });
    }
    const existing = await getStoredUser(emailNorm);
    if (!existing) {
      return res.status(404).json({
        ok: false,
        code: "user_not_found",
        error: "ユーザーが見つかりません",
      });
    }
    const auth = verifyPassword(existing, currentPassword);
    if (!auth.ok) {
      return res.status(401).json({
        ok: false,
        code: "wrong_current_password",
        error: "現在のパスワードが正しくありません",
      });
    }
    const baseUser = auth.shouldUpgradeHash
      ? { ...existing, passwordHash: hashPassword(currentPassword) }
      : existing;
    const updated = {
      ...baseUser,
      passwordHash: hashPassword(newPassword),
      updated_at: new Date().toISOString(),
    };
    try {
      await putStoredUser(emailNorm, updated);
    } catch (e) {
      console.error("[auth/error] change-password put failed", e?.message || e);
      return res.status(500).json({
        ok: false,
        code: "server_error",
        error: e?.message || "パスワードの更新に失敗しました",
      });
    }
    console.log("[auth/change-password] password updated", { email: emailNorm });
    return res.status(200).json({ ok: true });
  }

  if (req.method === "POST" && action === "forgot-password") {
    const emailNorm = normalizeEmail(req.body?.email || "");
    if (!emailNorm) {
      return res.status(400).json({ ok: false, error: "email is required" });
    }
    let found = false;
    try {
      const existing = await getStoredUser(emailNorm);
      found = Boolean(existing);
      console.log("[auth/forgot-password] lookup", { email: emailNorm, found });
    } catch (error) {
      console.error("[auth/error] forgot-password lookup", error?.message || error);
    }
    return res.status(200).json({ ok: true, sent: true, found });
  }

  if (req.method === "POST" && action === "reset-password") {
    const emailNorm = normalizeEmail(req.body?.email || "");
    const newPassword = String(req.body?.newPassword || "");
    if (!emailNorm || !newPassword) {
      return res.status(400).json({ ok: false, error: "email and newPassword are required" });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ ok: false, error: "password must be at least 8 characters" });
    }
    console.log("[auth/reset] normalized email", emailNorm);
    let existing = await getStoredUser(emailNorm);
    if (!existing) {
      for (const user of LEGACY_RESCUE_USERS) {
        if (normalizeEmail(user.email) !== emailNorm) continue;
        existing = {
          id: crypto.randomUUID(),
          email: emailNorm,
          name: user.name || emailNorm,
          created_at: new Date().toISOString(),
          trialStart: null,
          trialStartedAt: null,
          trialEndsAt: null,
          trialCount: 0,
          trialStatus: null,
        };
        console.log("[auth/reset] user found (legacy rescue skeleton)", { email: emailNorm });
        break;
      }
    }
    if (!existing) {
      console.warn("[auth/reset] user not found", { email: emailNorm });
      return res.status(404).json({ ok: false, error: "user not found" });
    }
    console.log("[auth/reset] user found", { email: emailNorm });
    const updated = {
      ...existing,
      email: emailNorm,
      passwordHash: hashPassword(newPassword),
      updated_at: new Date().toISOString(),
    };
    try {
      await putStoredUser(emailNorm, updated);
    } catch (e) {
      console.error("[auth/error] reset put failed", e?.message || e);
      return res.status(500).json({ ok: false, error: e?.message || "reset failed" });
    }
    console.log("[auth/reset] password updated", { email: emailNorm });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ ok: false, error: "Method/action not allowed" });
}
