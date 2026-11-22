// Glimmer 微光翻译 —— 内容脚本
// 职责：网页双语对照翻译、悬浮球、划词翻译、悬停翻译、输入框翻译
(() => {
  if (window.__glimmer) return;
  const G = (window.__glimmer = {});

  // ---------------- 通信 ----------------
  function send(type, data = {}) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type, ...data }, (r) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (r?.ok) resolve(r.data);
          else reject(Object.assign(new Error(r?.error || '未知错误'), { code: r?.code }));
        });
      } catch (e) {
        reject(new Error('扩展已更新，请刷新页面'));
      }
    });
  }
  G.send = send;

  let S = null; // settings
  let META = null;
  const host = location.hostname;

  // ---------------- 语言判断 ----------------
  const RE_CJK = /[一-鿿㐀-䶿]/g;
  const RE_KANA = /[぀-ヿ]/g;
  const RE_HANGUL = /[가-힯]/g;
  const RE_LETTER = /\p{L}/gu;
  const EN_STOP = /\b(the|and|is|are|of|to|in|that|it|for|you|with|this|on|was|be|have)\b/i;

  function count(s, re) {
    return (s.match(re) || []).length;
  }

  // 文本是否已经是目标语言（是则跳过）
  function isTargetLang(text, target) {
    const letters = count(text, RE_LETTER);
    if (!letters) return true;
    const t = target.toLowerCase();
    if (t.startsWith('zh')) return count(text, RE_KANA) === 0 && count(text, RE_CJK) / letters > 0.3;
    if (t === 'ja') return count(text, RE_KANA) > 0;
    if (t === 'ko') return count(text, RE_HANGUL) / letters > 0.3;
    if (t === 'en') {
      const nonAscii = text.replace(/[\x00-\x7f]/g, '').length;
      return nonAscii / text.length < 0.02 && (EN_STOP.test(text) || text.length < 40);
    }
    return false;
  }
  G.isTargetLang = isTargetLang;

  function shouldTranslate(text) {
    const t = text.trim();
    if (t.length < 2) return false;
    if (!/\p{L}{2,}/u.test(t)) return false; // 纯数字/符号
    if (/^(https?:\/\/|www\.)\S+$/.test(t)) return false;
    return !isTargetLang(t, S.targetLang);
  }

  // ---------------- DOM 分析 ----------------
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'TEXTAREA',
    'INPUT', 'SELECT', 'OPTION', 'BUTTON', 'SVG', 'MATH', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME',
    'OBJECT', 'IMG', 'HEAD', 'GL-TRANS', 'GLIMMER-UI',
  ]);
  const INLINE_TAGS = new Set([
    'A', 'ABBR', 'B', 'BDI', 'BDO', 'BR', 'CITE', 'DATA', 'DFN', 'EM', 'FONT', 'I', 'MARK', 'Q',
    'S', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'WBR', 'DEL', 'INS', 'LABEL',
  ]);
  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'TH', 'BLOCKQUOTE', 'DD', 'DT',
    'FIGCAPTION', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'ASIDE', 'NAV', 'UL', 'OL',
    'TABLE', 'TR', 'BODY', 'SUMMARY', 'DETAILS', 'CAPTION', 'FORM', 'FIELDSET', 'LEGEND',
  ]);

  const inlineCache = new WeakMap();
  function isInline(el) {
    if (inlineCache.has(el)) return inlineCache.get(el);
    let v;
    if (BLOCK_TAGS.has(el.tagName)) v = false;
    else {
      const d = getComputedStyle(el).display;
      v = d.startsWith('inline') || d === 'contents' || (d === '' && INLINE_TAGS.has(el.tagName));
    }
    inlineCache.set(el, v);
    return v;
  }

  function isSkipEl(el) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.getAttribute('translate') === 'no' || el.classList.contains('notranslate')) return true;
    if (el.isContentEditable) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    return false;
  }

  function nearestBlock(el) {
    while (el && el !== document.body && el.parentElement && isInline(el)) el = el.parentElement;
    return el;
  }

  // 收集一个 inline 节点下的文本节点（遇到块级子元素停止）
  function collectInlineText(node, out) {
    if (node.nodeType === 3) {
      out.push(node);
      return;
    }
    if (node.nodeType !== 1 || isSkipEl(node) || !isInline(node)) return;
    for (const c of node.childNodes) collectInlineText(c, out);
  }

  let processed = new WeakSet(); // 已处理过的文本节点
  // 每个块已经翻译过的原文。别的扩展（如 Trancy 用 <xt-mark> 高亮收藏的单词）或网页框架会把文字节点拆开重建，
  // 内容没变但节点是新的；只看节点会把整段再翻一遍、出现两份译文。原文相同就跳过，内容真的变了才重新翻译
  let blockTexts = new WeakMap(); // block → Set<原文>
  let units = []; // 所有翻译单元

  // 把一个块元素拆成若干“连续 inline 段”，每段是一个翻译单元
  function unitsOfBlock(block) {
    const result = [];
    let run = [];
    const flush = () => {
      if (!run.length) return;
      // 菜单/标签类：多个并列 inline 元素且之间没有文字，逐个单独翻译
      const els = run.filter((n) => n.nodeType === 1 && n.tagName !== 'BR');
      const hasText = run.some((n) => n.nodeType === 3 && n.nodeValue.trim());
      if (els.length >= 2 && !hasText) {
        const items = els;
        run = [];
        for (const el of items) {
          run = [el];
          flushOne();
        }
        return;
      }
      flushOne();
    };
    const flushOne = () => {
      if (!run.length) return;
      const textNodes = [];
      run.forEach((n) => collectInlineText(n, textNodes));
      const fresh = textNodes.some((t) => !processed.has(t));
      textNodes.forEach((t) => processed.add(t));
      const text = textNodes.map((t) => t.nodeValue).join('').replace(/\s+/g, ' ').trim();
      let seen = blockTexts.get(block);
      if (fresh && seen?.has(text)) {
        run = [];
        return;
      }
      if (fresh && shouldTranslate(text)) {
        if (!seen) blockTexts.set(block, (seen = new Set()));
        seen.add(text);
        result.push({ block, nodes: run.slice(), text, pure: false });
      }
      run = [];
    };
    for (const c of block.childNodes) {
      if (c.nodeType === 3) run.push(c);
      else if (c.nodeType === 1) {
        if (c.tagName === 'GL-TRANS') continue;
        if (isSkipEl(c)) {
          if (c.tagName === 'CODE' || c.tagName === 'KBD') run.push(c); // 行内代码保留在段落中
          continue;
        }
        if (isInline(c)) run.push(c);
        else flush();
      }
    }
    flush();
    if (result.length === 1) {
      const meaningful = [...block.childNodes].filter(
        (n) => n.nodeType === 1 ? n.tagName !== 'GL-TRANS' : n.nodeValue.trim()
      );
      result[0].pure = meaningful.every((n) => result[0].nodes.includes(n));
    }
    return result;
  }

  function scan(root) {
    if (!root || !S) return [];
    const blocks = new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 1) return isSkipEl(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        return !processed.has(n) && n.nodeValue.trim().length > 1
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      const b = nearestBlock(n.parentElement);
      if (b && !b.closest('glimmer-ui,gl-trans,[translate="no"],.notranslate')) blocks.add(b);
    }
    const found = [];
    blocks.forEach((b) => found.push(...unitsOfBlock(b)));
    return found;
  }

  // ---------------- 译文渲染 ----------------
  function mount(unit) {
    const el = document.createElement('gl-trans');
    const isHeading = /^H[1-6]$/.test(unit.block.tagName);
    const inline = !isHeading && unit.block.tagName !== 'P' && unit.text.length <= 28;
    el.className = 'gl-trans ' + (inline ? 'gl-inline' : 'gl-block') + ' gl-loading';
    el.setAttribute('translate', 'no');
    const span = document.createElement('span');
    span.className = 'gl-t';
    el.appendChild(span);
    if (unit.pure) {
      // 记录原始字号与边距，供“仅译文”模式（font-size:0 隐藏原文）还原排版
      const cs = getComputedStyle(unit.block);
      const b = unit.block.style;
      b.setProperty('--gl-fs', cs.fontSize);
      b.setProperty('--gl-mt', cs.marginTop);
      b.setProperty('--gl-mb', cs.marginBottom);
      b.setProperty('--gl-pt', cs.paddingTop);
      b.setProperty('--gl-pb', cs.paddingBottom);
      unit.block.classList.add('gl-host');
      unit.block.appendChild(el);
    } else {
      // 段内只有元素（如菜单链接）时，仅译文模式可以直接隐藏这些元素
      if (unit.nodes.every((n) => n.nodeType === 1 || !n.nodeValue.trim()))
        unit.nodes.forEach((n) => n.nodeType === 1 && n.classList.add('gl-src'));
      unit.nodes[unit.nodes.length - 1].after(el);
    }
    unit.el = el;
  }

  function fill(unit, text) {
    if (!unit.el?.isConnected) return;
    unit.el.classList.remove('gl-loading', 'gl-error');
    unit.el.firstChild.textContent = text;
  }

  function fail(unit, msg) {
    if (!unit.el?.isConnected) return;
    unit.el.classList.remove('gl-loading');
    unit.el.classList.add('gl-error');
    unit.el.firstChild.textContent = '翻译失败，点击重试';
    unit.el.title = msg;
    unit.el.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      unit.el.onclick = null;
      unit.el.classList.add('gl-loading');
      unit.el.classList.remove('gl-error');
      unit.el.firstChild.textContent = '';
      enqueue([unit]);
    };
  }

  // ---------------- 翻译队列 ----------------
  let pending = [];
  let flushTimer = 0;
  let errorShown = false;

  function enqueue(list) {
    pending.push(...list);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 80);
  }

  function flush() {
    const all = pending;
    pending = [];
    const MAX_CHARS = 5000;
    const MAX_ITEMS = 40;
    let batch = [];
    let size = 0;
    const go = (b) => {
      if (!b.length) return;
      const gen = state.gen;
      send('translate', { texts: b.map((u) => u.text) })
        .then((res) => {
          if (gen !== state.gen) return;
          b.forEach((u, i) => fill(u, res[i]));
          updateBall();
        })
        .catch((e) => {
          if (gen !== state.gen) return;
          b.forEach((u) => fail(u, e.message));
          if (!errorShown) {
            errorShown = true;
            toast(e.message, 'error');
            setTimeout(() => (errorShown = false), 4000);
          }
        });
    };
    for (const u of all) {
      if (batch.length && (size + u.text.length > MAX_CHARS || batch.length >= MAX_ITEMS)) {
        go(batch);
        batch = [];
        size = 0;
      }
      batch.push(u);
      size += u.text.length;
    }
    go(batch);
  }

  // ---------------- 整页翻译状态 ----------------
  const state = { active: false, gen: 0, io: null, mo: null };
  const pendingByEl = new Map();

  function observeUnits(list) {
    for (const u of list) {
      units.push(u);
      const arr = pendingByEl.get(u.block);
      if (arr) arr.push(u);
      else {
        pendingByEl.set(u.block, [u]);
        state.io.observe(u.block);
      }
    }
  }

  function onIntersect(entries) {
    const ready = [];
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      state.io.unobserve(e.target);
      const list = pendingByEl.get(e.target) || [];
      pendingByEl.delete(e.target);
      list.forEach((u) => {
        mount(u);
        ready.push(u);
      });
    }
    if (ready.length) enqueue(ready);
  }

  let moTimer = 0;
  let moRoots = new Set();
  function onMutation(records) {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeType === 1 && (n.tagName === 'GL-TRANS' || n.tagName === 'GLIMMER-UI')) continue;
        if (n.nodeType === 3 || n.nodeType === 1) moRoots.add(n.nodeType === 3 ? n.parentElement : n);
      }
    }
    if (!moRoots.size) return;
    clearTimeout(moTimer);
    moTimer = setTimeout(() => {
      const roots = [...moRoots].filter((r) => r?.isConnected);
      moRoots = new Set();
      for (const r of roots) observeUnits(scan(r));
    }, 400);
  }

  function startPage() {
    if (state.active || !document.body) return;
    state.active = true;
    state.gen++;
    applyAttrs();
    state.io = new IntersectionObserver(onIntersect, { rootMargin: '600px 0px' });
    observeUnits(scan(document.body));
    state.mo = new MutationObserver(onMutation);
    state.mo.observe(document.body, { childList: true, subtree: true });
    updateBall();
    notifyState();
  }

  function clearTranslations() {
    document.querySelectorAll('gl-trans').forEach((e) => e.remove());
    document.querySelectorAll('.gl-host').forEach((e) => {
      e.classList.remove('gl-host');
      ['--gl-fs', '--gl-mt', '--gl-mb', '--gl-pt', '--gl-pb'].forEach((p) => e.style.removeProperty(p));
    });
    document.querySelectorAll('.gl-src').forEach((e) => e.classList.remove('gl-src'));
    processed = new WeakSet();
    blockTexts = new WeakMap();
    units = [];
    pendingByEl.clear();
    pending = [];
  }

  function stopPage() {
    state.active = false;
    state.gen++;
    state.io?.disconnect();
    state.mo?.disconnect();
    clearTranslations();
    updateBall();
    notifyState();
  }

  function togglePage() {
    state.active ? stopPage() : startPage();
  }

  function restartPage() {
    if (!state.active) return;
    stopPage();
    startPage();
  }

  function applyAttrs() {
    const r = document.documentElement;
    r.setAttribute('data-gl-mode', S.displayMode);
    r.setAttribute('data-gl-style', S.transStyle);
    r.style.setProperty('--gl-color', S.transColor || '#8b5cf6');
  }

  // ---------------- UI（Shadow DOM） ----------------
  const LOGO = `<svg viewBox="0 0 32 32" width="18" height="18" fill="none"><path d="M6 8h12M12 5v3m4 0c-1 5-5 9-9 11m3-6c2 3 5 5 8 6" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 27l5-12 5 12m-8.4-4h6.8" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  let uiRoot = null;
  let shadow = null;

  function ensureUI() {
    if (shadow) return shadow;
    uiRoot = document.createElement('glimmer-ui');
    // 内联 !important：即使网页样式表隐藏未注册的自定义元素，也保持可见（content.css 中还有同样的规则）
    uiRoot.style.setProperty('visibility', 'visible', 'important');
    uiRoot.style.setProperty('opacity', '1', 'important');
    uiRoot.setAttribute('translate', 'no');
    shadow = uiRoot.attachShadow({ mode: 'open' });
    const style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = chrome.runtime.getURL('src/content/ui.css');
    shadow.appendChild(style);
    document.documentElement.appendChild(uiRoot);
    return shadow;
  }
  G.ensureUI = ensureUI;

  function h(tag, attrs = {}, html = '') {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (html) el.innerHTML = html;
    return el;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  // action：{ label, run } 时在提示中显示一个按钮（如“查看会员方案”），停留时间更长
  function toast(msg, kind = 'info', action = null) {
    const root = ensureUI();
    const t = h('div', { class: 'toast ' + kind }, esc(msg));
    if (action) {
      const b = h('button', { class: 'toast-act' }, esc(action.label));
      b.onclick = () => {
        action.run();
        t.remove();
      };
      t.appendChild(b);
    }
    root.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 300);
    }, action ? 8000 : 3200);
  }
  const openPremium = () => send('openPremium').catch(() => {});
  G.toast = toast;

  // ---------- 侧边面板（iframe 加载扩展页 panel.html） ----------
  let drawer = null;
  function openDrawer(view = 'home') {
    const root = ensureUI();
    if (drawer) return;
    drawer = h('div', { class: 'drawer' });
    const f = document.createElement('iframe');
    f.src = chrome.runtime.getURL('panel/panel.html') + '?mode=drawer&view=' + encodeURIComponent(view);
    f.setAttribute('allow', 'clipboard-write');
    drawer.appendChild(f);
    root.appendChild(drawer);
    requestAnimationFrame(() => requestAnimationFrame(() => drawer?.classList.add('open')));
    ball?.classList.add('with-drawer'); // 悬浮球移到面板左侧，避免被遮挡
  }
  function closeDrawer() {
    const d = drawer;
    drawer = null;
    if (!d) return;
    ball?.classList.remove('with-drawer');
    d.classList.remove('open');
    setTimeout(() => d.remove(), 220);
  }
  function toggleDrawer(view) {
    drawer ? closeDrawer() : openDrawer(view);
  }
  G.toggleDrawer = toggleDrawer;
  // 面板 iframe 通过 postMessage 请求关闭；校验来源必须是本扩展
  window.addEventListener('message', (e) => {
    if (e.data?.source !== 'glimmer-panel' || e.origin !== 'chrome-extension://' + chrome.runtime.id) return;
    if (e.data.type === 'close') closeDrawer();
  });

  // 通知已打开的面板（弹窗或抽屉）页面翻译状态变化
  function notifyState() {
    try {
      chrome.runtime.sendMessage({ type: 'pageStateChanged', active: state.active }, () => void chrome.runtime.lastError);
    } catch {}
  }

  // ---------- 悬浮球 ----------
  let ball = null;
  function buildBall() {
    const root = ensureUI();
    ball = h('div', { class: 'ball-wrap' });
    ball.innerHTML = `
      <div class="ball-menu">
        <button data-act="mode" title="切换双语 / 仅译文"><span class="ic">⇄</span><span class="lbl"></span></button>
        <button data-act="panel" title="打开面板"><span class="ic">☰</span><span class="lbl">面板</span></button>
        <button data-act="hide" title="本页隐藏悬浮球"><span class="ic">✕</span><span class="lbl">隐藏</span></button>
      </div>
      <div class="ball" title="翻译此页面 (Alt+A)">${LOGO}<span class="dot"></span></div>`;
    ball.style.top = (sessionStorage.getItem('gl-ball-top') || '62') + '%';
    root.appendChild(ball);

    const core = ball.querySelector('.ball');
    let drag = null;
    core.addEventListener('pointerdown', (e) => {
      drag = { y: e.clientY, moved: false };
      core.setPointerCapture(e.pointerId);
    });
    core.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (Math.abs(e.clientY - drag.y) > 4) drag.moved = true;
      if (drag.moved) {
        const pct = Math.min(92, Math.max(5, (e.clientY / innerHeight) * 100));
        ball.style.top = pct + '%';
      }
    });
    core.addEventListener('pointerup', () => {
      if (drag && !drag.moved) togglePage();
      if (drag?.moved) sessionStorage.setItem('gl-ball-top', parseFloat(ball.style.top));
      drag = null;
    });
    ball.querySelector('.ball-menu').addEventListener('click', async (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (act === 'mode')
        await send('saveSettings', { patch: { displayMode: S.displayMode === 'bilingual' ? 'translation' : 'bilingual' } });
      if (act === 'panel') toggleDrawer();
      if (act === 'hide') ball.remove(), (ball = null);
    });
    updateBall();
  }

  function updateBall() {
    if (!ball) return;
    ball.classList.toggle('active', state.active);
    const loading = state.active && document.querySelector('gl-trans.gl-loading');
    ball.classList.toggle('loading', !!loading);
    ball.querySelector('[data-act=mode] .lbl').textContent = S.displayMode === 'bilingual' ? '仅译文' : '双语';
  }

  function syncBall() {
    if (S.floatBall && !ball && window.top === window) buildBall();
    if (!S.floatBall && ball) ball.remove(), (ball = null);
    updateBall();
  }

  // ---------- 划词翻译 ----------
  let selIcon = null;
  let panel = null;

  function hideSelUI() {
    selIcon?.remove();
    selIcon = null;
  }

  function closePanel() {
    panel?.remove();
    panel = null;
  }

  function pickTarget(text) {
    // 选中的文本已是目标语言时，智能切换为英文（中英互译）
    if (isTargetLang(text, S.targetLang)) return S.targetLang.startsWith('en') ? 'zh-CN' : 'en';
    return S.targetLang;
  }

  async function openPanel(text, x, y) {
    hideSelUI();
    closePanel();
    const root = ensureUI();
    META = (await send('meta').catch(() => null)) || META; // 每次重新读取，登录或升级后等级标注随之更新
    const engines = META?.engines || [];
    const RANK = { free: 0, premium: 1, premium_plus: 2 };
    const TIER = { premium: 'Premium', premium_plus: 'Premium+' };
    const locked = (e) => (RANK[e.tier] || 0) > (RANK[META?.plan] || 0);
    // 默认引擎还没解锁时，面板先用 Google 翻译（与整页翻译的自动改用一致）
    let engine = engines.find((e) => e.id === S.engine && !locked(e)) ? S.engine : 'google';
    let to = pickTarget(text);

    panel = h('div', { class: 'panel' });
    panel.innerHTML = `
      <div class="p-head">
        <div class="p-brand">${LOGO}<span>微光翻译</span></div>
        <select class="p-engine">${engines
          .map((e) => `<option value="${e.id}" ${e.id === engine ? 'selected' : ''}>${esc(e.name)}${locked(e) ? `（${TIER[e.tier]}）` : ''}</option>`)
          .join('')}</select>
        <button class="p-x" title="关闭">✕</button>
      </div>
      <div class="p-src">${esc(text)}</div>
      <div class="p-lang"></div>
      <div class="p-out"><span class="spinner"></span></div>
      <div class="p-foot">
        ${text.length <= 300 ? '<button data-act="save" class="p-save" title="收藏到生词本">☆ 收藏</button>' : ''}
        <button data-act="speak-src" title="朗读原文">🔊 原文</button>
        <button data-act="speak" title="朗读译文">🔊 译文</button>
        <button data-act="copy" title="复制译文">复制</button>
        <button data-act="retry" title="重新翻译">重译</button>
      </div>`;
    root.appendChild(panel);

    const W = 380;
    const left = Math.min(Math.max(8, x - W / 2), innerWidth - W - 8);
    panel.style.left = left + 'px';
    panel.style.top = Math.min(y + 12, innerHeight - 200) + 'px';

    const out = panel.querySelector('.p-out');
    const langEl = panel.querySelector('.p-lang');
    const name = (c) => META?.languages?.find((l) => l.code === c)?.name || c;
    let result = '';

    const run = async () => {
      out.innerHTML = '<span class="spinner"></span>';
      langEl.textContent = `→ ${name(to)}`;
      try {
        [result] = await send('translate', { texts: [text], to, engine });
        out.textContent = result;
      } catch (e) {
        if (e.code === 'upgrade' || e.code === 'login') {
          // 手动选了未解锁的引擎：说明需要什么，而不是报错
          out.innerHTML = `<div class="p-upsell"><span>${esc(e.message)}</span>
            <div class="p-upsell-btns"><button class="p-up-go">查看会员方案</button><button class="p-up-back">改用 Google 翻译</button></div></div>`;
          out.querySelector('.p-up-go').onclick = openPremium;
          out.querySelector('.p-up-back').onclick = () => {
            engine = 'google';
            panel.querySelector('.p-engine').value = 'google';
            run();
          };
        } else out.innerHTML = `<span class="err">${esc(e.message)}</span>`;
      }
    };
    run();

    const saveBtn = panel.querySelector('.p-save');
    const markSaved = (on) => {
      if (!saveBtn) return;
      saveBtn.classList.toggle('on', on);
      saveBtn.textContent = on ? '★ 已收藏' : '☆ 收藏';
    };
    if (saveBtn) send('hasWord', { word: text }).then(markSaved).catch(() => {});

    panel.querySelector('.p-engine').addEventListener('change', (e) => {
      engine = e.target.value;
      run();
    });
    panel.querySelector('.p-x').onclick = closePanel;
    panel.querySelector('.p-foot').addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (act === 'save') {
        send('toggleWord', { word: text, trans: result, url: location.href })
          .then((r) => {
            markSaved(r.saved);
            toast(r.saved ? `已收藏到生词本（共 ${r.count} 个）` : '已从生词本移除');
          })
          .catch((err) => toast(err.message, 'error', err.code === 'upgrade' ? { label: '查看会员方案', run: openPremium } : null));
      }
      if (act === 'copy') navigator.clipboard.writeText(result).then(() => toast('已复制'));
      if (act === 'retry') run();
      if (act === 'speak') speak(result, to);
      if (act === 'speak-src') speak(text, S.sourceLang === 'auto' ? undefined : S.sourceLang);
    });

    // 拖动面板
    const head = panel.querySelector('.p-head');
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('select,button')) return;
      const r = panel.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      const move = (ev) => {
        panel.style.left = ev.clientX - dx + 'px';
        panel.style.top = ev.clientY - dy + 'px';
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    });
  }
  G.openPanel = openPanel;

  function speak(text, lang) {
    if (!text) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (lang) u.lang = lang;
    speechSynthesis.speak(u);
  }

  function inOurUI(e) {
    return e.composedPath().includes(uiRoot);
  }

  document.addEventListener('mouseup', (e) => {
    if (!S?.selection?.enabled || e.button !== 0 || inOurUI(e)) return;
    setTimeout(() => {
      const sel = getSelection();
      const text = sel?.toString().trim();
      if (!text || text.length > 5000) return hideSelUI();
      const a = document.activeElement;
      if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
      if (S.selection.trigger === 'auto') return openPanel(text, e.clientX, e.clientY);
      hideSelUI();
      const root = ensureUI();
      selIcon = h('div', { class: 'sel-icon', title: '翻译' }, LOGO);
      selIcon.style.left = Math.min(e.clientX + 8, innerWidth - 40) + 'px';
      selIcon.style.top = Math.min(e.clientY + 10, innerHeight - 40) + 'px';
      selIcon.addEventListener('mousedown', (ev) => ev.preventDefault());
      selIcon.addEventListener('click', () => openPanel(text, e.clientX, e.clientY));
      root.appendChild(selIcon);
    }, 10);
  });

  document.addEventListener('mousedown', (e) => {
    if (inOurUI(e)) return;
    hideSelUI();
    if (panel) closePanel();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideSelUI();
      if (panel) closePanel();
      else closeDrawer();
    }
  });

  // ---------- 悬停翻译（按住 Alt 悬停段落） ----------
  let mouse = { x: 0, y: 0 };
  document.addEventListener('mousemove', (e) => (mouse = { x: e.clientX, y: e.clientY }), { passive: true });
  // 在 root 下找屏幕上正好盖住 (x, y) 的文字节点；看不见的文字（读屏专用、被裁剪的）占不到这个位置，会被跳过
  function textNodeAt(root, x, y) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let t;
    while ((t = w.nextNode())) {
      if (!t.nodeValue.trim() || t.parentElement?.closest('gl-trans,glimmer-ui')) continue;
      // 透明、visibility: hidden 的文字虽然占着位置，用户看不见，也跳过
      if (t.parentElement?.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) === false) continue;
      range.selectNodeContents(t);
      for (const r of range.getClientRects()) {
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return t;
      }
    }
    return null;
  }

  // 鼠标下真正要翻译的段落。不能只看最上层元素：Reddit、新闻列表常在整张卡片上盖一层透明链接，
  // 链接里还可能藏着读屏专用的标题文字。所以按层叠顺序从上往下，找第一个“屏幕上的文字正好在指针下”的块；
  // 指针落在行间空白时，退回到第一个有可见文字的块。
  function hoverHit(x, y) {
    let fallback = null;
    for (const el of document.elementsFromPoint(x, y)) {
      if (el === document.body || el === document.documentElement) break;
      if (el.closest('glimmer-ui')) return null; // 指在扩展自己的界面上
      const tr = el.closest('gl-trans');
      if (tr) return { el, block: tr.parentElement };
      const block = nearestBlock(el);
      if (!block || block === document.body) continue;
      const t = textNodeAt(block, x, y);
      if (t) return { el: t.parentElement, block: nearestBlock(t.parentElement) };
      if (!fallback && (block.querySelector(':scope > gl-trans') || (block.innerText || '').trim().length > 1)) fallback = { el, block };
    }
    return fallback;
  }

  document.addEventListener('keydown', (e) => {
    if (!S?.hover?.enabled || e.key !== S.hover.key || e.repeat) return;
    const hit = hoverHit(mouse.x, mouse.y);
    if (!hit) return;
    const { el: target, block } = hit;
    const existing = target.closest('gl-trans') || block.querySelector(':scope > gl-trans');
    if (existing && !state.active) {
      const blk = existing.parentElement;
      existing.remove();
      const w = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT);
      let t;
      while ((t = w.nextNode())) processed.delete(t);
      blockTexts.delete(blk); // 悬停还原后允许再次翻译这一段
      return;
    }
    applyAttrs();
    const found = unitsOfBlock(block);
    found.forEach(mount);
    if (found.length) enqueue(found);
  });

  // ---------- 输入框翻译（连按三次空格） ----------
  document.addEventListener('keyup', async (e) => {
    if (!S?.inputTranslate?.enabled || e.key !== ' ') return;
    const el = e.target;
    const isField = el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|)$/.test(el.type));
    const value = isField ? el.value : el.isContentEditable ? el.innerText : null;
    if (value == null || !/\S {3}$/.test(value.replace(/ /g, ' '))) return;
    const text = value.replace(/[\s ]{3}$/, '');
    try {
      toast('正在翻译输入内容…');
      const [r] = await send('translate', { texts: [text], to: S.inputTranslate.targetLang });
      if (isField) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
        setter.call(el, r);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        el.focus();
        document.execCommand('selectAll');
        document.execCommand('insertText', false, r);
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // 生词本中哪些词出现在当前网页上：单词按整词匹配，短语按子串匹配，不区分大小写
  function findPageWords(list) {
    const text = (document.body?.innerText || '').toLowerCase();
    const tokens = new Set(text.match(/[\p{L}\p{N}'’-]+/gu) || []);
    return list.filter((w) => {
      const k = String(w).trim().toLowerCase();
      return k && (/\s/.test(k) ? text.includes(k) : tokens.has(k));
    });
  }

  // ---------------- 消息 ----------------
  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (window.top !== window && msg.type !== 'togglePage' && msg.type !== 'setPage') return;
    if (msg.type === 'togglePage') togglePage();
    if (msg.type === 'setPage') msg.on ? startPage() : stopPage();
    if (msg.type === 'translateSelection') openPanel(msg.text, innerWidth / 2, innerHeight / 3);
    if (msg.type === 'toggleDrawer') toggleDrawer(msg.view);
    if (msg.type === 'getState') reply({ active: state.active, units: units.length, host });
    if (msg.type === 'ping') reply(true);
    if (msg.type === 'billingResult') toast(msg.text, msg.ok ? 'success' : 'info'); // 支付完成后回到本页时提示
    if (msg.type === 'engineNotice') toast(msg.text, 'info', msg.action ? { label: msg.action, run: openPremium } : null); // 默认引擎不可用，已改用 Google
    if (msg.type === 'pageWords') reply(findPageWords(msg.words || []));
  });

  // ---------------- 初始化 ----------------
  async function init() {
    try {
      S = await send('getSettings');
    } catch {
      return;
    }
    G.settings = () => S;
    syncBall();
    const never = (S.neverSites || []).some((p) => host === p || host.endsWith('.' + p));
    const always = (S.alwaysSites || []).some((p) => host === p || host.endsWith('.' + p));
    if (always && !never) startPage();
    G.onReady?.();
  }

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !changes.settings || !S) return;
    const prev = S;
    try {
      S = await send('getSettings'); // 由后台合并默认值
    } catch {
      return;
    }
    applyAttrsIfActive();
    syncBall();
    if (prev.engine !== S.engine || prev.targetLang !== S.targetLang || prev.sourceLang !== S.sourceLang)
      restartPage();
    G.onSettings?.(S, prev);
  });

  function applyAttrsIfActive() {
    if (document.documentElement.hasAttribute('data-gl-mode')) applyAttrs();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
