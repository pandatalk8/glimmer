// 后端翻译：会员权限、用量上限、各家翻译服务的调用（服务器持有 API Key，用户浏览器中不再设置）
import type { Plan } from './billing.ts';

// ---------- 引擎与所需会员等级 ----------
export const ENGINE_TIER: Record<string, 'premium' | 'premium_plus'> = {
  deepl: 'premium',
  microsoft: 'premium',
  openai: 'premium_plus',
  gemini: 'premium_plus',
  deepseek: 'premium_plus',
  claude: 'premium_plus',
};
export const LLM_ENGINES = new Set(['openai', 'gemini', 'deepseek', 'claude']);
export const MT_ENGINES = new Set(['deepl', 'microsoft']);
export const MAX_TEXTS = 100; // 单次请求上限，防止滥用
export const MAX_CHARS = 20_000;

// ---------- AI 点数与字符额度（成本测算见 docs/backend.md 第十节） ----------
// 1 点 = Claude Haiku 的 1 个 Token；其他模型按成本折算，贵的模型一个 Token 算多点。
// 每月点数按“用满也不亏”设定：任何引擎用满的成本约 $4.2，低于 Premium+ 每月净收入 $5.5
export const ENGINE_WEIGHT: Record<string, number> = { claude: 1, deepseek: 2.5, openai: 3.4, gemini: 4.6 };
export const DEFAULT_POINT_LIMIT = 15_000_000; // Premium+ 每月 AI 点数
// DeepL（$25 / 百万字符）、Microsoft（约 $10 / 百万字符）合计的每月字符上限，用完后扩展自动改用 Google
export const DEFAULT_CHAR_LIMIT: Record<'premium' | 'premium_plus', number> = { premium: 100_000, premium_plus: 200_000 };
// 首发暂不开放的引擎（决策 D4）：成本最高、或尚未配置 Key；可用环境变量 DISABLED_ENGINES 调整
export const DEFAULT_DISABLED_ENGINES = ['openai', 'gemini'];
export const ENGINE_NAME: Record<string, string> = {
  deepl: 'DeepL', microsoft: 'Microsoft 翻译', openai: 'OpenAI GPT', gemini: 'Google Gemini', deepseek: 'DeepSeek', claude: 'Claude',
};

/** 本次大模型调用消耗的 AI 点数 */
export const pointsFor = (engine: string, tokens: number) => Math.ceil(tokens * (ENGINE_WEIGHT[engine] ?? 1));

/** “1500 万”“10 万”这样的中文数量 */
export function cnNum(n: number) {
  if (n >= 1e8) return `${+(n / 1e8).toFixed(1)} 亿`;
  if (n >= 1e4) return `${+(n / 1e4).toFixed(1)} 万`;
  return String(n);
}

const RANK: Record<Plan, number> = { free: 0, premium: 1, premium_plus: 2 };

export interface AccessError {
  status: number;
  code: 'unknown_engine' | 'upgrade' | 'quota' | 'too_large' | 'unavailable';
  error: string;
  requiredPlan?: string;
}

export interface Usage {
  points: number;
  chars: number;
}
export interface Limits {
  points: number; // Premium+ 每月 AI 点数
  chars: number; // 当前等级的每月 DeepL / Microsoft 字符上限
  disabled?: Set<string>;
}

const PLAN_NAME: Record<string, string> = { premium: 'Premium', premium_plus: 'Premium+' };

/** 当前等级的每月字符上限 */
export const charLimitFor = (plan: Plan, limits: Partial<Record<'premium' | 'premium_plus', number>> = {}) =>
  plan === 'premium_plus' ? limits.premium_plus ?? DEFAULT_CHAR_LIMIT.premium_plus : limits.premium ?? DEFAULT_CHAR_LIMIT.premium;

/** 检查能否使用该引擎；返回 null 表示允许 */
export function checkAccess(plan: Plan, engine: string, used: Usage, limits: Limits, texts: string[] = []): AccessError | null {
  const tier = ENGINE_TIER[engine];
  if (!tier) return { status: 400, code: 'unknown_engine', error: '不支持的翻译引擎：' + engine };
  if (limits.disabled?.has(engine)) {
    return { status: 503, code: 'unavailable', error: `${ENGINE_NAME[engine] || engine} 即将开放，暂时请使用其他翻译引擎` };
  }
  if (RANK[plan] < RANK[tier]) {
    return {
      status: 403,
      code: 'upgrade',
      requiredPlan: tier,
      error: `该翻译引擎需要 ${PLAN_NAME[tier]} 会员，请升级后使用`,
    };
  }
  if (LLM_ENGINES.has(engine) && used.points >= limits.points) {
    return { status: 429, code: 'quota', error: `本月 AI 点数（${cnNum(limits.points)}点）已用完，下月 1 日恢复` };
  }
  if (MT_ENGINES.has(engine) && used.chars >= limits.chars) {
    return { status: 429, code: 'quota', error: `本月 DeepL / Microsoft 翻译额度（${cnNum(limits.chars)}字符）已用完，下月 1 日恢复` };
  }
  const chars = texts.reduce((n, t) => n + String(t).length, 0);
  if (texts.length > MAX_TEXTS || chars > MAX_CHARS) {
    return { status: 413, code: 'too_large', error: '单次翻译内容过多' };
  }
  return null;
}

