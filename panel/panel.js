// 面板：工具栏弹窗与网页内侧边抽屉共用同一页面
import { getSettings, saveSettings, ENGINES, hostMatches } from '../src/shared/settings.js';
import { LANGUAGES, TARGET_LANGUAGES, getLang } from '../src/shared/languages.js';

const qs = new URLSearchParams(location.search);
const MODE = qs.get('mode') === 'drawer' ? 'drawer' : 'popup';
document.documentElement.dataset.mode = MODE;
const VERSION = chrome.runtime.getManifest().version;
const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------------- 图标（线性，24px 网格） ----------------
const svg = (d, size = 20) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const IC = {
  close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  home: svg('<rect x="3" y="3" width="7.5" height="7.5" rx="2.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2.5"/>'),
  gear: svg('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'),
  translate: svg('<path d="m5 8 6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6"/>'),
  cursor: svg('<path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2"/><path d="M9 9h6M12 9v7"/>'),
  video: svg('<rect x="2" y="4" width="20" height="16" rx="3"/><path d="M7 15h4M15 15h2M7 11h2M13 11h4"/>'),
  book: svg('<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/><path d="M9 7h6"/>'),
  sliders: svg('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>'),
  chev: svg('<path d="m9 18 6-6-6-6"/>', 18),
  back: svg('<path d="m15 18-6-6 6-6"/>', 22),
  check: svg('<path d="M20 6 9 17l-5-5"/>', 20),
  heart: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7.5-4.6-9.6-9.2C1 8.6 3 5 6.6 5c2 0 3.4 1.1 4.4 2.5C12 6.1 13.4 5 15.4 5 19 5 21 8.6 19.6 11.8 17.5 16.4 12 21 12 21z"/></svg>`,
  engine: svg('<rect x="3" y="5" width="16" height="15" rx="3"/><path d="M7 16l2.5-7 2.5 7M7.9 13.6h3.2M15 9v7"/><path d="M20 2.5l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z" fill="currentColor" stroke="none"/>', 24),
  style: svg('<path d="M4 20h16M6 16l6-12 6 12M8.5 11h7"/>'),
  mouse: svg('<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 7v4"/>'),
  keyboard: svg('<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M8 16h8M10 13h4"/>'),
  ball: svg('<rect x="4" y="4" width="16" height="16" rx="3"/><rect x="9" y="9" width="6" height="6" rx="1"/>'),
  globe: svg('<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'),
  detect: svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3M8 11h6M11 8v6"/>'),
  input: svg('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10v4M11 12h6"/>'),
  sites: svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  key: svg('<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>'),
  info: svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>'),
  inbox: svg('<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>', 34),
  speak: svg('<path d="M11 5 6 9H2v6h4l5 4V5zM15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/>', 16),
  trash: svg('<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>', 16),
};

// ---------------- 状态 ----------------
let S = await getSettings();
let words = (await chrome.storage.local.get('words')).words || [];
let tab = null;
let host = '';
let page = { supported: false, active: false };
let view = qs.get('view') || 'home';
let history = [];
let quick = { text: '', out: '', err: false };

async function resolveTab() {
  if (MODE === 'drawer') {
    const r = await chrome.runtime.sendMessage({ type: 'tabInfo' }).catch(() => null);
    return r?.ok ? r.data : null;
  }
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t || null;
}

async function refreshPage() {
  if (!tab?.id) return (page = { supported: false, active: false });
  try {
    const st = await chrome.tabs.sendMessage(tab.id, { type: 'getState' }, { frameId: 0 });
    page = { supported: !!st, active: !!st?.active };
  } catch {
    page = { supported: false, active: false };
  }
}

async function save(patch) {
  S = await saveSettings(patch);
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 1600);
}

function openOptions(hash = '') {
  chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') + (hash ? '#' + hash : '') });
  if (MODE === 'popup') window.close();
}

function close() {
  if (MODE === 'popup') window.close();
  else parent.postMessage({ source: 'glimmer-panel', type: 'close' }, '*');
}

