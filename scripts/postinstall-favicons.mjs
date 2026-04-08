/**
 * Runs build:favicons after npm install when sharp is available (e.g. dev install).
 * Skips silently when devDependencies were omitted — repo should still contain committed binaries.
 */
import { spawnSync } from "child_process";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
try {
  require.resolve("sharp");
} catch {
  process.exit(0);
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const r = spawnSync(process.execPath, ["scripts/build-favicons.mjs"], {
  cwd: root,
  stdio: "inherit",
});
if (r.error) process.exit(1);
process.exit(r.status ?? 1);
