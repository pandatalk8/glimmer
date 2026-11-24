// 翻译代理：DeepL / Microsoft（Premium）与 GPT、Gemini、DeepSeek、Claude（Premium+）都经由这里，
// 服务器持有各家 API Key；校验会员等级、本月 AI 点数与 DeepL / Microsoft 字符额度，原子累加用量。
// POST { engine, texts: string[], from, to }，需要登录
import { corsHeaders, json } from '../_shared/http.ts';
import { adminClient, userFromRequest } from '../_shared/clients.ts';
import type { Plan } from '../_shared/billing.ts';
import {
  charLimitFor, checkAccess, chatFor, deeplTranslate, DEFAULT_POINT_LIMIT, disabledEngines, LLM_ENGINES, llmTranslate,
  microsoftTranslate, monthKey, pointsFor, ProviderError,
} from '../_shared/translate.ts';

const num = (name: string) => Number(Deno.env.get(name)) || undefined;
const POINT_LIMIT = num('POINT_LIMIT_MONTHLY') || DEFAULT_POINT_LIMIT;
const CHAR_LIMITS = { premium: num('CHAR_LIMIT_PREMIUM'), premium_plus: num('CHAR_LIMIT_PLUS') };
const DISABLED = disabledEngines(Deno.env.get('DISABLED_ENGINES'));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: '仅支持 POST' }, 405);

  const user = await userFromRequest(req);
  if (!user) return json({ error: '请先登录', code: 'login' }, 401);

  const { engine = '', texts = [], from = 'auto', to = 'zh-CN' } = await req.json().catch(() => ({}));
  if (!Array.isArray(texts) || !texts.length) return json({ error: '没有要翻译的内容' }, 400);

  const db = adminClient();
  const month = monthKey();
  const [{ data: profile }, { data: row }] = await Promise.all([
    db.from('profiles').select('plan').eq('id', user.id).single(),
    db.from('usage_monthly').select('points,chars').eq('user_id', user.id).eq('month', month).maybeSingle(),
  ]);
  const plan = (profile?.plan || 'free') as Plan;
  const used = { points: Number(row?.points || 0), chars: Number(row?.chars || 0) };
  const limits = { points: POINT_LIMIT, chars: charLimitFor(plan, CHAR_LIMITS), disabled: DISABLED };
  const usage = (u: { points: number; chars: number }) => ({ ...u, limit: limits.points, charLimit: limits.chars, month });
  const denied = checkAccess(plan, engine, used, limits, texts.map(String));
  if (denied) return json({ ...denied, usage: usage(used) }, denied.status);

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
    const points = pointsFor(engine, tokens);
    const { data, error } = await db.rpc('add_usage_points', { p_user: user.id, p_month: month, p_tokens: tokens, p_chars: chars, p_points: points });
    if (error) console.error('add_usage_points', error);
    const total = Array.isArray(data) ? data[0] : data;
    return json({
      translations: out,
      usage: usage({ points: Number(total?.total_points ?? used.points + points), chars: Number(total?.total_chars ?? used.chars + chars) }),
    });
  } catch (e) {
    const status = e instanceof ProviderError ? e.status : 500;
    console.error('translate', engine, e);
    return json({ error: (e as Error).message || '翻译失败', code: status === 503 ? 'unavailable' : 'provider' }, status);
  }
});