export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7); // UTC 自然月

// ---------- 语言（与扩展 src/shared/languages.js 保持一致） ----------
const LANG: Record<string, { en: string; deepl?: string; ms?: string }> = {
  'zh-CN': { en: 'Simplified Chinese', deepl: 'ZH-HANS', ms: 'zh-Hans' },
  'zh-TW': { en: 'Traditional Chinese', deepl: 'ZH-HANT', ms: 'zh-Hant' },
  en: { en: 'English', deepl: 'EN-US', ms: 'en' },
  ja: { en: 'Japanese', deepl: 'JA', ms: 'ja' },
  ko: { en: 'Korean', deepl: 'KO', ms: 'ko' },
  fr: { en: 'French', deepl: 'FR', ms: 'fr' },
  de: { en: 'German', deepl: 'DE', ms: 'de' },
  es: { en: 'Spanish', deepl: 'ES', ms: 'es' },
  pt: { en: 'Portuguese', deepl: 'PT-BR', ms: 'pt' },
  it: { en: 'Italian', deepl: 'IT', ms: 'it' },
  ru: { en: 'Russian', deepl: 'RU', ms: 'ru' },
  ar: { en: 'Arabic', deepl: 'AR', ms: 'ar' },
  th: { en: 'Thai', ms: 'th' },
  vi: { en: 'Vietnamese', ms: 'vi' },
  id: { en: 'Indonesian', deepl: 'ID', ms: 'id' },
  tr: { en: 'Turkish', deepl: 'TR', ms: 'tr' },
  nl: { en: 'Dutch', deepl: 'NL', ms: 'nl' },
  pl: { en: 'Polish', deepl: 'PL', ms: 'pl' },
  uk: { en: 'Ukrainian', deepl: 'UK', ms: 'uk' },
};
const lang = (c: string) => LANG[c] || { en: c };

// ---------- 大模型批量协议（由扩展的 llm.js 迁移而来） ----------
export const SYSTEM_PROMPT =
  'You are a professional translator. Translate the text into {{to}} accurately and fluently, ' +
  'preserving meaning, tone, terminology, numbers, URLs and proper nouns. ' +
  'Output only the translation without any explanation.';

export function pack(texts: string[], maxChars = 2400, maxItems = 16): number[][] {
  const groups: number[][] = [];
  let cur: number[] = [];
  let size = 0;
  texts.forEach((t, i) => {
    if (cur.length && (size + t.length > maxChars || cur.length >= maxItems)) {
      groups.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(i);
    size += t.length;
  });
  if (cur.length) groups.push(cur);
  return groups;
}

export function parseBatch(raw: string, n: number): string[] | null {
  const s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  const tryParse = (str: string) => {
    try {
      const j = JSON.parse(str);
      const arr = Array.isArray(j) ? j : j?.translations || j?.t;
      if (Array.isArray(arr) && arr.length === n) return arr.map((x: unknown) => String(x ?? ''));
    } catch { /* 尝试下一种 */ }
    return null;
  };
  return tryParse(s) || tryParse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)) || tryParse(s.slice(s.indexOf('['), s.lastIndexOf(']') + 1));
}

export interface ChatResult {
  text: string;
  tokens: number;
}
export type Chat = (system: string, user: string) => Promise<ChatResult>;

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    })
  );
  return out;
}

/** 用一个 chat 函数批量翻译，返回译文与消耗的 Token */
export async function llmTranslate(chat: Chat, texts: string[], to: string): Promise<{ out: string[]; tokens: number }> {
  const toName = lang(to).en;
  const system = SYSTEM_PROMPT.replaceAll('{{to}}', toName);
  let tokens = 0;
  const single = async (t: string) => {
    const r = await chat(system, t);
    tokens += r.tokens;
    return r.text.trim();
  };
  if (texts.length === 1) return { out: [await single(texts[0])], tokens };
  const out = new Array<string>(texts.length);
  await mapLimit(pack(texts), 3, async (idxs) => {
    const segs = idxs.map((i) => texts[i]);
    if (segs.length === 1) {
      out[idxs[0]] = await single(segs[0]);
      return;
    }
    const user =
      `Translate each string in the JSON array below into ${toName}. ` +
      `Return ONLY a JSON object of the form {"translations": [...]} containing exactly ${segs.length} ` +
      'translated strings in the same order. Do not merge, split or omit items.\n\n' +
      JSON.stringify(segs);
    const r = await chat(system, user);
    tokens += r.tokens;
    const parsed = parseBatch(r.text, segs.length) || (await mapLimit(segs, 3, single)); // 解析失败逐条翻译
    idxs.forEach((i, k) => (out[i] = parsed[k]));
  });
  return { out, tokens };
}

