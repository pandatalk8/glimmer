import { getSettings, saveSettings, ENGINES, FREE_WORD_LIMIT, PLAN_RANK } from '../shared/settings.js';
import { LANGUAGES } from '../shared/languages.js';
import { google } from './engines/mt.js';
import { cacheGetMany, cacheSetMany, cacheClear } from './cache.js';
import * as account from './account.js';

account.watchBillingReturn();
account.watchWordSync();

// 旧版本在设置中保存的 API Key、模型与提示词已不再使用：安装或刷新插件时从存储中清除
chrome.runtime.onInstalled.addListener(() => saveSettings({}).catch(() => {}));

// Google 在浏览器中直接调用（免费）；其余引擎全部经由微光翻译后端，按会员等级开放
async function runEngine(engineId, texts, opts) {
  if (engineId === 'google') return google(texts, opts);
  return account.backendTranslate({ engine: engineId, texts, from: opts.from, to: opts.to });
}

function cacheKey(engineId, from, to, text) {
  return [engineId, '', from || 'auto', to, text].join('\u0001');
}

// 主翻译入口：去重 + 缓存 + 调用引擎
async function translate({ texts, from, to, engine, noCache }) {
  const settings = await getSettings();
  const engineId = engine || settings.engine;
  const target = to || settings.targetLang;
  const source = from || settings.sourceLang;
  if (!ENGINES.some((e) => e.id === engineId)) throw new Error('未知翻译引擎：' + engineId);

  const keys = texts.map((t) => cacheKey(engineId, source, target, t));
  const cached = noCache ? texts.map(() => undefined) : await cacheGetMany(keys);
  const missing = [...new Set(texts.filter((_, i) => cached[i] === undefined))];

  const fresh = new Map();
  if (missing.length) {
    const res = await runEngine(engineId, missing, { from: source, to: target });
    missing.forEach((t, i) => fresh.set(t, res[i]));
    cacheSetMany(missing.map((t) => [cacheKey(engineId, source, target, t), fresh.get(t)]));
  }
  return texts.map((t, i) => cached[i] ?? fresh.get(t) ?? '');
}

// ---------- 生词本：chrome.storage.local 的 words 数组，最新在前 ----------
// 每项 { w, t, url, ts, m, u }：u 为最后修改时间，用于云同步合并；删除记入 wordsTombstones
const MAX_WORDS = 5000;
const wordKey = (w) => w.trim().toLowerCase();

async function getWords() {
  return (await chrome.storage.local.get('words')).words || [];
}

async function toggleWord({ word, trans, url }) {
  const words = await getWords();
  const key = wordKey(word);
  const i = words.findIndex((w) => wordKey(w.w) === key);
  const now = Date.now();
  if (i >= 0) {
    words.splice(i, 1);
    await account.markWordDeleted(key, now);
    await chrome.storage.local.set({ words });
    return { saved: false, count: words.length };
  }
  // 免费版生词本上限
  const plan = (await chrome.storage.local.get('account')).account?.plan || 'free';
  if (PLAN_RANK[plan] < PLAN_RANK.premium && words.length >= FREE_WORD_LIMIT) {
    const e = new Error(`免费版生词本最多 ${FREE_WORD_LIMIT} 个，升级 Premium 不限数量`);
    e.code = 'upgrade';
    throw e;
  }
  words.unshift({ w: word.trim(), t: trans || '', url: url || '', ts: now, m: false, u: now });
  if (words.length > MAX_WORDS) words.length = MAX_WORDS;
  await chrome.storage.local.set({ words });
  return { saved: true, count: words.length };
}

const handlers = {
  translate,
  tabInfo: (_msg, sender) => (sender.tab ? { id: sender.tab.id, url: sender.tab.url } : null),
  toggleWord,
  // 账户与订阅
  accountState: () => account.accountState(),
  accountRefresh: async () => {
    await account.refreshAccount();
    return account.accountState();
  },
  accountSignUp: (m) => account.signUp(m),
  accountSignIn: (m) => account.signIn(m),
  accountSignOut: () => account.signOut(),
  accountOAuth: (m) => account.signInWithOAuth(m),
  devBackend: (m) => account.devBackend(m),
  accountReset: (m) => account.resetPassword(m),
  billingCheckout: (m, sender) => account.checkout(m, account.originOf(sender)),
  billingPortal: (_m, sender) => account.openPortal(account.originOf(sender)),
  hasWord: async ({ word }) => (await getWords()).some((w) => wordKey(w.w) === wordKey(word)),
  getSettings: () => getSettings(),
  saveSettings: ({ patch }) => saveSettings(patch),
  meta: async () => ({ engines: ENGINES, languages: LANGUAGES, plan: (await chrome.storage.local.get('account')).account?.plan || 'free' }),
  clearCache: () => cacheClear().then(() => true),
  openOptions: () => chrome.runtime.openOptionsPage(),
  testEngine: async ({ engine }) => {
    const t0 = Date.now();
    const [r] = await translate({
      texts: ['Hello, world! This is a translation test.'],
      engine,
      from: 'en',
      to: 'zh-CN',
      noCache: true,
    });
    return { text: r, ms: Date.now() - t0 };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const h = handlers[msg?.type];
  if (!h) return false;
  Promise.resolve()
    .then(() => h(msg, sender))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
  return true;
});

// ---------- 工具栏图标：在网页内开关侧面板 ----------
// 安装扩展前已打开的网页没有内容脚本，点击时按需注入，免去刷新
async function ensureContent(tabId) {
  try {
    if (await chrome.tabs.sendMessage(tabId, { type: 'ping' }, { frameId: 0 })) return true;
  } catch {}
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['src/content/content.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/content.js'] });
    return true;
  } catch {
    return false; // chrome:// 等浏览器内置页面禁止注入
  }
}

