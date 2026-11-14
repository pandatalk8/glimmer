// 设置的默认值与读写。所有页面（background / popup / options）共用。
export const ENGINES = [
  { id: 'google', name: 'Google 翻译', type: 'mt', free: true },
  { id: 'microsoft', name: 'Microsoft 翻译', type: 'mt', needKey: true },
  { id: 'deepl', name: 'DeepL', type: 'mt', needKey: true },
  { id: 'openai', name: 'OpenAI GPT', type: 'llm', needKey: true },
  { id: 'gemini', name: 'Google Gemini', type: 'llm', needKey: true },
  { id: 'deepseek', name: 'DeepSeek', type: 'llm', needKey: true },
  { id: 'claude', name: 'Anthropic Claude', type: 'llm', needKey: true },
  { id: 'custom', name: '自定义 (OpenAI 兼容)', type: 'llm', needKey: false },
];

export const DEFAULT_PROMPT =
  'You are a professional translator. Translate the text into {{to}} accurately and fluently, ' +
  'preserving meaning, tone, terminology, numbers, URLs and proper nouns. ' +
  'Output only the translation without any explanation.';

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
  llm: { prompt: DEFAULT_PROMPT, temperature: 0.3 },
  engines: {
    google: {},
    microsoft: { apiKey: '', region: '' },
    deepl: { apiKey: '', apiUrl: '' },
    openai: { apiKey: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
    gemini: { apiKey: '', model: 'gemini-2.5-flash' },
    deepseek: { apiKey: '', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
    claude: { apiKey: '', model: 'claude-haiku-5-5' },
    custom: { apiKey: '', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
  },
};

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
  return deepMerge(DEFAULT_SETTINGS, settings || {});
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
