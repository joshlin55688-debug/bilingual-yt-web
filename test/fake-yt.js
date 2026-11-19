// 測試用的假 YouTube IFrame API：時間軸照真的播放器（播放中每 100 毫秒往前走），影片長 300 秒。
// 影片 ID 開頭是 NOEMBED 的回報錯誤 150（上傳者不允許嵌入）。window.__fake 給測試控制。
(() => {
  class Player {
    constructor(id, opts) {
      const el = document.getElementById(id);
      const f = document.createElement("div");
      f.id = id;
      f.style.cssText = "position:absolute;inset:0;background:#223;color:#889;display:flex;align-items:center;justify-content:center";
      f.textContent = "fake player " + opts.videoId;
      el.replaceWith(f);
      this.opts = opts;
      this.t = 0;
      this.state = -1;
      this.vid = opts.videoId;
      window.__fake = this;
      this.timer = setInterval(() => {
        if (this.state === 1) this.t = Math.min(300, this.t + 0.1 * (window.__fakeSpeed || 1));
      }, 100);
      setTimeout(() => (this.vid.startsWith("NOEMBED") ? opts.events.onError({ data: 150 }) : opts.events.onReady({ target: this })), 50);
    }
    getDuration() {
      return 300;
    }
    getVideoData() {
      return { title: "Fake talk about libraries", video_id: this.vid };
    }
    getCurrentTime() {
      return this.t;
    }
    seekTo(s) {
      this.t = s;
    }
    playVideo() {
      this.state = 1;
      this.opts.events.onStateChange?.({ data: 1 });
    }
    pauseVideo() {
      this.state = 2;
      this.opts.events.onStateChange?.({ data: 2 });
    }
    getPlayerState() {
      return this.state;
    }
    destroy() {
      clearInterval(this.timer);
    }
  }
  window.YT = { Player };
  setTimeout(() => window.onYouTubeIframeAPIReady?.(), 0);
})();
