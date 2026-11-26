// 雙語 YT 端到端測試：假的 YouTube 播放器（test/fake-yt.js）＋假的 Gemini（本機伺服器），不花錢。
// 平板直放（800×1280）與橫放（1280×800），觸控模擬。用法：node test/e2e.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test", "out");
fs.mkdirSync(outDir, { recursive: true });
const PORT = 8795;
const calls = { transcribe: [], translate: [], word: [], vocab: [] };

const mmss = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
function gemini(body) {
  const parts = body.contents[0].parts;
  const sys = body.systemInstruction?.parts?.[0]?.text || "";
  const reply = (obj) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 } });
  const file = parts.find((p) => p.fileData);
  if (file) {
    const vid = new URL(file.fileData.fileUri).searchParams.get("v");
    const meta = parts.find((p) => p.videoMetadata)?.videoMetadata || file.videoMetadata;
    const from = parseFloat(meta.startOffset), to = parseFloat(meta.endOffset);
    const words = Number(/max about (\d+) words/.exec(parts.find((p) => p.text)?.text || "")?.[1]);
    calls.transcribe.push({ vid, from, to, words });
    if (vid.startsWith("PRIVATE")) return { status: 400, body: { error: { message: "The video is not available (private)." } } };
    // 沒有播放器的影片當成 4 分鐘長：之後的段沒有語音
    if (vid.startsWith("NOEMBED") && from >= 240) return { status: 200, body: reply({ segs: [] }) };
    const segs = [];
    const gapReq = to - from < 59; // 補漏的請求（一整段是 60 秒）
    for (let s = Math.ceil((from + 1) / 6) * 6 - 5; s < to; s += 6) {
      if (s < from) continue;
      const n = Math.round((s + 5) / 6);
      // 3:20–3:40：整段轉錄時模型漏掉這 20 秒（照真實情況：講得很密時 Gemini 會跳過一段）；補漏的請求才轉得出來
      if (!gapReq && s >= 200 && s < 220) continue;
      // 第 120 秒交界：一句話被切成兩半
      if (s >= 114 && s < 120) segs.push({ s: mmss(118), e: mmss(119.9), t: "This sentence crosses the" });
      else if (s >= 120 && s < 126 && from === 120) segs.push({ s: mmss(120.3), e: mmss(122), t: "window boundary." });
      // 第 8 句：模型把結束時間標太長（43 秒開始、標成 58 秒結束）
      else segs.push({ s: mmss(s), e: mmss(s + (n === 8 ? 15 : 4)), t: `Spoken line ${n} of the talk.` });
    }
    return { status: 200, body: reply({ segs }) };
  }
  if (/dictionary/i.test(sys) && !/language learner/.test(sys)) {
    const word = JSON.parse(parts[0].text).word;
    calls.word.push(word);
    return { status: 200, body: reply({ word, phonetic: "/fake/", entries: [{ pos: "名詞", defs: ["假的釋義"] }] }) };
  }
  // 單字表：第 2 句挑「Spoken line」、第 5 句挑「of the talk」（片語，留著）、第 4 句挑 talk（學測 Level 1，濾掉）
  if (/language learner/.test(sys)) {
    const items = JSON.parse(parts[0].text).items;
    calls.vocab.push(items.map((x) => x.text));
    const v = [];
    for (const x of items) {
      if (/line 2 /.test(x.text)) v.push({ id: x.id, term: "Spoken line", base: "spoken line", zh: "口說的一行" });
      if (/line 4 /.test(x.text)) v.push({ id: x.id, term: "talk", base: "talk", zh: "談話" });
      if (/line 5 /.test(x.text)) v.push({ id: x.id, term: "of the talk", base: "of the talk", zh: "這場演講的" });
    }
    return { status: 200, body: reply({ v }) };
  }
  const items = JSON.parse(parts[0].text).items;
  calls.translate.push(...items);
  // 照真實情況：模型偶爾整批照抄原文。第 30–33 句所在的整批請求照抄（單句重翻才翻得出來）；第 35 句永遠照抄
  const echo = items.some((x) => /line 35 /.test(x)) || (items.length > 1 && items.some((x) => /line 3[0-3] /.test(x)));
  return { status: 200, body: reply({ t: items.map((x) => (echo ? x : "【譯】" + x)) }) };
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (req.method === "POST" && u.pathname.startsWith("/mock/")) {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const r = gemini(JSON.parse(b));
      setTimeout(() => res.writeHead(r.status, { "content-type": "application/json" }).end(JSON.stringify(r.body)), 150);
    });
    return;
  }
  if (u.pathname === "/fake-yt.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(fs.readFileSync(path.join(root, "test", "fake-yt.js")));
  const p = path.join(root, u.pathname === "/" ? "index.html" : u.pathname);
  if (!p.startsWith(root) || !fs.existsSync(p)) return res.writeHead(404).end();
  let data = fs.readFileSync(p);
  if (p.endsWith("index.html"))
    data = String(data).replace('<script src="lib/core.js">', `<script>BLYT_API_BASE="http://127.0.0.1:${PORT}/mock";BLYT_YT_API="/fake-yt.js";</script><script src="lib/core.js">`);
  const type = p.endsWith(".js") ? "text/javascript" : p.endsWith(".svg") ? "image/svg+xml" : "text/html; charset=utf-8";
  res.writeHead(200, { "content-type": type }).end(data);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const results = [];
const check = (name, ok, detail = "") => (results.push({ name, ok }), console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); let v; while (!(v = await fn()) && Date.now() - t0 < ms) await sleep(100); return v; };

