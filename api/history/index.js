import {
  normalizeEmail,
  getStoredUser,
  verifyPassword,
} from "../../lib/authStore.js";
import { createServerSupabase } from "../../lib/supabase/server.js";
import { getEmailLookupCandidates } from "../../lib/emailAliases.js";
import {
  mapDbRowToAppEntry,
  appEntryToDbRow,
  isUuid,
} from "../../lib/historySupabase.js";

const MAX_ITEMS = 500;

function omitUndefined(obj) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

/** Postgres unique_violation / 23505（partial unique index 含む） */
function isPostgresUniqueViolation(err) {
  const m = String(err?.message || err?.details || err || "");
  return /duplicate key|unique constraint|23505|history_owner_source_local_unique/i.test(m);
}

/** PostgREST: history に user_id 列が無い（本番が migration 前など） */
function isHistoryUserIdSchemaError(err) {
  const m = String(err?.message || err?.details || err || "");
  return /schema cache/i.test(m) && /user_id/i.test(m);
}

async function historyTableHasUserIdColumn(sb) {
  const { error } = await sb.from("history").select("user_id").limit(1);
  if (!error) return true;
  if (isHistoryUserIdSchemaError(error)) return false;
  return true;
}

function withoutHistoryUserId(patch) {
  if (!patch || typeof patch !== "object") return patch;
  const next = { ...patch };
  delete next.user_id;
  return next;
}

function appRowFromItem(emailNorm, item, lexoriaUserId) {
  return omitUndefined(appEntryToDbRow(emailNorm, item, { lexoriaUserId }));
}

function itemOwnedByUser(item, emailNorm) {
  if (!item || typeof item !== "object") return false;
  if (!item.createdBy) return true;
  return normalizeEmail(item.createdBy) === emailNorm;
}

function summarizeHistoryPayload(item, emailNorm) {
  if (!item || typeof item !== "object") return {};
  return {
    owner_email: emailNorm,
    item_id: item.id || null,
    source_local_id: isUuid(item.id) ? null : String(item.id || ""),
    jurisdiction: item.jurisdiction === "US" ? "US" : "JP",
    organizationId: item.organizationId || null,
    title: item.title || item.consultationTitle || null,
    tags_count: Array.isArray(item.tags) ? item.tags.length : Array.isArray(item?.output?.tags) ? item.output.tags.length : 0,
    deleted: false,
    memo_len: typeof item.memo === "string" ? item.memo.length : 0,
    summary_incoming: item.summary != null ? String(item.summary).slice(0, 120) : null,
  };
}

