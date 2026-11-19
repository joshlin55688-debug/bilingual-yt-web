// 雙語 YT 網頁版：YouTube 官方內嵌播放器＋Gemini 轉錄＋翻譯＋雙語字幕＋逐字稿。
// 轉錄做法照 bilingual-translate 的 yt-transcribe.js：目前那段＋下一段、段落交界的半句接回一句。
// 和插件不同：每段 60 秒（插件 120 秒），而且轉完會補漏。實測（Karpathy 的演講，講得很密）2 分鐘一段時，
// Gemini 會整段跳過 40 秒左右的話，那段時間就沒有字幕。
(() => {
  const BL = globalThis.BL, E = globalThis.BLYT;
  const $ = (id) => document.getElementById(id);
  const W = 60;
  const MAX_INFLIGHT = 2, RETRY_MS = 20000, MAX_TRIES = 3;
  const GAP_S = 5, MAX_GAPS = 4; // 一段裡超過 5 秒沒有句子就補轉那個空檔（每段最多補 4 個）
  const NOPLAYER_MAX_WINDOWS = 60; // 不能嵌入播放的影片：照順序轉，最多 1 小時
  const YT_API = globalThis.BLYT_YT_API || "https://www.youtube.com/iframe_api";
  const LS_LAST = "blyt-last";

  // ---------- 狀態 ----------
  let player = null, playerReady = false, noPlayer = false;
  let V = null; // 目前影片：{vid, lang, title, dur, wins: Map, inflight, cues: [{start,end,text,w,tr,trErr}], started}
  let curIdx = -1, pausedFor = -1, userScrollAt = 0;

  // ---------- 小工具 ----------
  const clock = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  function setStatus(text, err = false) {
    $("status").textContent = text || "";
    $("status").classList.toggle("err", !!err);
  }
  const lsGet = (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  };
  const lsSet = (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  };
  // 網址 → 影片 ID：watch?v=、youtu.be/、shorts/、embed/、live/，或直接貼 11 碼 ID
  function videoIdOf(input) {
    const s = String(input || "").trim();
    if (/^[\w-]{11}$/.test(s)) return s;
    let u;
    try {
      u = new URL(/^https?:\/\//i.test(s) ? s : "https://" + s);
    } catch {
      return null;
    }
    const host = u.hostname.replace(/^(www|m|music)\./, "");
    if (host === "youtu.be") return /^\/([\w-]{11})/.exec(u.pathname)?.[1] || null;
    if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;
    const v = u.searchParams.get("v");
    if (v && /^[\w-]{11}$/.test(v)) return v;
    return /^\/(?:shorts|embed|live|v)\/([\w-]{11})/.exec(u.pathname)?.[1] || null;
  }
  globalThis.BLYT_videoIdOf = videoIdOf;
  const nowMs = () => (playerReady && player?.getCurrentTime ? player.getCurrentTime() * 1000 : 0);

  // ---------- YouTube 播放器 ----------
  let apiPromise;
  function loadApi() {
    return (apiPromise ||= new Promise((resolve, reject) => {
      if (globalThis.YT?.Player) return resolve();
      globalThis.onYouTubeIframeAPIReady = () => resolve();
      const s = document.createElement("script");
      s.src = YT_API;
      s.onerror = () => reject(new Error("載入 YouTube 播放器失敗（網路？）"));
      document.head.append(s);
    }));
  }
  async function load() {
    const vid = videoIdOf($("url").value);
    if (!vid) return setStatus("看不懂這個網址：請貼 YouTube 影片網址（例如 https://youtu.be/xxxxxxxxxxx）", true);
    stopAll();
    lsSet(LS_LAST, JSON.stringify({ url: $("url").value.trim(), lang: $("videoLang").value }));
    V = { vid, lang: $("videoLang").value, title: "", dur: 0, wins: new Map(), inflight: 0, cues: [], started: false };
    noPlayer = false;
    playerReady = false;
    $("empty").style.display = "none";
    renderList();
    setStatus("載入播放器…");
    try {
      await loadApi();
    } catch (e) {
      return setStatus(e.message, true);
    }
    if (player) {
      try {
        player.destroy();
      } catch {}
      player = null;
    }
    const holder = document.createElement("div");
    holder.id = "yt";
    $("yt").replaceWith(holder);
    player = new YT.Player("yt", {
      videoId: vid,
      playerVars: { playsinline: 1, rel: 0, cc_load_policy: 0, iv_load_policy: 3, fs: 0 },
      events: {
        onReady: () => {
          if (!V || V.vid !== vid) return;
          playerReady = true;
          V.dur = player.getDuration?.() || 0;
          V.title = player.getVideoData?.()?.title || "";
          showEstimate();
        },
        onError: (e) => {
          if (!V || V.vid !== vid) return;
          // 101／150：上傳者不允許嵌入；100：找不到或私人；2：ID 不對；5：播放器錯誤
          if (e.data === 101 || e.data === 150) {
            noPlayer = true;
            showEstimate();
            setStatus("上傳者不允許在其他網站播放這部影片。還是可以產生逐字稿來看（點一句會到 YouTube 開啟那個位置）。", true);
          } else if (e.data === 100) setStatus("找不到這部影片，或是私人影片。", true);
          else setStatus(`播放器錯誤（代碼 ${e.data}）`, true);
        },
        onStateChange: () => schedule(),
      },
    });
  }
  function showEstimate() {
    const day = BL.localDay(new Date());
    const price = BL.priceFor(BL.TRANSCRIBE_MODEL, day, E.getSettings().customPrices);
    const secs = V.dur || 600;
    const est = BL.transcribeEstimate(secs, price);
    const usd = est.usd != null ? `約 US$${est.usd.toFixed(3)}` : "（不知道單價）";
    $("estimate").textContent = V.dur
      ? `整部 ${clock(V.dur * 1000)}，全部轉錄${usd}，另加翻譯費。只會轉你看到的地方，轉過的重看不再花錢。`
      : `影片長度未知；每 10 分鐘轉錄${usd}，另加翻譯費。`;
    $("startRow").style.display = "flex";
    if (!noPlayer) setStatus(V.title ? `「${V.title}」已載入` : "已載入");
  }
  function startSubs() {
    if (!V) return;
    if (!E.getSettings().apiKey) {
      setStatus("請先到「設定」填 Gemini API 金鑰", true);
      return openSettings();
    }
    V.started = true;
    $("startRow").style.display = "none";
    setStatus("Gemini 轉錄中…（每段約 5–10 秒）");
    schedule();
  }
  function stopAll() {
    if (V) V.started = false;
    V = null;
    curIdx = -1;
    pausedFor = -1;
    $("startRow").style.display = "none";
    showSub(null);
  }

  // ---------- 轉錄排程 ----------
  const winCount = () => (V.dur ? Math.max(1, Math.ceil(V.dur / W)) : NOPLAYER_MAX_WINDOWS);
  const win = (i) => {
    let w = V.wins.get(i);
    if (!w) V.wins.set(i, (w = { st: 0, tries: 0, retryAt: 0, err: "", n: 0 }));
    return w;
  };
  function schedule() {
    if (!V?.started) return;
    let wanted;
    if (noPlayer) {
      // 沒有播放器：照順序轉，遇到空的一段就當作影片結束
      const firstUndone = [...Array(winCount()).keys()].find((i) => win(i).st !== 2);
      if (firstUndone == null || [...V.wins.values()].some((w) => w.st === 2 && w.n === 0)) return progress();
      wanted = [firstUndone];
    } else {
      if (!V.dur) V.dur = player?.getDuration?.() || 0;
      const here = Math.min(winCount() - 1, Math.floor(nowMs() / 1000 / W));
      wanted = [here, here + 1];
    }
    for (const i of wanted) {
      if (i >= winCount() || V.inflight >= MAX_INFLIGHT) continue;
      const w = win(i);
      if (w.st === 0 || (w.st === 3 && w.tries < MAX_TRIES && Date.now() >= w.retryAt)) request(i, w);
    }
    progress();
  }
  async function request(i, w) {
    const v = V, gen = v.gen;
    v.inflight++;
    w.st = 1;
    w.tries++;
    progress();
    const from = i * W;
    const to = v.dur ? Math.min(Math.ceil(v.dur), (i + 1) * W) : (i + 1) * W;
    const r = await E.transcribeWindow(v.vid, from, to, v.lang);
    if (v !== V || v.gen !== gen) return; // 換了影片，或改了每句長度（舊長度的結果不要）
    v.inflight--;
    if (r.cues) {
      w.st = 2;
      w.n = insert(i, r.cues);
      translatePending();
      if (r.cues.length) fillGaps(v, gen, i, from, to, r.cues);
    } else {
      w.st = 3;
      w.err = r.error || "沒有回應";
      w.retryAt = Date.now() + RETRY_MS;
      const rejected = typeof r.code === "number" && r.code >= 400 && r.code < 500 && r.code !== 429;
      if (r.code === "no-key" || (rejected && ![...v.wins.values()].some((x) => x.st === 2))) {
        v.started = false;
        setStatus(`Gemini 讀不到這部影片或請求被拒：${w.err}（私人、不公開的影片不能用）`, true);
        return;
      }
    }
    progress();
    schedule();
  }
  // 補漏：這段裡超過 GAP_S 秒沒有句子的地方，單獨再轉一次（前後各多 0.5 秒）。
  // 沒人講話的空檔（音樂、停頓）也會送一次，回來是空的，費用很少。補到的句子併進同一段
  async function fillGaps(v, gen, i, from, to, cues) {
    const gaps = [];
    let prev = from;
    for (const c of [...cues].sort((a, b) => a.start - b.start)) {
      if (c.start / 1000 - prev > GAP_S) gaps.push([prev, c.start / 1000]);
      prev = Math.max(prev, c.end / 1000);
    }
    if (to - prev > GAP_S) gaps.push([prev, to]);
    for (const [a, b] of gaps.slice(0, MAX_GAPS)) {
      const f = Math.max(from, Math.floor(a * 10) / 10 - 0.5), t = Math.min(to, Math.ceil(b * 10) / 10 + 0.5);
      if (t - f < 2) continue;
      v.gapBusy = (v.gapBusy || 0) + 1;
      progress();
      const r = await E.transcribeWindow(v.vid, f, t, v.lang);
      if (v !== V || v.gen !== gen) return;
      v.gapBusy--;
      if (r.cues?.length) {
        win(i).n += insert(i, r.cues);
        v.gapFilled = (v.gapFilled || 0) + r.cues.length;
        translatePending();
      }
    }
    progress();
  }
  // 段落交界：重疊超過一半的丟掉、保持照時間排；切在交界的半句兩段都到了就接回一句（接起來的重新翻譯）。
  // 同一段可以分好幾次併進來（補漏）
  function insert(i, cues) {
    const all = V.cues;
    const before = all.filter((c) => c.w < i), after = all.filter((c) => c.w > i), same = all.filter((c) => c.w === i);
    const minStart = before.length ? before[before.length - 1].start : -Infinity;
    const maxStart = after.length ? after[0].start : Infinity;
    const keep = cues
      .filter((c) => {
        if (c.start <= minStart || c.start >= maxStart) return false;
        const dur = Math.max(1, c.end - c.start);
        return !all.some((u) => Math.min(u.end, c.end) - Math.max(u.start, c.start) > dur / 2);
      })
      .map((c) => ({ ...c, w: i }));
    V.cues = [...before, ...[...same, ...keep].sort((a, b) => a.start - b.start), ...after];
    joinAt(i);
    joinAt(i + 1);
    renderList();
    return keep.length;
  }
  function joinAt(b) {
    const c = V.cues;
    const li = c.findLastIndex((x) => x.w === b - 1);
    const fi = c.findIndex((x) => x.w === b);
    if (li < 0 || fi !== li + 1 || !BL.ttShouldJoin(c[li], c[fi])) return;
    c.splice(li, 2, { start: c[li].start, end: Math.max(c[li].end, c[fi].end), text: BL.asrJoin(c[li].text, c[fi].text), w: b - 1 });
  }
  function progress() {
    if (!V?.started) return;
    const n = winCount();
    const done = [...V.wins.entries()].filter(([, w]) => w.st === 2).map(([i]) => i).sort((a, b) => a - b);
    const ranges = [];
    for (const i of done) {
      const last = ranges[ranges.length - 1];
      if (last && last.hi === i) last.hi = i + 1;
      else ranges.push({ lo: i, hi: i + 1 });
    }
    const end = (i) => (V.dur ? Math.min(V.dur, (i + 1) * W) : (i + 1) * W) * 1000;
    const txt = ranges.map((r) => `${clock(r.lo * W * 1000)}–${clock(end(r.hi - 1))}`).join("、");
    const busy = [...V.wins.values()].some((w) => w.st === 1) || V.gapBusy > 0;
    const here = noPlayer ? null : V.wins.get(Math.floor(nowMs() / 1000 / W));
    const failed = here?.st === 3 ? `這段轉錄失敗：${here.err}${here.tries < MAX_TRIES ? "（稍後重試）" : ""}` : "";
    const all = !noPlayer && V.dur && done.length >= n;
    setStatus(
      failed ||
        (all ? `已全部轉好（${V.cues.length} 句）` : [txt ? `已轉好 ${txt}（${V.cues.length} 句）` : "", busy ? "Gemini 轉錄中…" : "", noPlayer ? "" : "跟著播放往後轉"].filter(Boolean).join(" · ")),
      !!failed,
    );
  }

  // ---------- 翻譯 ----------
  let translating = false;
  async function translatePending() {
    if (translating || !V) return;
    translating = true;
    const v = V;
    try {
      for (;;) {
        // 目前位置附近優先
        const t = nowMs();
        const todo = v.cues.filter((c) => c.tr == null && !c.trBusy && !(c.trErr >= 2)).sort((a, b) => Math.abs(a.start - t) - Math.abs(b.start - t)).slice(0, 20);
        if (!todo.length || v !== V) break;
        todo.forEach((c) => (c.trBusy = true));
        const res = await E.translateTexts(todo.map((c) => c.text), v.title ? { title: v.title, description: "" } : null);
        todo.forEach((c, i) => {
          c.trBusy = false;
          if (res[i]?.text != null) c.tr = res[i].text;
          else (c.trErr = (c.trErr || 0) + 1), (c.trMsg = res[i]?.error || "");
        });
        if (v !== V) break;
        renderList();
        const err = res.find((r) => r?.error);
        if (err) setStatus(`翻譯失敗：${err.error}`, true);
      }
    } finally {
      translating = false;
    }
  }

  // ---------- 字幕疊層 ----------
  const subStyle = () => E.getSettings().subStyle;
  function showSub(c) {
    const box = $("subs").firstElementChild;
    const key = c ? `${c.start}|${c.text}|${c.tr ?? ""}|${subStyle()}` : "";
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.replaceChildren();
    $("subs").classList.toggle("blur", subStyle() === "blur");
    if (!c) return;
    if (subStyle() !== "translation") box.append(Object.assign(document.createElement("div"), { className: "o", textContent: c.text }));
    if (c.tr) box.append(Object.assign(document.createElement("div"), { className: "tr", textContent: c.tr }));
    else if (subStyle() === "translation") box.append(Object.assign(document.createElement("div"), { className: "o", textContent: c.text }));
  }
  // 一句顯示到什麼時候：Gemini 標的結束時間、下一句開始（一定讓位）、依字數估的上限（結束時間標太長時，
  // 舊字幕會一直停著）三者取最早。上限：英文每個字 0.6 秒、中日韓每個字 0.3 秒，再加 1 秒
  function shownEnd(i) {
    const cs = V.cues, c = cs[i];
    const latin = (c.text.match(/[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]+/gu) || []).length;
    const cjk = (c.text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
    const cap = c.start + 1000 + latin * 600 + cjk * 300;
    return Math.min(c.end, cs[i + 1]?.start ?? Infinity, cap);
  }
  // 目前時間對到哪一句（只在這句的顯示時間內）
  function cueAt(t) {
    const cs = V?.cues || [];
    let lo = 0, hi = cs.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cs[mid].start <= t) (idx = mid), (lo = mid + 1);
      else hi = mid - 1;
    }
    return idx >= 0 && t < shownEnd(idx) ? idx : -1;
  }
  // 字幕時間微調：正數＝字幕提早（字幕比講話慢的時候用）
  const offsetMs = () => Math.round((Number(E.getSettings().subOffset) || 0) * 1000);
  function tick() {
    if (!V || !playerReady) return;
    const t = nowMs() + offsetMs();
    const i = cueAt(t);
    const c = i >= 0 ? V.cues[i] : null;
    showSub(c);
    if (i !== curIdx) {
      curIdx = i;
      highlight();
    }
    // 句尾暫停：播過這句的結尾就停一次
    if (E.getSettings().autoPause && c && t >= shownEnd(i) - 230 && pausedFor !== i && player.getPlayerState?.() === 1) {
      pausedFor = i;
      player.pauseVideo();
    }
  }
  setInterval(tick, 150);
  setInterval(() => V?.started && !noPlayer && schedule(), 1000);

  // ---------- 逐字稿 ----------
  function words(text) {
    const frag = document.createDocumentFragment();
    for (const part of String(text).split(/([\p{L}][\p{L}'’-]*)/u)) {
      if (!part) continue;
      if (/^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}][\p{L}'’-]*$/u.test(part)) {
        const s = document.createElement("span");
        s.className = "w";
        s.textContent = part;
        frag.append(s);
      } else frag.append(part);
    }
    return frag;
  }
  function renderList() {
    const list = $("list");
    const top = list.scrollTop;
    list.replaceChildren();
    for (const [i, c] of (V?.cues || []).entries()) {
      const row = document.createElement("div");
      row.className = "row" + (i === curIdx ? " cur" : "");
      row.dataset.i = i;
      const tm = document.createElement("time");
      tm.textContent = clock(c.start);
      const body = document.createElement("div");
      const o = document.createElement("div");
      o.className = "o";
      o.append(words(c.text));
      const t = document.createElement("div");
      t.className = "t";
      t.textContent = c.tr ?? (c.trErr >= 2 ? `（翻譯失敗：${c.trMsg || ""}）` : "…");
      body.append(o, t);
      row.append(tm, body);
      list.append(row);
    }
    list.scrollTop = top;
    $("sideHead").textContent = V?.cues.length ? `逐字稿（${V.cues.length} 句）：點一句跳過去，點單字查字典` : "逐字稿：點一句跳過去，點單字查字典";
  }
  function highlight() {
    const list = $("list");
    list.querySelector(".row.cur")?.classList.remove("cur");
    const row = list.querySelector(`.row[data-i="${curIdx}"]`);
    if (!row) return;
    row.classList.add("cur");
    if (Date.now() - userScrollAt > 3000) {
      const lr = list.getBoundingClientRect(), rr = row.getBoundingClientRect();
      if (rr.top < lr.top || rr.bottom > lr.bottom) list.scrollTop += rr.top - lr.top - lr.height / 3;
    }
  }
  $("list").addEventListener("scroll", () => (userScrollAt = Date.now()), { passive: true });
  $("list").addEventListener("touchmove", () => (userScrollAt = Date.now()), { passive: true });
  $("list").addEventListener("click", (e) => {
    const w = e.target.closest(".w");
    if (w) return lookup(w);
    const row = e.target.closest(".row");
    if (!row || !V) return;
    const c = V.cues[Number(row.dataset.i)];
    if (noPlayer) return void open(`https://www.youtube.com/watch?v=${V.vid}&t=${Math.floor(c.start / 1000)}s`, "_blank", "noopener");
    seek(c.start);
  });
  function seek(ms) {
    if (!playerReady) return;
    pausedFor = -1;
    player.seekTo(Math.max(0, ms / 1000), true);
    if (player.getPlayerState?.() !== 1) player.playVideo();
    setTimeout(schedule, 50);
  }

  // ---------- 查字典 ----------
  async function lookup(el) {
    document.querySelectorAll(".w.sel").forEach((x) => x.classList.remove("sel"));
    el.classList.add("sel");
    if (playerReady && player.getPlayerState?.() === 1) player.pauseVideo();
    const word = el.textContent;
    const card = $("card"), body = $("cardBody");
    card.style.display = "block";
    body.textContent = `查「${word}」…`;
    const r = await E.lookupWord(word);
    if (!el.classList.contains("sel")) return;
    body.replaceChildren();
    if (r.error) return void (body.textContent = `查不到：${r.error}`);
    const head = document.createElement("div");
    head.append(Object.assign(document.createElement("span"), { className: "word", textContent: r.word }), Object.assign(document.createElement("span"), { className: "ph", textContent: r.phonetic || "" }));
    body.append(head);
    for (const en of r.entries) {
      body.append(Object.assign(document.createElement("span"), { className: "pos", textContent: en.pos }));
      body.append(Object.assign(document.createElement("div"), { textContent: en.defs.join("；") }));
    }
  }
  $("cardClose").addEventListener("click", () => {
    $("card").style.display = "none";
    document.querySelectorAll(".w.sel").forEach((x) => x.classList.remove("sel"));
  });

  // ---------- 控制列 ----------
  const neighbor = (d) => {
    if (!V?.cues.length) return null;
    const t = nowMs();
    const i = cueAt(t);
    if (d === 0) return V.cues[i >= 0 ? i : Math.max(0, V.cues.findIndex((c) => c.start > t) - 1)] || null;
    if (d < 0) return V.cues[i > 0 ? i - 1 : Math.max(0, V.cues.findLastIndex((c) => c.start < t - 300) - (i === 0 ? 1 : 0))] || V.cues[0];
    return V.cues.find((c) => c.start > t + 50) || null;
  };
  $("prev").addEventListener("click", () => neighbor(-1) && seek(neighbor(-1).start));
  $("replay").addEventListener("click", () => neighbor(0) && seek(neighbor(0).start));
  $("next").addEventListener("click", () => neighbor(1) && seek(neighbor(1).start));
  function syncToggles() {
    const s = E.getSettings();
    $("autoPause").classList.toggle("on", !!s.autoPause);
    $("autoPause").setAttribute("aria-pressed", String(!!s.autoPause));
    $("subStyle").value = s.subStyle;
    $("subSize").value = s.subSize;
    $("subLen").value = s.subLen;
    $("subs").dataset.size = s.subSize;
    const off = Number(s.subOffset) || 0;
    $("offVal").textContent = off === 0 ? "0.0 秒" : off > 0 ? `提早 ${off.toFixed(1)} 秒` : `延後 ${(-off).toFixed(1)} 秒`;
  }
  $("autoPause").addEventListener("click", () => (E.saveSettings({ autoPause: !E.getSettings().autoPause }), syncToggles()));
  $("subStyle").addEventListener("change", () => (E.saveSettings({ subStyle: $("subStyle").value }), showSub(null), tick()));
  const nudge = (d) => {
    const cur = Number(E.getSettings().subOffset) || 0;
    E.saveSettings({ subOffset: Math.max(-5, Math.min(5, Math.round((cur + d) * 10) / 10)) });
    syncToggles();
    tick();
  };
  $("offEarlier").addEventListener("click", () => nudge(0.5));
  $("offLater").addEventListener("click", () => nudge(-0.5));
  $("subSize").addEventListener("change", () => (E.saveSettings({ subSize: $("subSize").value }), syncToggles()));
  // 每句長度改了：從目前位置重新轉錄（已經轉好的長句子丟掉；之前轉過的長度還在快取裡，改回去不用再付錢）
  $("subLen").addEventListener("change", () => {
    E.saveSettings({ subLen: $("subLen").value });
    if (!V) return;
    V.wins = new Map();
    V.cues = [];
    V.gen = (V.gen || 0) + 1;
    V.inflight = 0;
    curIdx = -1;
    showSub(null);
    renderList();
    if (V.started) setStatus("每句長度改了，從目前位置重新轉錄…"), schedule();
  });
  $("subs").addEventListener("click", () => $("subs").querySelector(".tr")?.classList.toggle("peek"));
  $("fs").addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await $("stage").requestFullscreen({ navigationUI: "hide" });
    } catch (e) {
      setStatus(`這個瀏覽器不能全螢幕：${e.message}`, true);
    }
  });
  $("srt").addEventListener("click", () => {
    if (!V?.cues.length) return setStatus("還沒有字幕可以下載", true);
    const blob = new Blob([BL.toSrt(V.cues.map((c) => ({ start: c.start, end: c.end, text: c.text, tr: c.tr })))], { type: "application/x-subrip" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `${(V.title || V.vid).replace(/[\\/:*?"<>|]/g, "_").slice(0, 80)}.${E.getSettings().targetLang}.srt` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  $("stop").addEventListener("click", () => {
    if (!V?.started) return;
    V.started = false;
    setStatus("已停止轉錄（已轉好的部分還在，可以下載 SRT）");
  });
  $("load").addEventListener("click", load);
  $("url").addEventListener("keydown", (e) => e.key === "Enter" && load());
  $("start").addEventListener("click", startSubs);

  // ---------- 設定 ----------
  function openSettings() {
    const s = E.getSettings();
    for (const k of ["apiKey", "targetLang", "model", "glossary", "instructions"]) $(k).value = s[k] ?? "";
    $("testResult").textContent = "";
    showUsage();
    $("settings").showModal();
  }
  function saveForm() {
    const prev = E.getSettings();
    const next = {
      apiKey: $("apiKey").value.trim(),
      targetLang: $("targetLang").value,
      model: $("model").value.trim() || E.DEFAULTS.model,
      glossary: $("glossary").value,
      instructions: $("instructions").value,
    };
    E.saveSettings(next);
    // 翻譯設定改了：已顯示的譯文重翻（快取鍵含這些設定，不會白花錢在沒變的部分）
    if (V && (prev.targetLang !== next.targetLang || prev.model !== next.model || prev.glossary !== next.glossary || prev.instructions !== next.instructions)) {
      V.cues.forEach((c) => ((c.tr = null), (c.trErr = 0)));
      renderList();
      translatePending();
    }
  }
  function showUsage() {
    const u = E.usageReport();
    const money = (x) => (x ? `US$${x.toFixed(4)}` : "US$0");
    $("usage").textContent = `本月（${u.monthLabel}）：${u.month.requests} 次請求，${money(u.month.cost)}\n累計：${u.total.requests} 次請求，${money(u.total.cost)}`;
  }
  $("openSettings").addEventListener("click", openSettings);
  $("settings").addEventListener("close", saveForm);
  for (const k of ["apiKey", "targetLang", "model", "glossary", "instructions"]) $(k).addEventListener("change", saveForm);
  $("showKey").addEventListener("click", () => {
    const i = $("apiKey");
    i.type = i.type === "password" ? "text" : "password";
    $("showKey").textContent = i.type === "password" ? "顯示" : "隱藏";
  });
  $("test").addEventListener("click", async () => {
    saveForm();
    $("testResult").textContent = "測試中…";
    const r = await E.testConnection();
    $("testResult").textContent = r.ok ? `成功：${r.text}` : `失敗：${r.error}`;
    showUsage();
  });
  $("resetUsage").addEventListener("click", () => (E.resetUsage(), showUsage()));
  $("clearCache").addEventListener("click", async () => {
    await E.cacheClear().catch(() => {});
    $("testResult").textContent = "已清除快取";
  });

  // ---------- 開始 ----------
  try {
    const last = JSON.parse(lsGet(LS_LAST) || "null");
    if (last?.lang) $("videoLang").value = last.lang;
    if (last?.url) $("url").value = last.url;
  } catch {}
  // 網址帶 ?v= 或 ?url=（分享、書籤）：直接載入
  const q = new URLSearchParams(location.search);
  const qv = q.get("v") || q.get("url") || q.get("text");
  if (qv && videoIdOf(qv)) {
    $("url").value = qv;
    load();
  }
  syncToggles();
  E.cachePrune?.().catch(() => {});
})();