const browser = await puppeteer.launch({ headless: true, args: ["--no-first-run", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
// 私人影片的 400 回應會在主控台記一筆「Failed to load resource」，那是預期的
page.on("console", (m) => m.type() === "error" && !/favicon|status of 400/.test(m.text()) && errors.push(m.text()));
await page.emulate({ viewport: { width: 800, height: 1280, isMobile: true, hasTouch: true, deviceScaleFactor: 1 }, userAgent: "Mozilla/5.0 (Linux; Android 14; Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36" });
const dl = path.join(outDir, "dl");
fs.rmSync(dl, { recursive: true, force: true });
fs.mkdirSync(dl, { recursive: true });
const cdp = await page.createCDPSession();
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dl });
const BASE = `http://127.0.0.1:${PORT}/`;
await page.goto(BASE);
const text = (sel) => page.$eval(sel, (e) => e.textContent).catch(() => "");
const tap = (sel) => page.tap(sel);
const loadVideo = async (url) => {
  await page.$eval("#url", (e) => (e.value = ""));
  await page.type("#url", url);
  await tap("#load");
};

// U：網址解析
const ids = await page.evaluate(() =>
  ["https://youtu.be/AAAAAAAAAAA?si=x", "https://www.youtube.com/watch?v=AAAAAAAAAAA&t=5", "https://m.youtube.com/watch?v=AAAAAAAAAAA", "youtube.com/shorts/AAAAAAAAAAA", "https://www.youtube.com/live/AAAAAAAAAAA", "AAAAAAAAAAA", "https://example.com/watch?v=AAAAAAAAAAA", "hello"].map((u) => BLYT_videoIdOf(u)),
);
check("U1 各種 YouTube 網址都認得、其他網站不認", JSON.stringify(ids) === JSON.stringify(["AAAAAAAAAAA", "AAAAAAAAAAA", "AAAAAAAAAAA", "AAAAAAAAAAA", "AAAAAAAAAAA", "AAAAAAAAAAA", null, null]), JSON.stringify(ids));

// K：沒有金鑰 → 按開始會打開設定
await loadVideo("https://youtu.be/AAAAAAAAAAA");
await until(() => page.$eval("#startRow", (e) => getComputedStyle(e).display !== "none"));
check("K1 載入後顯示整部預估費用", /整部 5:00.*US\$/.test(await text("#estimate")), await text("#estimate"));
await tap("#start");
check("K2 沒有金鑰時按開始會打開設定", await until(() => page.$eval("#settings", (e) => e.open)));
check("K3 沒有金鑰時不送出任何請求", calls.transcribe.length === 0);
await page.type("#apiKey", "test-key-not-real");
await page.evaluate(() => document.querySelector("#settings").close());
check("K4 金鑰存在這個瀏覽器裡", (await page.evaluate(() => JSON.parse(localStorage.getItem("blyt-settings")).apiKey)) === "test-key-not-real");

// T：轉錄、翻譯、字幕
await tap("#start");
await page.evaluate(() => (window.__fake.seekTo(2), window.__fake.playVideo()));
const sub = await until(async () => { const t = await text("#subs .box"); return /Spoken line 1/.test(t) && /【譯】/.test(t) ? t : null; });
check("T1 字幕疊層出現原文＋譯文", !!sub, await text("#subs .box"));
await sleep(500);
check("T2 一開始只轉目前那段和下一段（每段 1 分鐘）", JSON.stringify(calls.transcribe.map((c) => c.from)) === "[0,60]", JSON.stringify(calls.transcribe));
check("T2b 預設每句短（約 8 字），字幕換得快", calls.transcribe.every((c) => c.words === 8), JSON.stringify(calls.transcribe.map((c) => c.words)));
const rows = await page.$$eval(".row", (rs) => rs.map((r) => r.textContent));
check("T3 逐字稿有句子和譯文", rows.length >= 15 && rows.every((r) => /【譯】|…/.test(r)), `${rows.length} 句`);
check("T5 翻譯帶影片標題當上下文", calls.translate.length > 0);
check("T6 狀態列顯示進度", /已轉好 0:00–2:00/.test(await text("#status")), await text("#status"));
// 2 分鐘交界：播到第 2 段時會轉第 3 段，兩段都到了就接回一句
await page.evaluate(() => window.__fake.seekTo(100));
const joined = await until(async () => { const j = (await page.$$eval(".row", (rs) => rs.map((r) => r.textContent))).filter((r) => /crosses the/.test(r)); return j.length === 1 && /crosses the window boundary\./.test(j[0]) ? j : null; });
check("T4 切在段落交界的半句接回一句", !!joined, JSON.stringify(joined));

// 點逐字稿的句子 → 跳過去；跳到第 3 段會開始轉第 3 段
const row = await page.$$(".row");
const target = await page.evaluate(() => [...document.querySelectorAll(".row")].findIndex((r) => /Spoken line 30 /.test(r.textContent)));
await row[target].tap();
await sleep(300);
const tAfter = await page.evaluate(() => window.__fake.getCurrentTime());
check("T7 點逐字稿的句子會跳到那句", Math.abs(tAfter - 175) < 1.5, `${tAfter.toFixed(1)} 秒`);
// 補漏：3:00–4:00 那段整段轉錄漏了 3:20–3:40，要自動補轉那個空檔
const filled = await until(async () => (await page.$$eval(".row", (rs) => rs.map((r) => r.textContent))).filter((r) => /Spoken line (35|36|37) /.test(r)).length === 3, 10000);
const gapCalls = calls.transcribe.filter((c) => c.to - c.from < 59);
check("G1 漏掉的 20 秒自動補轉回來", !!filled && gapCalls.some((c) => c.from <= 204 && c.to >= 218), JSON.stringify(gapCalls));
check("G2 補漏只補空檔（沒有空檔的段不多送）", gapCalls.every((c) => c.from >= 180 && c.to <= 240), JSON.stringify(gapCalls));
check("G3 補回來的句子照時間排、沒有重複", await page.$$eval(".row time", (ts) => { const s = ts.map((t) => t.textContent); return new Set(s).size === s.length; }));
// 照抄原文：整批沒翻要抓出來單句重翻；重翻還是原文就顯示翻譯失敗，不能把英文當譯文
const rowOf = (n) => page.evaluate((n) => [...document.querySelectorAll(".row")].find((r) => new RegExp(`Spoken line ${n} `).test(r.textContent))?.textContent || "", n);
const echoFixed = await until(async () => { for (const n of [30, 31, 32, 33]) if (!/【譯】/.test(await rowOf(n))) return false; return true; }, 10000);
check("E2 整批照抄原文時，自動單句重翻成功", !!echoFixed, await rowOf(31));
const echoFail = await until(async () => /翻譯失敗/.test(await rowOf(35)), 10000);
check("E3 重翻還是原文就顯示翻譯失敗（不把英文當譯文）", !!echoFail, await rowOf(35));
const cachedEcho = await page.evaluate(async () => (await BLYT.translateTexts(["Spoken line 35 of the talk."]))[0]);
check("E4 照抄的結果不存快取（之後會再試）", !!cachedEcho.error && !cachedEcho.cached, JSON.stringify(cachedEcho));
await page.evaluate(() => window.__fake.seekTo(250));
check("T8 跳到 4 分之後會轉最後一段", !!(await until(() => calls.transcribe.some((c) => c.from === 240))), JSON.stringify(calls.transcribe.map((c) => c.from)));
check("T9 目前這句在逐字稿裡高亮", !!(await until(() => page.$eval(".row.cur", (r) => /Spoken line 42 /.test(r.textContent)).catch(() => false))), await text(".row.cur"));

// 上一句、下一句、重播
await page.evaluate(() => window.__fake.seekTo(62));
await sleep(300);
await tap("#next");
await sleep(200);
const tNext = await page.evaluate(() => window.__fake.getCurrentTime());
await tap("#prev");
await sleep(200);
const tPrev = await page.evaluate(() => window.__fake.getCurrentTime());
check("C1 下一句、上一句", Math.abs(tNext - 67) < 0.6 && Math.abs(tPrev - 61) < 1.2, `next ${tNext.toFixed(1)}, prev ${tPrev.toFixed(1)}`);

// 句尾暫停
await tap("#autoPause");
await page.evaluate(() => (window.__fake.seekTo(73), window.__fake.playVideo()));
const paused = await until(() => page.evaluate(() => window.__fake.getPlayerState() === 2), 6000);
const tPause = await page.evaluate(() => window.__fake.getCurrentTime());
check("C2 句尾暫停：播完這句就停", !!paused && tPause > 76 && tPause < 77.5, `停在 ${tPause.toFixed(1)}`);
await tap("#autoPause");

// 樣式
await page.evaluate(() => window.__fake.seekTo(14));
await page.select("#subStyle", "translation");
await sleep(400);
const onlyTr = await page.$$eval("#subs .box > div", (d) => d.map((x) => x.className));
check("C3 只顯示譯文", JSON.stringify(onlyTr) === '["tr"]', JSON.stringify(onlyTr));
await page.select("#subStyle", "blur");
await sleep(400);
check("C4 譯文模糊", await page.$eval("#subs", (e) => e.classList.contains("blur") && getComputedStyle(e.querySelector(".tr")).filter.includes("blur")));
await page.select("#subStyle", "dual");

// 查單字
await page.evaluate(() => window.__fake.playVideo());
const word = await page.$$(".row .w");
await word[1].tap();
const card = await until(async () => { const t = await text("#cardBody"); return /假的釋義/.test(t) ? t : null; });
check("D1 點單字跳出字典卡片", !!card, await text("#cardBody"));
check("D2 查單字時影片暫停", (await page.evaluate(() => window.__fake.getPlayerState())) === 2);
await tap("#cardClose");

// 字幕時間：講完就收掉；結束時間標太長也不會一直停著；可以微調
await page.evaluate(() => (window.__fake.pauseVideo(), window.__fake.seekTo(48.2)));
await sleep(400);
check("O1 結束時間標太長的句子，依字數上限收掉（不會停到下一句）", (await text("#subs .box")) === "", await text("#subs .box"));
await tap("#offEarlier");
await tap("#offEarlier");
await sleep(400);
check("O2 字幕提早 1 秒：顯示下一句", /Spoken line 9 /.test(await text("#subs .box")) && /提早 1\.0 秒/.test(await text("#offVal")), `${await text("#subs .box")}｜${await text("#offVal")}`);
await tap("#offLater");
await tap("#offLater");
check("O3 微調可以調回 0", /0\.0 秒/.test(await text("#offVal")));

// 字幕大小
await page.select("#subSize", "l");
const fsL = await page.$eval("#subs .box", (e) => parseFloat(getComputedStyle(e).fontSize));
await page.select("#subSize", "s");
const fsS = await page.$eval("#subs .box", (e) => parseFloat(getComputedStyle(e).fontSize));
check("Z1 字幕大小可以切換（預設小）", fsS < fsL && fsS <= 18, `小 ${fsS}px、大 ${fsL}px`);

// 下載 SRT
await tap("#srt");
const srtFile = await until(() => fs.readdirSync(dl).find((f) => f.endsWith(".srt")));
const srt = srtFile ? fs.readFileSync(path.join(dl, srtFile), "utf8") : "";
check("S1 下載雙語 SRT（檔名用影片標題）", srtFile === "Fake talk about libraries.zh-TW.srt" && /Spoken line 1 of the talk\.\n【譯】Spoken line 1/.test(srt), srtFile);

// 每句長度改成長：從目前位置重新轉錄，送出的提示是 15 字
const nBefore = calls.transcribe.length;
await page.evaluate(() => window.__fake.seekTo(30));
await page.select("#subLen", "long");
await until(() => calls.transcribe.length > nBefore);
await sleep(800);
const again = calls.transcribe.slice(nBefore);
check("Z2 改每句長度：從目前位置重新轉錄（15 字）", again.length >= 1 && again.every((c) => c.words === 15) && again[0].from === 0, JSON.stringify(again));
check("Z3 重新轉錄後逐字稿照樣出現", !!(await until(async () => (await page.$$(".row")).length >= 20)));
await page.select("#subLen", "short");
await sleep(800);

// 版面：直放、橫放都沒有橫向捲動
await page.screenshot({ path: path.join(outDir, "portrait.png") });
const overflowP = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
await page.setViewport({ width: 1280, height: 800, isMobile: true, hasTouch: true });
await sleep(400);
await page.screenshot({ path: path.join(outDir, "landscape.png") });
const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1, sideRight: document.getElementById("side").getBoundingClientRect().left > document.getElementById("stage").getBoundingClientRect().right }));
check("L1 直放、橫放都沒有橫向捲動；橫放時逐字稿在右邊", !overflowP && !layout.overflow && layout.sideRight, JSON.stringify(layout));
await page.setViewport({ width: 800, height: 1280, isMobile: true, hasTouch: true });