async function backfillOwnerEmailAliases(sb, emailNorm, nowIso) {
  const candidates = getEmailLookupCandidates(emailNorm);
  if (!candidates || candidates.length <= 1) return;
  const aliases = candidates.filter((x) => x !== emailNorm);
  if (!aliases.length) return;
  const { data: toFix, error: selErr } = await sb
    .from("history")
    .select("id, owner_email")
    .in("owner_email", aliases)
    .eq("deleted", false)
    .limit(MAX_ITEMS);
  if (selErr) {
    console.warn("[history/migrate] alias backfill select failed", selErr.message);
    return;
  }
  const rows = Array.isArray(toFix) ? toFix : [];
  if (!rows.length) return;
  const ids = rows.map((r) => r.id).filter(Boolean);
  if (!ids.length) return;
  const { error: upErr } = await sb
    .from("history")
    .update({ owner_email: emailNorm, updated_at: nowIso })
    .in("id", ids);
  if (upErr) {
    console.warn("[history/migrate] alias backfill update failed", upErr.message);
    return;
  }
  console.log("[history/migrate] owner_email backfilled", {
    canonical: emailNorm,
    aliases,
    count: ids.length,
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const sb = createServerSupabase();
  if (!sb) {
    console.error("[history/error] Supabase not configured (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY)");
    return res.status(503).json({ ok: false, error: "supabase_not_configured" });
  }

  const body = req.body || {};
  const action = String(body.action || "").trim().toLowerCase();
  const emailNorm = normalizeEmail(body.email || "");
  const password = body.password || "";

  if (!emailNorm || !password) {
    return res.status(400).json({ ok: false, error: "email and password are required" });
  }

  const stored = await getStoredUser(emailNorm);
  const auth = verifyPassword(stored, password);
  if (!auth.ok) {
    console.warn("[history/error] unauthorized", { action, email: emailNorm });
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const nowIso = new Date().toISOString();
  const emailCandidates = getEmailLookupCandidates(emailNorm);

  function pickDebugRowFields(row) {
    if (!row || typeof row !== "object") return null;
    return {
      id: row.id ?? null,
      title: row.title ?? null,
      summary: row.summary != null ? String(row.summary) : null,
      owner_email: row.owner_email ?? null,
      user_id: row.user_id ?? null,
      jurisdiction: row.jurisdiction ?? null,
      organizationId: row.organizationId ?? null,
      created_at: row.created_at ?? null,
      updated_at: row.updated_at ?? null,
      is_deleted: row.deleted ?? null,
      tags: row.tags ?? null,
      source_local_id: row.source_local_id ?? null,
    };
  }

  try {
    await backfillOwnerEmailAliases(sb, emailNorm, nowIso);

    let lexoriaUserIdForHistoryWrite = null;
    if ((action === "import_bulk" || action === "upsert") && stored?.id) {
      if (await historyTableHasUserIdColumn(sb)) {
        lexoriaUserIdForHistoryWrite = stored.id;
      } else {
        console.warn("[history/schema] history.user_id column missing; omitting from writes");
      }
    }

    if (action === "debug") {
      const debugJur = String(body.jurisdiction || "").trim().toUpperCase();
      const wantedJur = debugJur === "US" || debugJur === "JP" ? debugJur : null;
      const organizationId = body.organizationId != null ? String(body.organizationId) : null;

      const debugEmailCandidates =
        Array.isArray(body.emailCandidates) && body.emailCandidates.length
          ? body.emailCandidates.map((x) => String(x).trim().toLowerCase())
          : emailCandidates;
      const candidatesUnique = Array.from(new Set(debugEmailCandidates)).filter(Boolean);

      const sinceMinutes = Number.isFinite(Number(body.sinceMinutes)) ? Number(body.sinceMinutes) : 20;
      const sinceIso = new Date(Date.now() - sinceMinutes * 60 * 1000).toISOString();

      let authUserId = null;
      try {
        const adminRes = await sb.auth.admin.getUserByEmail(emailNorm);
        authUserId = adminRes?.data?.user?.id || null;
      } catch (e) {
        authUserId = null;
      }

      async function countStep(q) {
        const { count, error } = await q.select("*", { count: "exact", head: true });
        if (error) return { count: null, error: error.message };
        return { count: count || 0, error: null };
      }

      const baseQ = sb.from("history").in("owner_email", candidatesUnique);

      const step1 = await countStep(baseQ);
      const step2 = await countStep(baseQ.eq("deleted", false));
      const step3 = wantedJur ? await countStep(baseQ.eq("deleted", false).eq("jurisdiction", wantedJur)) : null;

      let step4 = null;
      if (wantedJur && organizationId) {
        const qOrg = baseQ.eq("deleted", false).eq("jurisdiction", wantedJur).eq("organizationId", organizationId);
        const rOrg = await countStep(qOrg);
        if (!rOrg.error) {
          step4 = { ...rOrg, used: "organizationId" };
        } else {
          const qAsg = baseQ.eq("deleted", false).eq("jurisdiction", wantedJur).eq("assignee", organizationId);
          const rAsg = await countStep(qAsg);
          step4 = { ...rAsg, used: "assignee" };
        }
      }

      // 直近 row（sinceIso）
      let latestRow = null;
      try {
        const { data: rows, error } = await sb
          .from("history")
          .select("*")
          .in("owner_email", candidatesUnique)
          .eq("deleted", false)
          .gte("created_at", sinceIso)
          .order("created_at", { ascending: false })
          .limit(1);
        if (!error && Array.isArray(rows) && rows[0]) latestRow = rows[0];
      } catch (eLat) {}

      // 列存在 probe（無い場合はエラーが返る）
      let columnProbe = {};
      try {
        const { data: probeRows, error: probeErr } = await sb
          .from("history")
          .select("user_id, organizationId")
          .in("owner_email", candidatesUnique)
          .eq("deleted", false)
          .limit(1);
        columnProbe = {
          ok: !probeErr,
          user_id_value: probeRows && probeRows[0] ? probeRows[0].user_id ?? null : null,
          organizationId_value: probeRows && probeRows[0] ? probeRows[0].organizationId ?? null : null,
          error: probeErr ? probeErr.message : null,
        };
      } catch (eCol) {
        columnProbe = { ok: false, error: String(eCol && eCol.message ? eCol.message : eCol) };
      }

      const userIdValue = columnProbe && columnProbe.user_id_value ? columnProbe.user_id_value : null;
      // user_id は DB に存在しない可能性があるため、エラーはそのまま debug に含める（推測しない）
      const step1_user_id_only = userIdValue ? await countStep(sb.from("history").eq("user_id", userIdValue)) : null;
      const step2_plus_deleted_false_user_id_only = userIdValue
        ? await countStep(sb.from("history").eq("user_id", userIdValue).eq("deleted", false))
        : null;
      const step3_plus_jurisdiction_user_id_only = wantedJur && userIdValue
        ? await countStep(sb.from("history").eq("user_id", userIdValue).eq("deleted", false).eq("jurisdiction", wantedJur))
        : null;
      let step4_plus_organizationId_user_id_only = null;
      if (wantedJur && organizationId && userIdValue) {
        const qOrgU = sb
          .from("history")
          .eq("user_id", userIdValue)
          .eq("deleted", false)
          .eq("jurisdiction", wantedJur)
          .eq("organizationId", organizationId);
        const rOrgU = await countStep(qOrgU);
        if (!rOrgU.error) {
          step4_plus_organizationId_user_id_only = { ...rOrgU, used: "organizationId" };
        } else {
          const qAsgU = sb
            .from("history")
            .eq("user_id", userIdValue)
            .eq("deleted", false)
            .eq("jurisdiction", wantedJur)
            .eq("assignee", organizationId);
          const rAsgU = await countStep(qAsgU);
          step4_plus_organizationId_user_id_only = { ...rAsgU, used: "assignee" };
        }
      }

      return res.status(200).json({
        ok: true,
        debug: {
          auth: {
            email: emailNorm,
            supabase_auth_user_id: authUserId,
            lexoria_user_id: stored && stored.id ? stored.id : null,
          },
          owner_email_candidates: candidatesUnique,
          requested_filters: { jurisdiction: wantedJur, organizationId, sinceIso },
          counts: {
            step1_owner_email_only: step1,
            step1_user_id_only: step1_user_id_only,
            step2_plus_deleted_false: step2,
            step2_plus_deleted_false_user_id_only: step2_plus_deleted_false_user_id_only,
            step3_plus_jurisdiction: step3,
            step3_plus_jurisdiction_user_id_only: step3_plus_jurisdiction_user_id_only,
            step4_plus_organizationId: step4,
            step4_plus_organizationId_user_id_only: step4_plus_organizationId_user_id_only,
          },
          latest_row: latestRow
            ? {
                id: latestRow.id,
                owner_email: latestRow.owner_email,
                user_id: latestRow.user_id ?? null,
                jurisdiction: latestRow.jurisdiction,
                organizationId: latestRow.organizationId ?? null,
                is_deleted: latestRow.deleted,
                created_at: latestRow.created_at,
                title: latestRow.title,
                tags: latestRow.tags,
              }
            : null,
          column_probe: columnProbe,
        },
      });
    }

    if (action === "list") {
      const listJurisdiction = body.jurisdiction === "US" ? "US" : "JP";
      const listTeamId = body.team_id || body.teamId || null;
      const canUseUserIdLookup = !!(stored?.id && (await historyTableHasUserIdColumn(sb)));
      console.log("[history/debug] list request", {
        current_user_id: emailNorm,
        current_lexoria_user_id: stored?.id || null,
        current_jurisdiction: listJurisdiction,
        current_team_id: listTeamId,
        conditions: {
          user_id: canUseUserIdLookup ? stored.id : null,
          owner_email: emailNorm,
          owner_email_candidates: emailCandidates,
          deleted: false,
          order: "updated_at desc",
          limit: MAX_ITEMS,
        },
      });
      let rowsByUserId = [];
      if (canUseUserIdLookup) {
        const { data: uRows, error: uErr } = await sb
          .from("history")
          .select("*")
          .eq("user_id", stored.id)
          .eq("deleted", false)
          .order("updated_at", { ascending: false })
          .limit(MAX_ITEMS);
        if (uErr) {
          console.warn("[history/list] user_id query failed; fallback to owner_email", uErr.message);
        } else {
          rowsByUserId = Array.isArray(uRows) ? uRows : [];
        }
      }

      const { data: rowsByEmail, error } = await sb
        .from("history")
        .select("*")
        .in("owner_email", emailCandidates)
        .eq("deleted", false)
        .order("updated_at", { ascending: false })
        .limit(MAX_ITEMS);

      if (error) {
        console.error("[history/error] list query", error.message);
        return res.status(500).json({ ok: false, error: error.message });
      }

      const mergedRows = [];
      const seen = new Set();
      for (const r of rowsByUserId || []) {
        if (!r?.id || seen.has(r.id)) continue;
        seen.add(r.id);
        mergedRows.push(r);
      }
      for (const r of rowsByEmail || []) {
        if (!r?.id || seen.has(r.id)) continue;
        seen.add(r.id);
        mergedRows.push(r);
      }

      const items = (mergedRows || [])
        .map((r) => mapDbRowToAppEntry(r))
        .filter(Boolean);
      const firstRaw = mergedRows && mergedRows[0] ? mergedRows[0] : null;
      console.log("[history/debug] list result", {
        current_user_id: emailNorm,
        current_lexoria_user_id: stored?.id || null,
        current_jurisdiction: listJurisdiction,
        query_mode: canUseUserIdLookup ? "user_id+owner_email" : "owner_email_only",
        fetched_user_id_rows: rowsByUserId.length,
        fetched_owner_email_rows: (rowsByEmail || []).length,
        fetched_row_count: items.length,
        first_row_id: items[0]?.id || null,
      });
      console.log("[history/fetch]", emailNorm, items.length);
      return res.status(200).json({
        ok: true,
        items,
        debugMeta: {
          query_mode: canUseUserIdLookup ? "user_id+owner_email" : "owner_email_only",
          fetched_user_id_rows: rowsByUserId.length,
          fetched_owner_email_rows: (rowsByEmail || []).length,
          first_row_id: firstRaw?.id ?? null,
          first_row_title: firstRaw?.title ?? null,
          first_row_user_id: firstRaw?.user_id ?? null,
          first_row_jurisdiction: firstRaw?.jurisdiction ?? null,
          selected_jurisdiction: listJurisdiction,
          selected_team_id: listTeamId,
        },
      });
    }

    if (action === "import_bulk") {
      const { count, error: cErr } = await sb
        .from("history")
        .select("*", { count: "exact", head: true })
        .in("owner_email", emailCandidates)
        .eq("deleted", false);

      if (cErr) {
        console.error("[history/error] import_bulk count", cErr.message);
        return res.status(500).json({ ok: false, error: cErr.message });
      }
      if ((count || 0) > 0) {
        return res.status(409).json({ ok: false, error: "history_not_empty" });
      }

      const incoming = Array.isArray(body.items) ? body.items : [];
      if (incoming.length > MAX_ITEMS) {
        return res.status(400).json({ ok: false, error: "too_many_items" });
      }

      for (let i = 0; i < incoming.length; i++) {
        const it = incoming[i];
        if (it && it.createdBy && normalizeEmail(it.createdBy) !== emailNorm) {
          return res.status(400).json({ ok: false, error: "import_bulk owner mismatch" });
        }
      }

      const chunkSize = 80;
      let inserted = 0;
      for (let off = 0; off < incoming.length; off += chunkSize) {
        const slice = incoming.slice(off, off + chunkSize);
        const dbRows = slice.map((it) => {
          const next = { ...it };
          if (!next.createdBy) next.createdBy = emailNorm;
          const row = appRowFromItem(emailNorm, next, lexoriaUserIdForHistoryWrite);
          row.updated_at = nowIso;
          row.created_at = nowIso;
          return row;
        });
        if (dbRows.length) {
          console.log("[history/save-payload] summary (pre-write import_bulk)", {
            email: emailNorm,
            chunk_size: dbRows.length,
            first_summary: dbRows[0].summary,
            first_summary_len: String(dbRows[0].summary || "").length,
          });
        }
        let { error: insErr } = await sb.from("history").insert(dbRows);
        if (insErr && isHistoryUserIdSchemaError(insErr)) {
          const stripped = dbRows.map((r) => withoutHistoryUserId(r));
          ({ error: insErr } = await sb.from("history").insert(stripped));
        }
        if (insErr) {
          console.error("[history/error] import_bulk insert", insErr.message);
          return res.status(500).json({ ok: false, error: insErr.message });
        }
        inserted += dbRows.length;
      }
      console.log("[history/save]", emailNorm, "import_bulk", inserted);
      return res.status(200).json({ ok: true, count: inserted });
    }

    if (action === "upsert") {
      const item = body.item && typeof body.item === "object" ? body.item : null;
      if (!item || !item.id) {
        return res.status(400).json({ ok: false, error: "item.id is required" });
      }
      if (!itemOwnedByUser(item, emailNorm)) {
        console.warn("[history/error] upsert forbidden owner", item.id, emailNorm);
        return res.status(403).json({ ok: false, error: "forbidden" });
      }

      item.createdBy = item.createdBy || emailNorm;
      const base = appRowFromItem(emailNorm, item, lexoriaUserIdForHistoryWrite);
      base.updated_at = nowIso;
      console.log("[history/save-payload] summary (pre-write upsert)", {
        email: emailNorm,
        item_id: item.id,
        summary: base.summary,
        summary_len: typeof base.summary === "string" ? base.summary.length : 0,
      });
      console.log("[history/debug] insert payload", {
        current_user_id: emailNorm,
        current_jurisdiction: item.jurisdiction === "US" ? "US" : "JP",
        payload: summarizeHistoryPayload(item, emailNorm),
      });

      if (isUuid(item.id)) {
        const { data: existingRows, error: selErr } = await sb
          .from("history")
          .select("id")
          .eq("id", item.id)
          .in("owner_email", emailCandidates)
          .eq("deleted", false)
          .limit(1);

        if (selErr) {
          console.error("[history/error] upsert select uuid", selErr.message);
          return res.status(500).json({ ok: false, error: selErr.message });
        }

        const existing = Array.isArray(existingRows) && existingRows[0] ? existingRows[0] : null;

        if (existing?.id) {
          let { error: upErr } = await sb
            .from("history")
            .update(base)
            .eq("id", existing.id)
            .eq("deleted", false);

          if (upErr && isHistoryUserIdSchemaError(upErr)) {
            ({ error: upErr } = await sb
              .from("history")
              .update(withoutHistoryUserId(base))
              .eq("id", existing.id)
              .eq("deleted", false));
          }
          if (upErr) {
            console.error("[history/error] upsert update", upErr.message);
            return res.status(500).json({ ok: false, error: upErr.message });
          }
          console.log("[history/update]", existing.id, "fields", Object.keys(base).join(","));
          try {
            const { data: savedRow } = await sb
              .from("history")
              .select("*")
              .eq("id", existing.id)
              .maybeSingle();
            const savedRowForDebug = pickDebugRowFields(savedRow);
            console.log("[history/debug] upsert saved row (uuid update)", savedRowForDebug);
            return res.status(200).json({
              ok: true,
              id: existing.id,
              idReassigned: false,
              savedRow: savedRowForDebug,
            });
          } catch (eSel) {
            return res.status(200).json({
              ok: true,
              id: existing.id,
              idReassigned: false,
            });
          }
        }

        let insertPayload = { ...base, id: item.id, created_at: nowIso };
        let { data: ins, error: insErr } = await sb
          .from("history")
          .insert(insertPayload)
          .select("id")
          .single();

        if (insErr && isHistoryUserIdSchemaError(insErr)) {
          insertPayload = withoutHistoryUserId(insertPayload);
          ({ data: ins, error: insErr } = await sb
            .from("history")
            .insert(insertPayload)
            .select("id")
            .single());
        }

        if (insErr) {
          if (isPostgresUniqueViolation(insErr)) {
            const { data: exUuid, error: exErr } = await sb
              .from("history")
              .select("id")
              .eq("id", item.id)
              .in("owner_email", emailCandidates)
              .eq("deleted", false)
              .limit(1);
            const row0 = Array.isArray(exUuid) && exUuid[0] ? exUuid[0] : null;
            if (!exErr && row0?.id) {
              let { error: upR } = await sb
                .from("history")
                .update(base)
                .eq("id", row0.id)
                .eq("deleted", false);
              if (upR && isHistoryUserIdSchemaError(upR)) {
                ({ error: upR } = await sb
                  .from("history")
                  .update(withoutHistoryUserId(base))
                  .eq("id", row0.id)
                  .eq("deleted", false));
              }
              if (!upR) {
                console.log("[history/update]", row0.id, "uuid insert race → update");
                try {
                  const { data: savedRow } = await sb
                    .from("history")
                    .select("*")
                    .eq("id", row0.id)
                    .maybeSingle();
                  const savedRowForDebug = pickDebugRowFields(savedRow);
                  console.log("[history/debug] upsert saved row (uuid conflict update)", savedRowForDebug);
                  return res.status(200).json({
                    ok: true,
                    id: row0.id,
                    idReassigned: false,
                    savedRow: savedRowForDebug,
                  });
                } catch (eSelR) {
                  return res.status(200).json({ ok: true, id: row0.id, idReassigned: false });
                }
              }
            }
          }
          console.error("[history/error] upsert insert uuid", insErr.message, {
            current_user_id: emailNorm,
            payload: summarizeHistoryPayload(item, emailNorm),
          });
          return res.status(500).json({ ok: false, error: insErr.message });
        }
        console.log("[history/debug] insert result", {
          current_user_id: emailNorm,
          insert_id: ins?.id || null,
          insert_error: null,
        });
        console.log("[history/save]", emailNorm, ins.id, "new (client uuid)");
        try {
          const { data: savedRow } = await sb
            .from("history")
            .select("*")
            .eq("id", ins.id)
            .maybeSingle();
          const savedRowForDebug = pickDebugRowFields(savedRow);
          console.log("[history/debug] upsert saved row (uuid insert)", savedRowForDebug);
          return res.status(200).json({
            ok: true,
            id: ins.id,
            idReassigned: false,
            savedRow: savedRowForDebug,
          });
        } catch (eSel2) {
          return res.status(200).json({ ok: true, id: ins.id, idReassigned: false });
        }
      }

      const sid = String(item.id);
      const { data: dupRows, error: dupErr } = await sb
        .from("history")
        .select("id")
        .in("owner_email", emailCandidates)
        .eq("source_local_id", sid)
        .eq("deleted", false)
        .order("updated_at", { ascending: false })
        .limit(1);

      if (dupErr) {
        console.error("[history/error] upsert select local", dupErr.message);
        return res.status(500).json({ ok: false, error: dupErr.message });
      }

      const dup = Array.isArray(dupRows) && dupRows[0] ? dupRows[0] : null;

      if (dup?.id) {
        let { error: upErr } = await sb
          .from("history")
          .update(base)
          .eq("id", dup.id)
          .eq("deleted", false);

        if (upErr && isHistoryUserIdSchemaError(upErr)) {
          ({ error: upErr } = await sb
            .from("history")
            .update(withoutHistoryUserId(base))
            .eq("id", dup.id)
            .eq("deleted", false));
        }
        if (upErr) {
          console.error("[history/error] upsert update local", upErr.message);
          return res.status(500).json({ ok: false, error: upErr.message });
        }
        console.log("[history/update]", dup.id, "source_local_id", sid);
        try {
          const { data: savedRow } = await sb
            .from("history")
            .select("*")
            .eq("id", dup.id)
            .maybeSingle();
          const savedRowForDebug = pickDebugRowFields(savedRow);
          console.log("[history/debug] upsert saved row (local dup update)", savedRowForDebug);
          return res.status(200).json({
            ok: true,
            id: dup.id,
            previousId: sid,
            idReassigned: true,
            savedRow: savedRowForDebug,
          });
        } catch (eSel3) {
          return res.status(200).json({
            ok: true,
            id: dup.id,
            previousId: sid,
            idReassigned: true,
          });
        }
      }

      let insertPayload = { ...base, created_at: nowIso };
      let { data: ins2, error: ins2Err } = await sb
        .from("history")
        .insert(insertPayload)
        .select("id")
        .single();

      if (ins2Err && isHistoryUserIdSchemaError(ins2Err)) {
        insertPayload = withoutHistoryUserId(insertPayload);
        ({ data: ins2, error: ins2Err } = await sb
          .from("history")
          .insert(insertPayload)
          .select("id")
          .single());
      }

      if (ins2Err) {
        if (isPostgresUniqueViolation(ins2Err)) {
          console.warn("[history/upsert] unique violation on local insert, falling back to update", {
            sid,
            message: ins2Err.message,
          });
          const { data: exRows, error: exErr } = await sb
            .from("history")
            .select("id")
            .in("owner_email", emailCandidates)
            .eq("source_local_id", sid)
            .eq("deleted", false)
            .order("updated_at", { ascending: false })
            .limit(1);
          const exId = !exErr && Array.isArray(exRows) && exRows[0]?.id ? exRows[0].id : null;
          if (exId) {
            let { error: upErr3 } = await sb
              .from("history")
              .update(base)
              .eq("id", exId)
              .eq("deleted", false);
            if (upErr3 && isHistoryUserIdSchemaError(upErr3)) {
              ({ error: upErr3 } = await sb
                .from("history")
                .update(withoutHistoryUserId(base))
                .eq("id", exId)
                .eq("deleted", false));
            }
            if (!upErr3) {
              console.log("[history/update]", exId, "source_local_id", sid, "(post-unique-violation)");
              try {
                const { data: savedRow } = await sb
                  .from("history")
                  .select("*")
                  .eq("id", exId)
                  .maybeSingle();
                const savedRowForDebug = pickDebugRowFields(savedRow);
                console.log("[history/debug] upsert saved row (local conflict update)", savedRowForDebug);
                return res.status(200).json({
                  ok: true,
                  id: exId,
                  previousId: sid,
                  idReassigned: true,
                  savedRow: savedRowForDebug,
                });
              } catch (eSel5) {
                return res.status(200).json({
                  ok: true,
                  id: exId,
                  previousId: sid,
                  idReassigned: true,
                });
              }
            }
          }
        }
        console.error("[history/error] upsert insert local", ins2Err.message, {
          current_user_id: emailNorm,
          payload: summarizeHistoryPayload(item, emailNorm),
        });
        return res.status(500).json({ ok: false, error: ins2Err.message });
      }
      console.log("[history/debug] insert result", {
        current_user_id: emailNorm,
        insert_id: ins2?.id || null,
        insert_error: null,
      });
      console.log("[history/save]", emailNorm, ins2.id, "new (local id → uuid)");
      try {
        const { data: savedRow } = await sb
          .from("history")
          .select("*")
          .eq("id", ins2.id)
          .maybeSingle();
        const savedRowForDebug = pickDebugRowFields(savedRow);
        console.log("[history/debug] upsert saved row (local insert)", savedRowForDebug);
        return res.status(200).json({
          ok: true,
          id: ins2.id,
          previousId: sid,
          idReassigned: true,
          savedRow: savedRowForDebug,
        });
      } catch (eSel4) {
        return res.status(200).json({
          ok: true,
          id: ins2.id,
          previousId: sid,
          idReassigned: true,
        });
      }
    }

    if (action === "delete") {
      const id = String(body.id || "").trim();
      if (!id) {
        return res.status(400).json({ ok: false, error: "id is required" });
      }

      const { data: target, error: tErr } = await sb
        .from("history")
        .select("id, owner_email")
        .eq("id", id)
        .in("owner_email", emailCandidates)
        .eq("deleted", false)
        .maybeSingle();

      if (tErr) {
        console.error("[history/error] delete select", tErr.message);
        return res.status(500).json({ ok: false, error: tErr.message });
      }
      if (!target) {
        console.warn("[history/delete] not found", id);
        return res.status(404).json({ ok: false, error: "not_found" });
      }
      if (!itemOwnedByUser({ createdBy: target.owner_email }, emailNorm)) {
        return res.status(403).json({ ok: false, error: "forbidden" });
      }

      const { error: dErr } = await sb
        .from("history")
        .update({ deleted: true, updated_at: nowIso })
        .eq("id", id)
        .eq("deleted", false);

      if (dErr) {
        console.error("[history/error] delete update", dErr.message);
        return res.status(500).json({ ok: false, error: dErr.message });
      }
      console.log("[history/delete]", id);
      return res.status(200).json({ ok: true, id });
    }

    return res.status(400).json({ ok: false, error: "unknown action" });
  } catch (error) {
    console.error("[history/error]", error?.message || error);
    return res.status(500).json({ ok: false, error: error?.message || "server error" });
  }
}