// ---------------- 选项定义 ----------------
const onOff = [
  ['on', '已开启'],
  ['off', '已关闭'],
];
const engineOf = (id) => ENGINES.find((e) => e.id === id);
const engineReady = (e) => !e.needKey || !!S.engines[e.id]?.apiKey;
const langOpts = (list) => list.map((l) => [l.code, l.name]);

const PICKERS = {
  engine: {
    title: '翻译引擎',
    get: (s) => s.engine,
    set: (v) => ({ engine: v }),
    options: () =>
      ENGINES.map((e) => [
        e.id,
        e.name,
        e.free ? '<span class="tag free">免费</span>' : e.id === 'custom' ? '<span class="tag">兼容接口</span>' : engineReady(e) ? '<span class="tag">已配置</span>' : '<span class="tag need">需 API Key</span>',
        e.type === 'llm' ? S.engines[e.id]?.model : '',
      ]),
    footer: '<button class="link" data-act="options" data-hash="engines">配置 API Key 与模型 ' + IC.chev + '</button>',
    after: (v) => {
      const e = engineOf(v);
      if (!engineReady(e)) toast(`${e.name} 需要先配置 API Key`);
    },
  },
  youtube: {
    title: '双语字幕',
    get: (s) => (s.youtube.enabled ? 'on' : 'off'),
    set: (v) => ({ youtube: { enabled: v === 'on' } }),
    options: () => onOff,
    hint: '在 YouTube 打开字幕（CC）后显示原文 + 译文。',
  },
  displayMode: {
    title: '沉浸翻译',
    get: (s) => s.displayMode,
    set: (v) => ({ displayMode: v }),
    options: () => [
      ['bilingual', '对照翻译', '', '原文下方显示译文'],
      ['translation', '仅显示译文', '', '隐藏原文，只保留译文'],
    ],
    hint: '快捷键 Alt+S 可随时切换。',
  },
  transStyle: {
    title: '译文样式',
    get: (s) => s.transStyle,
    set: (v) => ({ transStyle: v }),
    options: () => [
      ['none', '默认'],
      ['underline', '下划线'],
      ['dashed', '虚线'],
      ['highlight', '高亮'],
      ['border', '引用条'],
      ['weak', '弱化'],
      ['color', '彩色'],
      ['blur', '学习模式', '', '译文模糊，鼠标悬停显示'],
    ],
  },
  selection: {
    title: '划词翻译',
    get: (s) => (s.selection.enabled ? s.selection.trigger : 'off'),
    set: (v) => (v === 'off' ? { selection: { enabled: false } } : { selection: { enabled: true, trigger: v } }),
    options: () => [
      ['icon', '显示按钮', '', '选中文字后出现图标，点击翻译'],
      ['auto', '直接翻译', '', '选中文字后立即弹出译文'],
      ['off', '已关闭'],
    ],
  },
  hover: {
    title: '悬停翻译',
    get: (s) => (s.hover.enabled ? s.hover.key : 'off'),
    set: (v) => (v === 'off' ? { hover: { enabled: false } } : { hover: { enabled: true, key: v } }),
    options: () => [
      ['Alt', 'Alt / Option'],
      ['Control', 'Ctrl'],
      ['Shift', 'Shift'],
      ['off', '已关闭'],
    ],
    hint: '按住按键并指向段落，只翻译这一段。',
  },
  inputTranslate: {
    title: '输入框翻译',
    get: (s) => (s.inputTranslate.enabled ? s.inputTranslate.targetLang : 'off'),
    set: (v) => (v === 'off' ? { inputTranslate: { enabled: false } } : { inputTranslate: { enabled: true, targetLang: v } }),
    options: () => [['off', '已关闭'], ...langOpts(TARGET_LANGUAGES)],
    hint: '在输入框末尾连按三次空格，把内容翻译成所选语言。',
  },
  floatBall: {
    title: '浮动按钮',
    get: (s) => (s.floatBall ? 'on' : 'off'),
    set: (v) => ({ floatBall: v === 'on' }),
    options: () => onOff,
  },
  targetLang: {
    title: '翻译语言',
    get: (s) => s.targetLang,
    set: (v) => ({ targetLang: v }),
    options: () => langOpts(TARGET_LANGUAGES),
  },
  sourceLang: {
    title: '网页语言',
    get: (s) => s.sourceLang,
    set: (v) => ({ sourceLang: v }),
    options: () => langOpts(LANGUAGES),
  },
};

