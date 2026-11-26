// 從 Chrome 擴充功能（bilingual-translate）複製共用的 lib/core.js 和 lib/ceec-levels.js（大考中心詞彙表級別）。用法：node tools/sync-core.mjs <bilingual-translate 資料夾>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = process.argv[2] ? path.resolve(process.argv[2], "lib") : path.resolve(root, "..", "bilingual-translate", "lib");
for (const name of ["core.js", "ceec-levels.js"]) {
  const src = path.join(srcDir, name);
  if (!fs.existsSync(src)) throw new Error(`找不到 ${src}`);
  const dst = path.join(root, "lib", name);
  const same = fs.existsSync(dst) && fs.readFileSync(dst, "utf8") === fs.readFileSync(src, "utf8");
  if (!same) fs.copyFileSync(src, dst);
  console.log(same ? `lib/${name} 已經是最新的` : `已更新 lib/${name}（來源 ${src}）`);
}
