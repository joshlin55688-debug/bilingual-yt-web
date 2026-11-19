// 從 Chrome 擴充功能（bilingual-translate）複製共用的 lib/core.js。用法：node tools/sync-core.mjs <bilingual-translate 資料夾>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = process.argv[2] ? path.resolve(process.argv[2], "lib", "core.js") : path.resolve(root, "..", "bilingual-translate", "lib", "core.js");
if (!fs.existsSync(src)) throw new Error(`找不到 ${src}`);
const dst = path.join(root, "lib", "core.js");
const same = fs.existsSync(dst) && fs.readFileSync(dst, "utf8") === fs.readFileSync(src, "utf8");
if (!same) fs.copyFileSync(src, dst);
console.log(same ? "lib/core.js 已經是最新的" : `已更新 lib/core.js（來源 ${src}）`);