const labelOf = (key) => {
  const p = PICKERS[key];
  const v = p.get(S);
  return p.options().find((o) => o[0] === v)?.[1] ?? v;
};

// ---------------- 视图 ----------------
function header(title) {
  if (!title) {
    return `<header class="hd">
      <div class="brand"><img src="../icons/icon48.png" alt="" /><span>微光翻译</span></div>
      <span class="chip">v${VERSION}</span></header>`;
  }
  return `<header class="hd">
    ${history.length ? `<button class="back" data-act="back" title="返回">${IC.back}</button>` : ''}
    <h1>${esc(title)}</h1></header>`;
}

function wordList(list) {
  return list
    .map(
      (w, i) => `<div class="word">
        <div class="wtx"><b>${esc(w.w)}</b><small>${esc(w.t || '')}</small></div>
        <button class="mini" data-act="speak" data-i="${i}" title="朗读">${IC.speak}</button>
        <button class="mini" data-act="delWord" data-i="${i}" title="删除">${IC.trash}</button>
      </div>`
    )
    .join('');
}

const VIEWS = {
  home() {
    const eng = engineOf(S.engine);
    const always = !!host && hostMatches(host, S.alwaysSites);
    const recent = words.slice(0, 5);
    return `${header()}
    <div class="body">
      <div class="grid2">
        <button class="stat" data-go="words"><span class="si si-pink">${IC.heart}</span>
          <span><b>${words.length}</b><small>生词本</small></span></button>
        <button class="stat" data-pick="engine"><span class="si si-gold">${IC.engine}</span>
          <span><b>${esc(eng?.name.replace(/ 翻译$/, '') || S.engine)}</b><small>翻译引擎</small></span></button>
      </div>

      ${
        page.supported
          ? `<div class="card box hero ${page.active ? 'on' : ''}">
        <div class="line"><div><div class="t">翻译此页面</div>
          <div class="s">${esc(labelOf('displayMode'))} · ${esc(getLang(S.targetLang).name)}<kbd>Alt+A</kbd></div></div>
          <input type="checkbox" class="sw" data-act="togglePage" ${page.active ? 'checked' : ''} /></div>
      </div>
      <div class="card box">
        <div class="line"><span class="t">总在此网站开启</span>
          <input type="checkbox" class="sw" data-act="always" ${always ? 'checked' : ''} /></div>
        <div class="line"><span class="s">${esc(host)}</span>
          <button class="link" data-act="options" data-hash="sites">永不翻译 · ${S.neverSites.length} ${IC.chev}</button></div>
      </div>`
          : `<div class="warn">当前页面不支持网页翻译（浏览器内置页面，或安装扩展前已打开的页面，刷新后即可使用）。</div>`
      }

      <div class="card box quick">
        <textarea id="quickInput" rows="2" placeholder="输入文字，Enter 翻译（中英自动互译）">${esc(quick.text)}</textarea>
        ${quick.out ? `<div class="qout ${quick.err ? 'err' : ''}" id="quickOut">${esc(quick.out)}</div>` : ''}
      </div>

      <div class="card">
        ${
          recent.length
            ? `<div class="wl-head"><span>最近收藏</span><button class="link" data-go="words">全部 ${IC.chev}</button></div>${wordList(recent)}`
            : `<div class="empty">${IC.inbox}<div>暂无生词，在划词翻译面板中<br/>点击 ☆ 收藏单词</div></div>`
        }
      </div>
    </div>`;
  },

  settings() {
    const row = (key, icon, color, label, extra = '') =>
      `<button class="ri" data-pick="${key}"><span class="ic ${color}">${icon}</span>
        <span class="lb">${label}${extra}</span><span class="val">${esc(labelOf(key))}</span><span class="chev">${IC.chev}</span></button>`;
    const link = (act, hash, icon, label, val = '') =>
      `<button class="ri" data-act="${act}" data-hash="${hash}"><span class="ic">${icon}</span>
        <span class="lb">${label}</span><span class="val">${val}</span><span class="chev">${IC.chev}</span></button>`;
    return `${header('设置')}
    <div class="body">
      <div class="group">
        ${row('engine', IC.engine, '', '翻译引擎')}
      </div>
      <div class="group"><div class="gtitle">主功能设置</div>
        ${row('youtube', IC.video, 'c-red', '双语字幕')}
        ${row('displayMode', IC.translate, 'c-purple', '沉浸翻译')}
        ${row('transStyle', IC.style, 'c-purple', '译文样式')}
        ${row('selection', IC.cursor, 'c-blue', '划词翻译')}
        ${row('hover', IC.mouse, 'c-blue', '悬停翻译')}
        ${row('inputTranslate', IC.input, 'c-green', '输入框翻译')}
        ${row('floatBall', IC.ball, 'c-gold', '浮动按钮')}
      </div>
      <div class="group"><div class="gtitle">通用设置</div>
        ${row('targetLang', IC.globe, '', '翻译语言')}
        ${row('sourceLang', IC.detect, '', '网页语言')}
        ${link('options', 'sites', IC.sites, '网站规则', `${S.alwaysSites.length + S.neverSites.length} 条`)}
        ${link('options', 'engines', IC.key, 'API Key')}
        ${link('shortcuts', '', IC.keyboard, '配置快捷键')}
      </div>
      <div class="group">
        ${link('options', '', IC.sliders, '完整设置')}
        ${link('options', 'advanced', IC.info, '关于', 'v' + VERSION)}
      </div>
    </div>`;
  },

  words() {
    return `${header(`生词本 · ${words.length}`)}
    <div class="body"><div class="card">${
      words.length ? wordList(words) : `<div class="empty">${IC.inbox}<div>暂无生词</div></div>`
    }</div></div>`;
  },

  pick(key) {
    const p = PICKERS[key];
    const cur = p.get(S);
    const opts = p.options()
      .map(
        ([v, label, tag = '', sub = '']) => `<button class="opt ${v === cur ? 'on' : ''}" data-set="${esc(v)}">
          <span class="lb">${esc(label)} ${tag}${sub ? `<small>${esc(sub)}</small>` : ''}</span>
          <span class="ck">${IC.check}</span></button>`
      )
      .join('');
    return `${header(p.title)}
    <div class="body">
      <div class="opts">${opts}</div>
      ${p.hint ? `<div class="hint">${p.hint}</div>` : ''}
      ${p.footer ? `<div>${p.footer}</div>` : ''}
    </div>`;
  },
};

