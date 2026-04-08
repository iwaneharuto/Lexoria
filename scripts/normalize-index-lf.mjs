/**
 * Force LF line endings in public/index.html (avoids Cursor Keep failing on CRLF vs LF patches on Windows).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = path.join(root, "public", "index.html");
let s = fs.readFileSync(p, "utf8");
s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
if (!s.endsWith("\n")) s += "\n";
fs.writeFileSync(p, s, "utf8");
console.log("OK:", p, "LF-only");
