function canChangeRole(actingRole, targetOldRole, targetNewRole, isSelf) {
  const a = (actingRole || "").toLowerCase();
  const from = (targetOldRole || "").toLowerCase();
  const to = (targetNewRole || "").toLowerCase();

  if (!["owner", "admin", "member"].includes(a)) {
    return { allowed: false, error: "Invalid actingRole" };
  }
  if (!["owner", "admin", "member"].includes(from)) {
    return { allowed: false, error: "Invalid targetOldRole" };
  }
  if (!["owner", "admin", "member"].includes(to)) {
    return { allowed: false, error: "Invalid targetNewRole" };
  }
  if (a === "member") return { allowed: false, error: "Members cannot change roles" };
  if (isSelf) return { allowed: false, error: "You cannot change your own role" };

  if (a === "owner") {
    if (from === "owner" || to === "owner") {
      return { allowed: false, error: "Owners cannot change owner roles" };
    }
    if ((from === "admin" || from === "member") && (to === "admin" || to === "member")) {
      return { allowed: true };
    }
    return { allowed: false, error: "Invalid role change" };
  }

  if (from === "owner" || from === "admin") {
    return { allowed: false, error: "Admins cannot change owner or admin roles" };
  }
  if (from === "member" && (to === "member" || to === "admin")) return { allowed: true };
  return { allowed: false, error: "Invalid role change" };
}

function canRemove(actingRole, targetRole) {
  const acting = (actingRole || "").toLowerCase();
  const target = (targetRole || "").toLowerCase();

  if (acting === "owner") {
    if (target === "owner") return { allowed: false, error: "Owners cannot remove other owners" };
    if (target === "admin" || target === "member") return { allowed: true };
    return { allowed: false, error: "Invalid target role" };
  }
  if (acting === "admin") {
    if (target === "member") return { allowed: true };
    if (target === "admin") return { allowed: false, error: "Only owner can remove admins" };
    if (target === "owner") return { allowed: false, error: "Admins cannot remove owners" };
    return { allowed: false, error: "Invalid target role" };
  }
  if (acting === "member") return { allowed: false, error: "Members cannot remove other members" };
  return { allowed: false, error: "Invalid acting role" };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const action = String(req.body?.action || "").toLowerCase();
  if (action === "change-role") {
    const { teamId, memberId, actingUserId, actingRole, targetOldRole, targetNewRole } = req.body || {};
    if (!teamId || !memberId) {
      return res.status(400).json({ ok: false, error: "teamId and memberId are required" });
    }
    if (!actingRole || !targetOldRole || !targetNewRole) {
      return res.status(400).json({
        ok: false,
        error: "actingRole, targetOldRole and targetNewRole are required",
      });
    }
    const isSelf = String(actingUserId || "") === String(memberId || "");
    const result = canChangeRole(actingRole, targetOldRole, targetNewRole, isSelf);
    if (!result.allowed) return res.status(403).json({ ok: false, error: result.error });
    return res.status(200).json({ ok: true });
  }

  if (action === "remove-member") {
    const { teamId, memberId, actingRole, targetRole } = req.body || {};
    if (!teamId || !memberId) {
      return res.status(400).json({ ok: false, error: "teamId and memberId are required" });
    }
    if (!actingRole || !targetRole) {
      return res.status(400).json({ ok: false, error: "actingRole and targetRole are required" });
    }
    if (!["owner", "admin", "member"].includes(String(targetRole).toLowerCase())) {
      return res.status(400).json({ ok: false, error: "Invalid targetRole" });
    }
    const result = canRemove(actingRole, targetRole);
    if (!result.allowed) return res.status(403).json({ ok: false, error: result.error });
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ ok: false, error: "Invalid team action" });
}
