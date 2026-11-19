// 翻译代理：DeepL / Microsoft（Premium）与 GPT、Gemini、DeepSeek、Claude（Premium+）都经由这里，
// 服务器持有各家 API Key；校验会员等级与本月 AI 用量，原子累加用量。
// POST { engine, texts: string[], from, to }，需要登录
import { corsHeaders, json } from '../_shared/http.ts';
import { adminClient, userFromRequest } from '../_shared/clients.ts';
import type { Plan } from '../_shared/billing.ts';
import {
  checkAccess, chatFor, deeplTranslate, DEFAULT_TOKEN_LIMIT, LLM_ENGINES, llmTranslate, microsoftTranslate, monthKey, ProviderError,
} from '../_shared/translate.ts';

const LIMIT = Number(Deno.env.get('TOKEN_LIMIT_MONTHLY')) || DEFAULT_TOKEN_LIMIT;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: '仅支持 POST' }, 405);

  const user = await userFromRequest(req);
  if (!user) return json({ error: '请先登录', code: 'login' }, 401);

  const { engine = '', texts = [], from = 'auto', to = 'zh-CN' } = await req.json().catch(() => ({}));
  if (!Array.isArray(texts) || !texts.length) return json({ error: '没有要翻译的内容' }, 400);

  const db = adminClient();
  const month = monthKey();
  const [{ data: profile }, { data: usage }] = await Promise.all([
    db.from('profiles').select('plan').eq('id', user.id).single(),
    db.from('usage_monthly').select('tokens').eq('user_id', user.id).eq('month', month).maybeSingle(),
  ]);
  const plan = (profile?.plan || 'free') as Plan;
  const used = Number(usage?.tokens || 0);
  const denied = checkAccess(plan, engine, used, LIMIT, texts.map(String));
  if (denied) return json({ ...denied, usage: { tokens: used, limit: LIMIT, month } }, denied.status);

  try {
    let out: string[];
    let tokens = 0;
    let chars = 0;
    if (LLM_ENGINES.has(engine)) {
      ({ out, tokens } = await llmTranslate(chatFor(engine), texts.map(String), to));
    } else {
      chars = texts.reduce((n: number, t: string) => n + String(t).length, 0);
      out = engine === 'deepl' ? await deeplTranslate(texts, from, to) : await microsoftTranslate(texts, from, to);
    }
    const { data: total, error } = await db.rpc('add_usage', { p_user: user.id, p_month: month, p_tokens: tokens, p_chars: chars });
    if (error) console.error('add_usage', error);
    return json({ translations: out, usage: { tokens: Number(total ?? used + tokens), limit: LIMIT, month } });
  } catch (e) {
    const status = e instanceof ProviderError ? e.status : 500;
    console.error('translate', engine, e);
    return json({ error: (e as Error).message || '翻译失败', code: status === 503 ? 'unavailable' : 'provider' }, status);
  }
});
