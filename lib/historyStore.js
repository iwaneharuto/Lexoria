/**
 * @deprecated 履歴の正は Supabase `history` テーブル（/api/history）。KV/ファイルは未使用。
 */
import { kv } from "@vercel/kv";
import fs from "fs/promises";
import path from "path";
import { normalizeEmail } from "./authStore.js";

const FILE_PATH = path.join(process.cwd(), ".data", "user-histories.json");

export function getHistoryKvKey(email) {
  return `hist:${normalizeEmail(email)}`;
}

async function readFileDb() {
  try {
    const raw = await fs.readFile(FILE_PATH, "utf8");
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error && error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeFileDb(db) {
  await fs.mkdir(path.dirname(FILE_PATH), { recursive: true });
  await fs.writeFile(FILE_PATH, JSON.stringify(db, null, 2), "utf8");
}

function normalizeItemsFromStored(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && Array.isArray(data.items)) return data.items;
  return [];
}

/**
 * @param {string} email
 * @returns {Promise<object[]>}
 */
export async function getUserHistoryList(email) {
  const emailNorm = normalizeEmail(email);
  if (!emailNorm) return [];
  const key = getHistoryKvKey(emailNorm);
  if (kv) {
    try {
      const data = await kv.get(key);
      const items = normalizeItemsFromStored(data);
      if (items.length) return items;
    } catch (error) {
      console.warn("[history/store] kv get failed, fallback file", {
        key,
        message: error?.message,
      });
    }
  }
  const db = await readFileDb();
  const row = db[emailNorm];
  return Array.isArray(row) ? row : normalizeItemsFromStored(row);
}

/**
 * @param {string} email
 * @param {object[]} items
 */
export async function setUserHistoryList(email, items) {
  const emailNorm = normalizeEmail(email);
  if (!emailNorm) throw new Error("email is required");
  const key = getHistoryKvKey(emailNorm);
  const payload = {
    v: 1,
    items,
    updatedAt: new Date().toISOString(),
  };
  if (kv) {
    try {
      await kv.set(key, payload);
    } catch (error) {
      console.warn("[history/store] kv set failed, fallback file", {
        key,
        message: error?.message,
      });
    }
  }
  const db = await readFileDb();
  db[emailNorm] = items;
  await writeFileDb(db);
}