function renderRail() {
  const rb = (attrs, icon, tip, cls = '') => `<button class="rb ${cls}" ${attrs} data-tip="${tip}">${icon}</button>`;
  const base = view.split(':')[0];
  const pick = view.startsWith('pick:') ? view.slice(5) : '';
  $('#rail').innerHTML = [
    rb('data-act="close"', IC.close, '关闭', 'close'),
    rb('data-go="home"', IC.home, '首页', base === 'home' ? 'cur' : ''),
    rb('data-go="settings"', IC.gear, '设置', base === 'settings' ? 'cur' : ''),
    page.supported ? rb('data-act="togglePage"', IC.translate, page.active ? '显示原文' : '翻译此页面', page.active ? 'lit' : '') : '',
    rb('data-pick="selection"', IC.cursor, '划词翻译', pick === 'selection' ? 'cur' : ''),
    rb('data-pick="youtube"', IC.video, '双语字幕', pick === 'youtube' ? 'cur' : ''),
    rb('data-go="words"', IC.book + (words.length ? `<span class="badge">${words.length > 99 ? '99+' : words.length}</span>` : ''), '生词本', base === 'words' ? 'cur' : ''),
    '<div class="sp"></div>',
    rb('data-act="options"', IC.sliders, '完整设置'),
  ].join('');
}