// 全螢幕：字幕跟著
await tap("#fs");
const fsOk = await until(() => page.evaluate(() => document.fullscreenElement?.id === "stage" && !!document.querySelector("#stage #subs")), 3000);
check("F1 全螢幕時字幕還在", !!fsOk);
await page.evaluate(() => document.fullscreenElement && document.exitFullscreen());

// 快取：重新整理後同一部影片不再送轉錄
const before = calls.transcribe.length;
await page.reload();
check("R0 重新整理後記得上次的網址", (await page.$eval("#url", (e) => e.value)) === "https://youtu.be/AAAAAAAAAAA");
await tap("#load");
await until(() => page.$eval("#startRow", (e) => getComputedStyle(e).display !== "none"));
await tap("#start");
await page.evaluate(() => (window.__fake.seekTo(2), window.__fake.playVideo()));
await until(async () => /【譯】/.test(await text("#subs .box")));
check("R1 重看同一部影片走快取，不再花錢", calls.transcribe.length === before, `${calls.transcribe.length - before} 次新請求`);

// 單字表（2026-11-27 使用者要「本集 N 個字」的片語／單字表）：接在 R1 後面，影片正在播 0:02 左右
await page.evaluate((u) => { const s = JSON.parse(localStorage.getItem("blyt-settings")); s.flashcardUrl = u; localStorage.setItem("blyt-settings", JSON.stringify(s)); localStorage.removeItem("blyt-vocabSaved"); }, `${BASE}flash.html`);
const vocabView = () =>
  page.evaluate(() => {
    const box = document.getElementById("vocab");
    const br = box.getBoundingClientRect(), sr = document.getElementById("stage").getBoundingClientRect();
    return {
      shown: !box.hidden,
      topRight: br.right <= sr.right && br.left > sr.left + sr.width / 2 && br.top >= sr.top && br.top < sr.top + sr.height / 3,
      ttl: box.querySelector(".ttl").textContent,
      collapsed: box.querySelector(".vp").hidden,
      pill: box.querySelector(".pill").hidden ? "" : box.querySelector(".pill").textContent,
      exp: box.querySelector('[data-act="export"]').textContent,
      items: [...box.querySelectorAll(".it")].map((it) => ({ k: it.dataset.k, t: it.querySelector(".t").textContent, z: it.querySelector(".z").textContent, c: it.querySelector(".c")?.textContent || "", on: it.classList.contains("on"), star: it.querySelector(".st").textContent })),
      subHl: [...document.querySelectorAll("#subs .hl")].map((x) => x.textContent),
      rowHl: document.querySelectorAll(".row .hl").length,
    };
  });