// ---------- 各家服务（服务器端 API Key） ----------
export class ProviderError extends Error {
  constructor(message: string, public status = 502) {
    super(message);
  }
}

const key = (name: string, label: string) => {
  const v = Deno.env.get(name);
  if (!v) throw new ProviderError(`服务端尚未配置 ${label} 的 API Key（${name}）`, 503);
  return v;
};

async function post(url: string, headers: Record<string, string>, body: unknown, label: string) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
  const text = await res.text();
  if (!res.ok) throw new ProviderError(`${label} 错误 ${res.status}：${text.slice(0, 200)}`, res.status === 429 ? 503 : 502);
  return JSON.parse(text);
}

function openaiCompatible(base: string, apiKey: string, model: string, label: string): Chat {
  return async (system, user) => {
    const body: Record<string, unknown> = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.3 };
    let data;
    try {
      data = await post(`${base}/chat/completions`, { Authorization: 'Bearer ' + apiKey }, body, label);
    } catch (e) {
      if (!/temperature/i.test((e as Error).message)) throw e;
      delete body.temperature; // 部分推理模型不支持自定义 temperature
      data = await post(`${base}/chat/completions`, { Authorization: 'Bearer ' + apiKey }, body, label);
    }
    return { text: data?.choices?.[0]?.message?.content ?? '', tokens: data?.usage?.total_tokens ?? 0 };
  };
}

export function chatFor(engine: string): Chat {
  if (engine === 'openai')
    return openaiCompatible('https://api.openai.com/v1', key('OPENAI_API_KEY', 'OpenAI'), Deno.env.get('OPENAI_MODEL') || 'gpt-4.1-mini', 'OpenAI');
  if (engine === 'deepseek')
    return openaiCompatible('https://api.deepseek.com', key('DEEPSEEK_API_KEY', 'DeepSeek'), Deno.env.get('DEEPSEEK_MODEL') || 'deepseek-flash', 'DeepSeek');
  if (engine === 'gemini') {
    const apiKey = key('GEMINI_API_KEY', 'Gemini');
    const model = Deno.env.get('GEMINI_MODEL') || 'gemini-2.5-flash';
    return async (system, user) => {
      const data = await post(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { 'x-goog-api-key': apiKey },
        { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { temperature: 0.3 } },
        'Gemini'
      );
      const parts = data?.candidates?.[0]?.content?.parts || [];
      return {
        text: parts.filter((p: { thought?: boolean }) => !p.thought).map((p: { text?: string }) => p.text || '').join(''),
        tokens: data?.usageMetadata?.totalTokenCount ?? 0,
      };
    };
  }
  if (engine === 'claude') {
    const apiKey = key('ANTHROPIC_API_KEY', 'Claude');
    const model = Deno.env.get('CLAUDE_MODEL') || 'claude-haiku-5-5';
    return async (system, user) => {
      const data = await post(
        'https://api.anthropic.com/v1/messages',
        { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        { model, max_tokens: 8192, system, temperature: 0.3, messages: [{ role: 'user', content: user }] },
        'Claude'
      );
      const text = (data.content || []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('');
      return { text, tokens: (data?.usage?.input_tokens ?? 0) + (data?.usage?.output_tokens ?? 0) };
    };
  }
  throw new ProviderError('不支持的引擎：' + engine, 400);
}

export async function deeplTranslate(texts: string[], from: string, to: string): Promise<string[]> {
  const apiKey = key('DEEPL_API_KEY', 'DeepL');
  const base = Deno.env.get('DEEPL_API_URL') || (apiKey.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com');
  const out: string[] = [];
  for (let i = 0; i < texts.length; i += 50) {
    const body: Record<string, unknown> = { text: texts.slice(i, i + 50), target_lang: lang(to).deepl || to.toUpperCase() };
    const src = from && from !== 'auto' ? lang(from).deepl?.split('-')[0] : undefined;
    if (src) body.source_lang = src;
    const data = await post(`${base}/v2/translate`, { Authorization: 'DeepL-Auth-Key ' + apiKey }, body, 'DeepL');
    out.push(...data.translations.map((t: { text: string }) => t.text));
  }
  return out;
}

export async function microsoftTranslate(texts: string[], from: string, to: string): Promise<string[]> {
  const apiKey = key('AZURE_TRANSLATOR_KEY', 'Microsoft');
  const headers: Record<string, string> = { 'Ocp-Apim-Subscription-Key': apiKey };
  const region = Deno.env.get('AZURE_TRANSLATOR_REGION');
  if (region) headers['Ocp-Apim-Subscription-Region'] = region;
  const src = from && from !== 'auto' ? lang(from).ms : '';
  const out: string[] = [];
  for (let i = 0; i < texts.length; i += 50) {
    const url = 'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0' + (src ? `&from=${src}` : '') + `&to=${lang(to).ms || to}`;
    const data = await post(url, headers, texts.slice(i, i + 50).map((t) => ({ Text: t })), 'Microsoft');
    out.push(...data.map((d: { translations: { text: string }[] }) => d?.translations?.[0]?.text || ''));
  }
  return out;
}