// ---------- 当前加载的代码版本 ----------
// 从文件夹加载的开发版：磁盘上的文件更新后，Chrome 里运行的后台与网页脚本仍是旧的，直到点击“刷新”。
// 加载时为关键文件算一个指纹并记下；之后再算一次，不同即说明需要刷新插件。
const BUILD_FILES = [
  'build.json', 'manifest.json',
  'src/background/index.js', 'src/background/account.js', 'src/background/cache.js',
  'src/background/engines/mt.js', 'src/background/engines/util.js',
  'src/content/content.js', 'src/content/content.css', 'src/content/ui.css',
  'src/content/youtube.js', 'src/content/yt-hook.js',
  'src/shared/settings.js', 'src/shared/languages.js', 'src/shared/config.js', 'src/shared/build.js',
  'panel/panel.html', 'panel/panel.js', 'panel/panel.css',
  'options/options.html', 'options/options.js', 'options/options.css', 'styles/theme.css',
];

async function readText(path) {
  try {
    const r = await fetch(chrome.runtime.getURL(path), { cache: 'no-store' });
    return r.ok ? await r.text() : '';
  } catch {
    return '';
  }
}

async function codeFingerprint() {
  const parts = await Promise.all(BUILD_FILES.map(readText));
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('\u0000')));
  return [...new Uint8Array(hash)].slice(0, 4).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function readBuild() {
  try {
    return JSON.parse(await readText('build.json'));
  } catch {
    return null; // 没有 build.json：未生成过，只显示版本号与指纹
  }
}

async function snapshotBuild() {
  const loadedBuild = { fp: await codeFingerprint(), build: await readBuild(), at: Date.now() };
  await chrome.storage.local.set({ loadedBuild });
  return loadedBuild;
}
chrome.runtime.onInstalled.addListener(snapshotBuild); // 首次加载与每次点击“刷新”
chrome.runtime.onStartup.addListener(snapshotBuild); // 浏览器重启

async function buildInfo() {
  let { loadedBuild } = await chrome.storage.local.get('loadedBuild');
  if (!loadedBuild) loadedBuild = await snapshotBuild();
  const fp = await codeFingerprint();
  return {
    version: chrome.runtime.getManifest().version,
    loaded: loadedBuild,
    disk: { fp, build: await readBuild() },
    stale: fp !== loadedBuild.fp,
  };
}
handlers.buildInfo = buildInfo;
// 打开扩展管理页并定位到本插件，方便点击“刷新”
handlers.openExtensionsPage = () => chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id }).then(() => true);

const PANEL = 'panel/panel.html';

// 只有普通网页（http / https / 本地文件）能嵌入侧面板；
// 插件自己的设置页、chrome:// 页面、新标签页等不能嵌入，拿不到 URL 的也按不能处理
const canEmbed = (url) => /^(https?|file):/i.test(url || '');

// 提前为每个标签页设定点击图标时的行为：能嵌入的网页触发 onClicked 打开抽屉，
// 其余直接由 Chrome 打开弹窗。必须提前设定：点击后再异步判断，用户手势会过期，openPopup 会失败，表现为“点了没反应”
function syncPopup(tabId, url) {
  return chrome.action.setPopup({ tabId, popup: canEmbed(url) ? '' : PANEL }).catch(() => {});
}

async function syncAllTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((t) => syncPopup(t.id, t.url || t.pendingUrl)));
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'loading' || info.url) syncPopup(tabId, info.url || tab.url || tab.pendingUrl);
});
chrome.tabs.onCreated.addListener((tab) => syncPopup(tab.id, tab.url || tab.pendingUrl));
chrome.runtime.onStartup.addListener(syncAllTabs);
chrome.runtime.onInstalled.addListener(syncAllTabs); // 安装或刷新插件时，给已打开的标签页补设

async function onActionClick(tab) {
  if (!tab?.id) return 'none';
  if (await ensureContent(tab.id)) {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggleDrawer' }, { frameId: 0 });
    return 'drawer';
  }
  // 网页地址正常但禁止注入（如 Chrome 应用商店、未允许访问的本地文件）：
  // 此标签页改为弹窗模式，下次点击直接弹出；这一次手势已过期，用独立小窗口打开面板，保证点击有反应
  await chrome.action.setPopup({ tabId: tab.id, popup: PANEL });
  try {
    await chrome.action.openPopup();
    return 'popup';
  } catch {
    await chrome.windows.create({ url: chrome.runtime.getURL(PANEL), type: 'popup', width: 420, height: 640 });
    return 'window';
  }
}
chrome.action.onClicked.addListener(onActionClick);
self.__glimmerActionClick = onActionClick; // 供端到端测试调用
self.__glimmerCanEmbed = canEmbed;

// ---------- 右键菜单 & 快捷键 ----------
chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'toggle-page', title: '翻译 / 还原此页面', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'translate-selection', title: '翻译“%s”', contexts: ['selection'] });
  });
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

function sendToTab(tabId, payload) {
  chrome.tabs.sendMessage(tabId, payload).catch(() => {});
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'toggle-page') sendToTab(tab.id, { type: 'togglePage' });
  if (info.menuItemId === 'translate-selection')
    sendToTab(tab.id, { type: 'translateSelection', text: info.selectionText });
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  tab = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab?.id) return;
  if (command === 'toggle-translate') sendToTab(tab.id, { type: 'togglePage' });
  if (command === 'toggle-display-mode') {
    const s = await getSettings();
    await saveSettings({ displayMode: s.displayMode === 'bilingual' ? 'translation' : 'bilingual' });
  }
});