const v1 = await until(async () => { const v = await vocabView(); return v.items.length === 2 && v.subHl.length ? v : null; });
check(
  "V1 單字表：影片右上角列出挑到的字（Level 1 的 talk 濾掉、片語留著、出現幾次標 ×N），字幕和逐字稿上色",
  v1?.shown && v1.topRight && v1.ttl === "本集 2 個字" && v1.items.map((x) => x.t).join(",") === "spoken line,of the talk" && v1.items.some((x) => x.on) && /^×\d+$/.test(v1.items[0].c) && v1.subHl.length >= 1 && v1.rowHl > 0 && calls.vocab.length >= 1,
  JSON.stringify({ v1, vocabCalls: calls.vocab.length }),
);
await page.evaluate(() => window.__fake.pauseVideo());
await page.$eval('#vocab .it[data-k="of the talk"] .st', (e) => e.click());
const saved2 = await page.evaluate(() => JSON.parse(localStorage.getItem("blyt-vocabSaved") || "{}"));
const s2 = saved2["of the talk"];
const e2 = s2?.exs?.[0];
const inbox2 = await page.evaluate(() => JSON.parse(localStorage.getItem("flVideoInbox") || "null"));
check(
  "V2 收藏：存原形、意思、這部影片的那一句（原文＋譯文＋網址秒數）、遇到 1 次；同時寫進英文閃卡的收件匣",
  s2?.w === "of the talk" && s2.zh === "這場演講的" && s2.seen === 1 && e2?.vid === "AAAAAAAAAAA" && /^Spoken line \d+ of the talk\.$/.test(e2.ex) && /^【譯】Spoken line/.test(e2.exTr) &&
    /^https:\/\/www\.youtube\.com\/watch\?v=AAAAAAAAAAA&t=\d+s$/.test(e2.src) && (await vocabView()).exp === "★1 → 閃卡" && inbox2?.v === 1 && inbox2.items[0]?.w === "of the talk",
  JSON.stringify({ s2, inbox2 }),
);
const t3a = await page.evaluate(() => window.__fake.getCurrentTime());
await page.$eval('#vocab .it[data-k="spoken line"]', (e) => e.click());
await sleep(300);
const t3b = await page.evaluate(() => window.__fake.getCurrentTime());
const tab4 = browser.waitForTarget((t) => t.url().includes("/flash.html#import="), { timeout: 5000 }).catch(() => null);
await page.$eval('#vocab [data-act="export"]', (e) => e.click());
const target4 = await tab4;
let got4 = null;
if (target4) {
  got4 = JSON.parse(Buffer.from(target4.url().split("#import=")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  await (await target4.page())?.close();
}
check("V3 點字跳到它下一次出現的那句；「→ 閃卡」打開閃卡網址，# 後面是收藏的字", t3b > t3a + 0.5 && t3b < t3a + 12 && got4?.v === 1 && got4.items[0]?.w === "of the talk", JSON.stringify({ t3a, t3b, got4 }));
await page.$eval('#vocab [data-act="collapse"]', (e) => e.click());
const v4 = await vocabView();
const set4 = await page.evaluate(() => JSON.parse(localStorage.getItem("blyt-settings")).vocabCollapsed);
await page.$eval("#vocab .pill", (e) => e.click());
const v4b = await vocabView();
check("V4 收起單字表：只剩「單字 N」小按鈕、設定記住；點它再打開", v4.collapsed && v4.pill === "單字 2" && set4 === true && !v4b.collapsed, JSON.stringify({ v4: { collapsed: v4.collapsed, pill: v4.pill }, set4 }));
// V5 閃卡進度（同一個網域的 localStorage flState）：已熟悉的字變淡標「熟」、字幕和逐字稿不上色；正在背的標「背」
await page.evaluate(() => {
  localStorage.setItem("flState", JSON.stringify({ v_of_the_talk: { status: "mastered" }, v_spoken_line: { status: "learning" }, _streak: {} }));
  document.dispatchEvent(new Event("visibilitychange"));
});
await sleep(400);
const v5 = await page.evaluate(() => ({
  items: [...document.querySelectorAll("#vocab .it")].map((it) => ({ k: it.dataset.k, known: it.classList.contains("known"), fl: it.querySelector(".fl")?.textContent || "" })),
  subHl: [...document.querySelectorAll("#subs .hl")].map((x) => x.textContent),
  rowHl: [...new Set([...document.querySelectorAll(".row .hl")].map((x) => x.textContent))],
}));
const k5 = (k) => v5.items.find((x) => x.k === k);
check(
  "V5 讀英文閃卡的進度：已熟悉的變淡標「熟」、不上色；正在背的標「背」、照樣上色",
  k5("of the talk")?.known && k5("of the talk").fl === "熟" && !k5("spoken line")?.known && k5("spoken line")?.fl === "背" && !v5.rowHl.includes("of the talk") && v5.rowHl.includes("Spoken line"),
  JSON.stringify(v5),
);
// V6 取消收藏：不刪掉，標記取消（閃卡那邊收到後拿掉還沒背的卡片）；收件匣跟著更新
await page.$eval('#vocab .it[data-k="of the talk"] .st', (e) => e.click());
const v6 = await page.evaluate(() => ({ saved: JSON.parse(localStorage.getItem("blyt-vocabSaved"))["of the talk"], inbox: JSON.parse(localStorage.getItem("flVideoInbox")).items.find((x) => x.w === "of the talk"), exp: document.querySelector('#vocab [data-act="export"]').textContent }));
check("V6 取消收藏：留著 removed 標記、收件匣跟著更新、收藏數變 0", v6.saved?.removed === true && v6.inbox?.removed === true && v6.exp === "★0 → 閃卡", JSON.stringify(v6));
await page.evaluate(() => localStorage.removeItem("flState"));

// 不能嵌入的影片：照順序轉出逐字稿，到沒有語音為止
await loadVideo("https://youtu.be/NOEMBED0001");
await until(() => page.$eval("#startRow", (e) => getComputedStyle(e).display !== "none"));
check("N1 不能嵌入的影片會說明", /不允許在其他網站播放/.test(await text("#status")), await text("#status"));
await tap("#start");
const neFull = () => calls.transcribe.filter((c) => c.vid === "NOEMBED0001" && c.to - c.from >= 59).map((c) => c.from);
await until(() => neFull().length >= 5, 15000);
await sleep(1500);
const ne = neFull();
check("N2 照順序轉，遇到沒有語音的段就停", JSON.stringify(ne) === "[0,60,120,180,240]", JSON.stringify(ne));
check("N3 逐字稿照樣出現", (await page.$$(".row")).length >= 30);

// 私人影片：直接停並說明
await loadVideo("https://youtu.be/PRIVATE0001");
await until(() => page.$eval("#startRow", (e) => getComputedStyle(e).display !== "none"));
await tap("#start");
const priv = await until(async () => { const t = await text("#status"); return /讀不到這部影片/.test(t) ? t : null; });
await sleep(2500);
const privN = calls.transcribe.filter((c) => c.vid === "PRIVATE0001").length;
check("P1 私人影片：停止並說明，不再重試", !!priv && privN <= 2, `${privN} 次請求：${await text("#status")}`);

check("E1 沒有 JavaScript 錯誤", errors.length === 0, errors.join(" | "));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
