import { getSettings, saveSettings, ENGINES } from '../shared/settings.js';
import { LANGUAGES } from '../shared/languages.js';
import { google, microsoft, deepl } from './engines/mt.js';
import { llmTranslate } from './engines/llm.js';
import { cacheGetMany, cacheSetMany, cacheClear } from './cache.js';

const MT = { google, microsoft, deepl };

async function runEngine(engineId, texts, opts) {
  if (MT[engineId]) return MT[engineId](texts, opts);
  return llmTranslate(engineId, texts, opts);
}

function cacheKey(engineId, cfg, from, to, text) {
  return [engineId, cfg?.model || '', from || 'auto', to, text].join('\u0001');
}

// 主翻译入口：去重 + 缓存 + 调用引擎
async function translate({ texts, from, to, engine, noCache }) {
  const settings = await getSettings();
  const engineId = engine || settings.engine;
  const target = to || settings.targetLang;
  const source = from || settings.sourceLang;
  const cfg = settings.engines[engineId] || {};
  if (!ENGINES.some((e) => e.id === engineId)) throw new Error('未知翻译引擎：' + engineId);

  const keys = texts.map((t) => cacheKey(engineId, cfg, source, target, t));
  const cached = noCache ? texts.map(() => undefined) : await cacheGetMany(keys);
  const missing = [...new Set(texts.filter((_, i) => cached[i] === undefined))];

  const fresh = new Map();
  if (missing.length) {
    const res = await runEngine(engineId, missing, { from: source, to: target, cfg, settings });
    missing.forEach((t, i) => fresh.set(t, res[i]));
    cacheSetMany(missing.map((t) => [cacheKey(engineId, cfg, source, target, t), fresh.get(t)]));
  }
  return texts.map((t, i) => cached[i] ?? fresh.get(t) ?? '');
}

// ---------- 生词本：chrome.storage.local 的 words 数组，最新在前 ----------
const MAX_WORDS = 5000;
const wordKey = (w) => w.trim().toLowerCase();

async function getWords() {
  return (await chrome.storage.local.get('words')).words || [];
}

async function toggleWord({ word, trans, url }) {
  const words = await getWords();
  const key = wordKey(word);
  const i = words.findIndex((w) => wordKey(w.w) === key);
  if (i >= 0) {
    words.splice(i, 1);
    await chrome.storage.local.set({ words });
    return { saved: false, count: words.length };
  }
  words.unshift({ w: word.trim(), t: trans || '', url: url || '', ts: Date.now() });
  if (words.length > MAX_WORDS) words.length = MAX_WORDS;
  await chrome.storage.local.set({ words });
  return { saved: true, count: words.length };
}

const handlers = {
  translate,
  tabInfo: (_msg, sender) => (sender.tab ? { id: sender.tab.id, url: sender.tab.url } : null),
  toggleWord,
  hasWord: async ({ word }) => (await getWords()).some((w) => wordKey(w.w) === wordKey(word)),
  getSettings: () => getSettings(),
  saveSettings: ({ patch }) => saveSettings(patch),
  meta: () => ({ engines: ENGINES, languages: LANGUAGES }),
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

async function onActionClick(tab) {
  if (!tab?.id) return 'none';
  if (await ensureContent(tab.id)) {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggleDrawer' }, { frameId: 0 });
    return 'drawer';
  }
  // 无法嵌入面板的页面：本标签页改用弹窗形态
  await chrome.action.setPopup({ tabId: tab.id, popup: 'panel/panel.html' });
  try {
    await chrome.action.openPopup();
    return 'popup';
  } catch {
    return 'none';
  }
}
chrome.action.onClicked.addListener(onActionClick);
self.__glimmerActionClick = onActionClick; // 供端到端测试调用

// 标签页跳转到新网页时，恢复为“点击图标开关侧面板”
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') chrome.action.setPopup({ tabId, popup: '' }).catch(() => {});
});

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
