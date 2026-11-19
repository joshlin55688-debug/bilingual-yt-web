// 雙語 YT 網頁版的引擎：設定、快取、Gemini 呼叫（限流、重試、思考模式切換）、轉錄、翻譯、查字典、用量。
// 邏輯照 bilingual-translate 的 sw.js，差別只在設定與用量存在這個網頁的 localStorage（只在這台裝置、這個瀏覽器）。
// 純邏輯在 lib/core.js（從 bilingual-translate 複製，tools/sync-core.mjs 更新）。
(function (g) {
  const BL = g.BL;
  const API = globalThis.BLYT_API_BASE || "https://generativelanguage.googleapis.com"; // 測試時換成本機假伺服器
  const DEFAULTS = {
    apiKey: "",
    model: "gemini-3.5-flash-lite",
    targetLang: "zh-TW",
    videoLang: "en-US",
    glossary: "",
    instructions: "",
    subStyle: "dual", // dual：原文＋譯文；translation：只顯示譯文；blur：譯文模糊
    autoPause: false,
    subSize: "s", // 字幕大小：s／m／l
    subOffset: 0, // 字幕時間微調（秒）：正數＝提早
    subLen: "short", // 字幕長度：short（每句約 8 字，換得快）／medium（12）／long（15，和插件一樣）
    customPrices: {},
  };
  const BATCH = { maxItems: 12, maxChars: 2400 };
  const SUB_LEN_WORDS = { short: 8, medium: 12, long: 15 };
  const CONCURRENCY = 4, MIN_GAP_MS = 100, MAX_ATTEMPTS = 4, REQUEST_TIMEOUT_MS = 60000;
  const CACHE_TTL_MS = 60 * 24 * 3600 * 1000, CACHE_MAX = 50000;
  const LS = "blyt-settings", LS_USAGE = "blyt-usage";

  const safeGet = (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  };
  const safeSet = (k, v) => {
    try {
      localStorage.setItem(k, v);
      return true;
    } catch {
      return false;
    }
  };
  function getSettings() {
    let saved = {};
    try {
      saved = JSON.parse(safeGet(LS) || "{}") || {};
    } catch {}
    const s = { ...DEFAULTS, ...saved };
    s.glossaryList = BL.parseGlossary(s.glossary);
    s.instructions = String(s.instructions || "").trim().slice(0, 1000);
    return s;
  }
  function saveSettings(patch) {
    const { glossaryList, ...cur } = getSettings();
    void glossaryList;
    return safeSet(LS, JSON.stringify({ ...cur, ...patch }));
  }

  // ---------- 快取：這個網頁自己的 IndexedDB ----------
  let dbPromise;
  function db() {
    return (dbPromise ||= new Promise((resolve, reject) => {
      const req = indexedDB.open("blyt-cache", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("tr", { keyPath: "k" }).createIndex("t", "t");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }
  const tx = async (mode, fn) => {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction("tr", mode);
      const out = fn(t.objectStore("tr"));
      t.oncomplete = () => resolve(out?.result ?? out);
      t.onerror = () => reject(t.error);
    });
  };
  async function hash(str) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const cacheKey = (s, text) => hash(`${BL.PROMPT_VERSION}|${s.model}|${s.targetLang}|${text}|${BL.cacheSalt(text, s.glossaryList, s.instructions)}`);
  async function cacheGet(keys) {
    const now = Date.now();
    const rows = await tx("readonly", (st) => keys.map((k) => st.get(k)));
    return rows.map((r) => (r.result && now - r.result.t < CACHE_TTL_MS ? r.result.v : null));
  }
  const cachePut = (entries) => tx("readwrite", (st) => entries.forEach(([k, v]) => st.put({ k, v, t: Date.now() })));
  async function cachePrune() {
    const count = await tx("readonly", (st) => st.count());
    if (count <= CACHE_MAX) return;
    let extra = count - CACHE_MAX;
    await tx("readwrite", (st) => {
      st.index("t").openCursor().onsuccess = (e) => {
        const c = e.target.result;
        if (c && extra-- > 0) c.delete(), c.continue();
      };
    });
  }
  const cacheClear = () => tx("readwrite", (st) => st.clear());

  // ---------- 請求排程：併發上限＋最小間隔 ----------
  let running = 0, lastStart = 0;
  const waiting = [];
  const slot = () => new Promise((resolve) => (waiting.push(resolve), pump()));
  function pump() {
    if (running >= CONCURRENCY || !waiting.length) return;
    const wait = lastStart + MIN_GAP_MS - Date.now();
    if (wait > 0) return void setTimeout(pump, wait);
    running++;
    lastStart = Date.now();
    waiting.shift()();
    pump();
  }
  const release = () => (running--, pump());
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  class ApiError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }
  const thinkingMode = new Map();
  const defaultThinking = (model) => (/lite/i.test(model) ? "omit" : "off");
  async function callGemini(s, makeBody) {
    if (!s.apiKey) throw new ApiError("no-key", "還沒有填 Gemini API 金鑰（右上角「設定」）");
    const url = `${API}/v1beta/models/${encodeURIComponent(s.model)}:generateContent`;
    for (let attempt = 0; ; attempt++) {
      const mode = thinkingMode.get(s.model) || defaultThinking(s.model);
      await slot();
      let status = 0, body = null;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": s.apiKey },
          body: JSON.stringify(makeBody(mode)),
          signal: ctrl.signal,
        });
        status = res.status;
        body = await res.json().catch(() => null);
      } catch (e) {
        body = { error: { message: e.name === "AbortError" ? `請求超過 ${REQUEST_TIMEOUT_MS / 1000} 秒沒有回應` : `連不上 Gemini（${e.message || e}）` } };
      } finally {
        clearTimeout(timer);
        release();
      }
      if (status === 200) {
        recordUsage(s, body?.usageMetadata || {});
        return body;
      }
      const msg = body?.error?.message || `HTTP ${status}`;
      if (status === 400 && /thinking/i.test(msg) && !thinkingMode.has(s.model)) {
        thinkingMode.set(s.model, mode === "off" ? "omit" : "off");
        continue;
      }
      if (BL.isRetryable(status) && attempt + 1 < MAX_ATTEMPTS) {
        await sleep(BL.retryDelayMs(status, body, attempt));
        continue;
      }
      throw new ApiError(status, msg);
    }
  }

  // ---------- 用量 ----------
  function readUsage() {
    try {
      return JSON.parse(safeGet(LS_USAGE) || "null");
    } catch {
      return null;
    }
  }
  function recordUsage(s, meta) {
    const when = new Date();
    const price = BL.priceFor(s.model, BL.localDay(when), s.customPrices);
    safeSet(LS_USAGE, JSON.stringify(BL.addUsage(readUsage(), s.model, when, meta, price)));
  }
  function usageReport() {
    const now = new Date();
    return { ...BL.summarizeUsage(readUsage(), BL.localMonth(now)), monthLabel: BL.localMonth(now) };
  }
  const resetUsage = () => safeSet(LS_USAGE, "null");

  // ---------- 轉錄一段（from–to 秒）----------
  async function transcribeWindow(videoId, from, to, lang) {
    if (!/^[\w-]{11}$/.test(videoId) || !(from >= 0) || !(to > from) || to - from > 600) return { error: "轉錄參數不對" };
    const s = getSettings();
    if (!s.apiKey) return { error: "還沒有填 Gemini API 金鑰（右上角「設定」）", code: "no-key" };
    const maxWords = SUB_LEN_WORDS[s.subLen] || SUB_LEN_WORDS.short;
    const k = `tt|${BL.TRANSCRIBE_VERSION}|${BL.TRANSCRIBE_MODEL}|${videoId}|${lang}|${from}|${to}|${maxWords}`;
    const [hit] = await cacheGet([k]).catch(() => [null]);
    if (hit) return { cues: hit, cached: true };
    const ts = { ...s, model: BL.TRANSCRIBE_MODEL };
    let last = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const body = await callGemini(ts, (mode) => BL.transcribeBody(videoId, from, to, lang, { thinking: mode, maxWords }));
        const r = BL.parseTranscript(body, from, to);
        if (r.ok) {
          await cachePut([[k, r.cues]]).catch(() => {});
          return { cues: r.cues };
        }
        last = r.error;
      } catch (e) {
        return { error: e.message || String(e), code: e.code };
      }
    }
    return { error: last };
  }

  // ---------- 翻譯（和插件同一套：段數不符拆半、佔位符修復、繁體用字修正）----------
  async function translateGroup(s, texts, context = null, scriptFix = null) {
    const opts = { context, glossary: s.glossaryList, instructions: s.instructions, scriptFix };
    const body = await callGemini(s, (mode) => BL.geminiBody(texts, s.targetLang, { ...opts, thinking: mode }));
    const parsed = BL.parseGemini(body, texts.length);
    if (parsed.ok) return parsed.texts;
    if (texts.length === 1) throw new ApiError("parse", `${parsed.error} ${parsed.detail || ""}`.trim());
    const mid = Math.ceil(texts.length / 2);
    return [...(await translateGroup(s, texts.slice(0, mid), context)), ...(await translateGroup(s, texts.slice(mid), context))];
  }
  // 模型偶爾把原文照抄回來（整批都沒翻）。翻成中日韓時：原文有英文字、譯文卻一個中日韓字都沒有；其他語言：和原文一模一樣
  const CJK_TARGET = /^(zh|ja|ko)/;
  const CJK_CHAR = /[぀-ヿ㐀-鿿가-힯豈-﫿]/;
  const norm = (t) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase();
  function untranslated(lang, src, out) {
    if (CJK_TARGET.test(lang)) return (String(src).match(/[A-Za-z]/g) || []).length >= 3 && !CJK_CHAR.test(src) && !CJK_CHAR.test(out || "");
    return norm(src).split(" ").length >= 3 && norm(src) === norm(out);
  }
  async function withRepair(s, srcs, outs, context) {
    const wrongScript = (src, out) => s.targetLang === "zh-TW" && BL.hasSimplified(out) && !BL.hasSimplified(src);
    const mapScript = (src, out) => (wrongScript(src, out) && BL.zhScript(out) === "hant" ? BL.toTraditional(out) : out);
    const good = (src, out) => BL.checkTranslation(src, out).ok && !wrongScript(src, out) && !untranslated(s.targetLang, src, out);
    return Promise.all(
      outs.map(async (out, i) => {
        out = mapScript(srcs[i], out);
        if (good(srcs[i], out)) return BL.finalize(srcs[i], out).text;
        const fix = wrongScript(srcs[i], out) ? BL.simplifiedChars(out).slice(0, 12).join(" ") : null;
        try {
          const [again] = await translateGroup(s, [srcs[i]], context, fix);
          out = mapScript(srcs[i], again);
        } catch {}
        // 單句重翻還是原文：當成失敗（不存快取，之後會再試）
        if (untranslated(s.targetLang, srcs[i], out)) return null;
        return BL.finalize(srcs[i], out).text;
      }),
    );
  }
  // texts → [{text} | {error}]；送出前遮蔽 email、網址等，回來再換回
  async function translateTexts(texts, context = null) {
    const s = getSettings();
    if (!s.apiKey) return texts.map(() => ({ error: "還沒有填 Gemini API 金鑰" }));
    const masks = texts.map((t) => BL.mask(t));
    const send = masks.map((m) => m.text);
    const keys = await Promise.all(send.map((t) => cacheKey(s, t)));
    const cached = await cacheGet(keys).catch(() => send.map(() => null));
    const unmask = (i, out) =>
      BL.splitTokens(out)
        .map((p) => (/^@\d+#$/.test(p) ? masks[i].masked[p.slice(1, -1)] ?? "" : p))
        .join("");
    // 舊版存進快取的「照抄原文」不算數，重翻
    const results = send.map((t, i) => (cached[i] != null && !untranslated(s.targetLang, t, cached[i]) ? { text: unmask(i, cached[i]), cached: true } : null));
    const misses = send.map((text, i) => ({ text, i })).filter((x) => !results[x.i]);
    await Promise.all(
      BL.group(misses, BATCH).map(async (grp) => {
        const srcs = grp.map((x) => x.text);
        try {
          const outs = await withRepair(s, srcs, await translateGroup(s, srcs, context), context);
          grp.forEach((x, k) => (results[x.i] = outs[k] == null ? { error: "模型沒有翻譯（回傳原文）", retry: true } : { text: unmask(x.i, outs[k]) }));
          const keep = (k) => outs[k] != null && !(s.targetLang === "zh-TW" && BL.hasSimplified(outs[k]) && !BL.hasSimplified(srcs[k]));
          await cachePut(grp.flatMap((x, k) => (keep(k) ? [[keys[x.i], outs[k]]] : []))).catch(() => {});
        } catch (e) {
          grp.forEach((x) => (results[x.i] = { error: e.message || String(e) }));
        }
      }),
    );
    return results;
  }

  // ---------- 查單字 ----------
  async function lookupWord(word) {
    const s = getSettings();
    if (!s.apiKey) return { error: "還沒有填 Gemini API 金鑰" };
    const key = await cacheKey(s, `${BL.LOOKUP_VERSION}|word|${word}`);
    const [hit] = await cacheGet([key]).catch(() => [null]);
    if (hit != null) return { ...JSON.parse(hit), cached: true };
    try {
      const body = await callGemini(s, (mode) => BL.lookupBody("word", word, s.targetLang, { thinking: mode }));
      const w = BL.parseWord(body);
      if (!w.ok) return { error: "字典回應格式不對" };
      const result = { word: w.word, phonetic: w.phonetic, entries: w.entries };
      await cachePut([[key, JSON.stringify(result)]]).catch(() => {});
      return result;
    } catch (e) {
      return { error: e.message || String(e) };
    }
  }

  // 測試連線：一句固定的英文
  async function testConnection() {
    try {
      const s = getSettings();
      const [t] = await translateGroup(s, ["The quiet library opens early on weekdays."]);
      return { ok: true, text: t };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }

  g.BLYT = { DEFAULTS, SUB_LEN_WORDS,getSettings, saveSettings, transcribeWindow, translateTexts, lookupWord, testConnection, usageReport, resetUsage, cacheClear, cachePrune };
})(globalThis);
