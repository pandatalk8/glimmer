// YouTube 双语字幕：解析字幕 → 批量翻译 → 在播放器内渲染双语字幕
(() => {
  const start = () => {
    const G = window.__glimmer;
    if (!G?.send) return setTimeout(start, 200);
    if (G.yt) return;
    G.yt = true;

    let cues = []; // {start, end, text, tr}
    let trackKey = '';
    let host = null;
    let box = null;
    let raf = 0;
    let pausedByUs = false;
    let enabled = true;

    const S = () => G.settings?.() || {};

    // ---------- 解析 json3 字幕 ----------
    function parseJson3(body) {
      const data = JSON.parse(body);
      const raw = [];
      for (const ev of data.events || []) {
        if (!ev.segs) continue;
        const text = ev.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        raw.push({ start: ev.tStartMs, end: ev.tStartMs + (ev.dDurationMs || 2000), text });
      }
      return raw;
    }

    // 兼容 XML 字幕：srv3 (<p t d>) 与旧版 (<text start dur>)
    function parseXml(body) {
      const doc = new DOMParser().parseFromString(body, 'text/xml');
      const raw = [];
      doc.querySelectorAll('p[t], text[start]').forEach((n) => {
        const text = n.textContent.replace(/\s+/g, ' ').trim();
        if (!text) return;
        const isP = n.tagName === 'p';
        const start = isP ? +n.getAttribute('t') : +n.getAttribute('start') * 1000;
        const dur = isP ? +n.getAttribute('d') : +n.getAttribute('dur') * 1000;
        raw.push({ start, end: start + (dur || 2000), text });
      });
      return raw;
    }

    // 自动生成字幕是碎片化的，按标点 / 长度 / 停顿合并成句子
    function mergeAsr(raw) {
      const out = [];
      let cur = null;
      for (const c of raw) {
        if (cur && (c.start - cur.end > 1500 || /[.?!。？！]$/.test(cur.text) || cur.text.length > 90)) {
          out.push(cur);
          cur = null;
        }
        if (!cur) cur = { ...c };
        else {
          cur.text += ' ' + c.text;
          cur.end = Math.max(cur.end, c.end);
        }
      }
      if (cur) out.push(cur);
      // 修正重叠：每句结束不晚于下一句开始
      for (let i = 0; i < out.length - 1; i++) out[i].end = Math.min(out[i].end, out[i + 1].start);
      return out;
    }

    async function onCaptions(url, body) {
      if (!enabled || !S().youtube?.enabled) return;
      if (!body || body.length < 20) return; // 空响应（探测请求）
      let raw;
      try {
        raw = body.trimStart().startsWith('<') ? parseXml(body) : parseJson3(body);
      } catch {
        return;
      }
      if (!raw.length) return;
      const u = new URL(url, location.href);
      const key = [u.searchParams.get('v'), u.searchParams.get('lang'), u.searchParams.get('tlang')].join('|');
      if (key === trackKey && cues.length) return;
      trackKey = key;
      const isAsr = u.searchParams.get('kind') === 'asr';
      cues = isAsr ? mergeAsr(raw) : raw;
      ensureOverlay();
      hideNative(true);
      translateAll(key);
    }

    async function translateAll(key) {
      const pending = cues.filter((c) => c.tr == null);
      const firstNeeded = pending.findIndex((c) => c.end >= currentMs());
      // 先翻译当前播放位置附近的字幕
      const order = [...pending.slice(Math.max(0, firstNeeded)), ...pending.slice(0, Math.max(0, firstNeeded))];
      for (let i = 0; i < order.length; i += 40) {
        const chunk = order.slice(i, i + 40);
        try {
          const res = await G.send('translate', { texts: chunk.map((c) => c.text) });
          if (key !== trackKey) return;
          chunk.forEach((c, k) => (c.tr = res[k]));
          lastIdx = -2;
        } catch (e) {
          G.toast?.('字幕翻译失败：' + e.message, 'error');
          return;
        }
      }
    }

    // ---------- 渲染 ----------
    const video = () => document.querySelector('#movie_player video, video.html5-main-video');
    const currentMs = () => (video()?.currentTime || 0) * 1000;

    function ensureOverlay() {
      const player = document.querySelector('#movie_player, .html5-video-player');
      if (!player) return;
      if (host?.isConnected && host.parentElement === player) return;
      host = document.createElement('glimmer-ui');
      host.setAttribute('translate', 'no');
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `<link rel="stylesheet" href="${chrome.runtime.getURL('src/content/ui.css')}">
        <style>.yt-sub{position:absolute;left:50%;bottom:12%;}</style>
        <div class="yt-sub"></div>`;
      box = shadow.querySelector('.yt-sub');
      Object.assign(host.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: 60 });
      player.appendChild(host);

      box.addEventListener('mouseenter', () => {
        const v = video();
        if (v && !v.paused) {
          v.pause();
          pausedByUs = true;
        }
      });
      box.addEventListener('mouseleave', () => {
        if (pausedByUs) video()?.play();
        pausedByUs = false;
      });
      box.addEventListener('click', (e) => {
        const w = e.target.closest?.('.word');
        if (!w) return;
        e.stopPropagation();
        const r = w.getBoundingClientRect();
        G.openPanel?.(w.textContent.replace(/[^\p{L}\p{N}'-]/gu, ''), r.left + r.width / 2, r.top - 220);
      });
      loop();
    }

    function hideNative(on) {
      let st = document.getElementById('glimmer-yt-style');
      if (on && !st) {
        st = document.createElement('style');
        st.id = 'glimmer-yt-style';
        st.textContent = '.ytp-caption-window-container{display:none!important}';
        document.head.appendChild(st);
      }
      if (!on) st?.remove();
    }

    function findCue(ms) {
      let lo = 0;
      let hi = cues.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (cues[mid].end <= ms) lo = mid + 1;
        else if (cues[mid].start > ms) hi = mid - 1;
        else return mid;
      }
      return -1;
    }

    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
    let lastIdx = -2;
    function render() {
      if (!box) return;
      const idx = findCue(currentMs());
      if (idx === lastIdx) return;
      lastIdx = idx;
      if (idx < 0 || !enabled) {
        box.innerHTML = '';
        return;
      }
      const c = cues[idx];
      const player = document.querySelector('#movie_player');
      const fs = Math.max(14, Math.min(34, (player?.clientWidth || 800) / 38));
      box.style.setProperty('--yt-fs', fs + 'px');
      const words = c.text
        .split(/(\s+)/)
        .map((w) => (/\S/.test(w) ? `<span class="word">${esc(w)}</span>` : w))
        .join('');
      const showOrig = S().displayMode !== 'translation';
      box.innerHTML =
        (showOrig ? `<div><span class="line orig">${words}</span></div>` : '') +
        `<div><span class="line tr">${c.tr == null ? '…' : esc(c.tr)}</span></div>`;
    }

    function loop() {
      cancelAnimationFrame(raf);
      const tick = () => {
        render();
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }

    function reset() {
      cues = [];
      trackKey = '';
      lastIdx = -2;
      if (box) box.innerHTML = '';
      hideNative(false);
    }

    window.addEventListener('message', (e) => {
      if (e.source !== window || e.data?.source !== 'glimmer-yt') return;
      onCaptions(e.data.url, e.data.body);
    });
    document.addEventListener('yt-navigate-start', reset);

    G.onSettings = (s, prev) => {
      enabled = !!s.youtube?.enabled;
      if (!enabled) {
        reset();
        hideNative(false);
      }
      if (prev.targetLang !== s.targetLang || prev.engine !== s.engine) {
        const key = trackKey;
        cues.forEach((c) => (c.tr = null));
        lastIdx = -2;
        translateAll(key);
      } else lastIdx = -2;
    };
  };
  start();
})();
