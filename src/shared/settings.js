// 设置的默认值与读写。所有页面（background / popup / options）共用。
// tier：使用该引擎所需的会员等级。除 Google 外，所有引擎都由微光翻译后端调用，用户浏览器中不设置任何 API Key
export const ENGINES = [
  { id: 'google', name: 'Google 翻译', type: 'mt', tier: 'free' },
  { id: 'deepl', name: 'DeepL', type: 'mt', tier: 'premium' },
  { id: 'microsoft', name: 'Microsoft 翻译', type: 'mt', tier: 'premium' },
  { id: 'openai', name: 'OpenAI GPT', type: 'llm', tier: 'premium_plus' },
  { id: 'gemini', name: 'Google Gemini', type: 'llm', tier: 'premium_plus' },
  { id: 'deepseek', name: 'DeepSeek', type: 'llm', tier: 'premium_plus' },
  { id: 'claude', name: 'Anthropic Claude', type: 'llm', tier: 'premium_plus' },
];

// 会员等级
export const PLAN_RANK = { free: 0, premium: 1, premium_plus: 2 };
export const PLAN_NAME = { free: '免费版', premium: 'Premium', premium_plus: 'Premium+' };
export const FREE_WORD_LIMIT = 100; // 免费版生词本上限
export const canUse = (plan, engine) => {
  const e = ENGINES.find((x) => x.id === engine);
  return !!e && (PLAN_RANK[plan || 'free'] ?? 0) >= PLAN_RANK[e.tier];
};

export const DEFAULT_SETTINGS = {
  engine: 'google',
  sourceLang: 'auto',
  targetLang: 'zh-CN',
  displayMode: 'bilingual', // bilingual | translation
  transStyle: 'none', // none | underline | dashed | highlight | border | weak | blur | italic
  transColor: '#8b5cf6',
  floatBall: true,
  selection: { enabled: true, trigger: 'icon' }, // icon | auto
  hover: { enabled: true, key: 'Alt' }, // Alt | Control | Shift
  inputTranslate: { enabled: false, targetLang: 'en' },
  youtube: { enabled: true },
  alwaysSites: [],
  neverSites: [],
};

// 旧版本保存在设置中的 API Key、模型、提示词：已不再支持，读取时丢弃，下次保存即从存储中清除
const LEGACY_KEYS = ['engines', 'llm'];

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, over) {
  if (!isObj(over)) return structuredClone(base);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const out = deepMerge(DEFAULT_SETTINGS, settings || {});
  for (const k of LEGACY_KEYS) delete out[k];
  if (!ENGINES.some((e) => e.id === out.engine)) out.engine = 'google'; // 例如已移除的“自定义”引擎
  return out;
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = deepMerge(cur, patch);
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function hostMatches(host, list) {
  return (list || []).some((p) => host === p || host.endsWith('.' + p));
}
