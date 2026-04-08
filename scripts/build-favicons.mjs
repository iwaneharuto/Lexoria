/**
 * From public/favicon.svg:
 * - public/favicon-512.png (master raster)
 * - public/favicon.ico + public/favicon-v2.ico (16, 32, 48 embedded)
 * - public/favicon-32x32.png
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const MIN_PNG_SMALL = 200;
const MIN_PNG_512 = 2000;
const MIN_ICO_BYTES = 3000;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const pub = path.join(root, "public");
const svgPath = path.join(pub, "favicon.svg");

const sharp = (await import("sharp")).default;
const pngToIco = (await import("png-to-ico")).default;

function assertPngFile(filePath, minBytes) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < minBytes) {
    throw new Error(`PNG too small (${buf.length} B, need >=${minBytes}): ${filePath}`);
  }
  if (!buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error(`Not a valid PNG (bad signature): ${filePath}`);
  }
}

const svg = fs.readFileSync(svgPath);
if (svg.length < 10) throw new Error("favicon.svg missing or empty");

const out512 = path.join(pub, "favicon-512.png");
const out32 = path.join(pub, "favicon-32x32.png");
const outIco = path.join(pub, "favicon.ico");
const outIcoV2 = path.join(pub, "favicon-v2.ico");

const tmp16 = path.join(pub, ".favicon-tmp-16.png");
const tmp32 = path.join(pub, ".favicon-tmp-32.png");
const tmp48 = path.join(pub, ".favicon-tmp-48.png");

async function writePng(size, dest) {
  await sharp(svg).resize(size, size).png({ compressionLevel: 9 }).toFile(dest);
  const meta = await sharp(dest).metadata();
  if (meta.format !== "png" || meta.width !== size || meta.height !== size) {
    throw new Error(`Invalid PNG output: ${dest} (${meta.width}x${meta.height})`);
  }
}

await writePng(512, out512);
assertPngFile(out512, MIN_PNG_512);

await writePng(32, out32);
assertPngFile(out32, MIN_PNG_SMALL);

await writePng(16, tmp16);
await writePng(32, tmp32);
await writePng(48, tmp48);
assertPngFile(tmp16, MIN_PNG_SMALL);
assertPngFile(tmp32, MIN_PNG_SMALL);
assertPngFile(tmp48, MIN_PNG_SMALL);

const ico = await pngToIco([tmp16, tmp32, tmp48]);
if (ico.length < MIN_ICO_BYTES) {
  throw new Error(`favicon.ico buffer too small (${ico.length} B) — likely corrupt`);
}
fs.writeFileSync(outIco, ico);
fs.writeFileSync(outIcoV2, Buffer.from(ico));
for (const f of [tmp16, tmp32, tmp48]) fs.unlinkSync(f);

for (const f of [outIco, outIcoV2, out32]) {
  const n = fs.statSync(f).size;
  if (f.endsWith(".png")) {
    if (n < MIN_PNG_SMALL) throw new Error(`Output too small: ${f} (${n} bytes)`);
  } else if (n < MIN_ICO_BYTES) {
    throw new Error(`ICO too small: ${f} (${n} bytes)`);
  }
}

const icobuf = fs.readFileSync(outIco);
if (icobuf.readUInt16LE(0) !== 0 || icobuf.readUInt16LE(2) !== 1) {
  throw new Error("favicon.ico: invalid ICONDIR header");
}
const imageCount = icobuf.readUInt16LE(4);
if (imageCount !== 3) {
  throw new Error(`favicon.ico: expected 3 embedded sizes, got ${imageCount}`);
}

console.log(
  "OK",
  path.basename(out512),
  fs.statSync(out512).size,
  "B |",
  path.basename(outIco),
  fs.statSync(outIco).size,
  "B (16+32+48) |",
  path.basename(out32),
  fs.statSync(out32).size,
  "B"
);