function render() {
  const [name, arg] = view.split(':');
  const scroll = $('.body')?.scrollTop || 0;
  $('#main').innerHTML = (VIEWS[name] || VIEWS.home)(arg);
  if (name === 'settings') $('.body').scrollTop = scroll;
  renderRail();
}

function go(next, push = true) {
  if (next === view) return;
  if (push && next.startsWith('pick:')) history.push(view);
  else history = [];
  view = next;
  render();
}

// ---------------- 交互 ----------------
async function togglePage() {
  if (!page.supported) return;
  page.active = !page.active;
  render();
  await chrome.tabs.sendMessage(tab.id, { type: 'setPage', on: page.active }).catch(() => {});
}

async function quickTranslate(text) {
  quick = { text, out: '翻译中…', err: false };
  render();
  const isZh = /[一-鿿]/.test(text) && !/[぀-ヿ]/.test(text);
  const to = isZh && S.targetLang.startsWith('zh') ? 'en' : S.targetLang;
  const r = await chrome.runtime.sendMessage({ type: 'translate', texts: [text], to, from: 'auto' });
  quick = r?.ok ? { text, out: r.data[0], err: false } : { text, out: r?.error || '翻译失败', err: true };
  render();
  $('#quickInput')?.focus();
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button, input.sw');
  if (!b) return;
  const d = b.dataset;
  if (d.go) return go(d.go, false);
  if (d.pick) return go('pick:' + d.pick);
  if (d.set !== undefined) {
    const key = view.slice(5);
    const p = PICKERS[key];
    await save(p.set(d.set));
    p.after?.(d.set);
    render();
    return;
  }
  switch (d.act) {
    case 'close':
      return close();
    case 'back':
      view = history.pop() || 'home';
      return render();
    case 'togglePage':
      return togglePage();
    case 'always': {
      const set = new Set(S.alwaysSites);
      b.checked ? set.add(host) : set.delete(host);
      await save({ alwaysSites: [...set], neverSites: S.neverSites.filter((h) => h !== host) });
      if (b.checked && !page.active) await togglePage();
      return toast(b.checked ? '已加入总是翻译' : '已移出总是翻译');
    }
    case 'options':
      return openOptions(d.hash);
    case 'shortcuts':
      chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
      return MODE === 'popup' && window.close();
    case 'speak': {
      const w = words[+d.i];
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(w.w);
      u.lang = 'en-US';
      return speechSynthesis.speak(u);
    }
    case 'delWord': {
      const w = words[+d.i];
      words = words.filter((x) => x !== w);
      await chrome.storage.local.set({ words });
      render();
      return toast('已删除');
    }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.target.id === 'quickInput' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    const text = e.target.value.trim();
    if (text) quickTranslate(text);
  }
  if (e.key === 'Escape' && MODE === 'drawer') close();
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'quickInput') quick.text = e.target.value;
});

// 设置、生词在其他地方被修改时（如网页上的悬浮球、划词面板），同步刷新
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) S = await getSettings();
  if (changes.words) words = changes.words.newValue || [];
  if (document.activeElement?.id !== 'quickInput') render();
});
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'pageStateChanged' && sender.tab?.id === tab?.id) {
    page.active = !!msg.active;
    render();
  }
});

// ---------------- 启动 ----------------
tab = await resolveTab();
try {
  host = new URL(tab?.url || '').hostname;
} catch {}
await refreshPage();
if (view.startsWith('pick:')) history = ['settings'];
render();
