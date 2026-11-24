// 运行：deno test supabase/functions/
import { assertEquals } from 'jsr:@std/assert@1.0.13';
import {
  availableEngines, charLimitFor, checkAccess, cnNum, disabledEngines, DEFAULT_CHAR_LIMIT, DEFAULT_POINT_LIMIT, llmTranslate, monthKey, pack, parseBatch, pointsFor, type Chat,
} from './translate.ts';

const NONE = { points: 0, chars: 0 };
const L = (plan: 'premium' | 'premium_plus' | 'free' = 'premium_plus') => ({
  points: DEFAULT_POINT_LIMIT, chars: charLimitFor(plan === 'free' ? 'premium' : plan),
});

Deno.test('会员等级与引擎：免费只能用 Google（不经过后端）', () => {
  assertEquals(checkAccess('free', 'deepl', NONE, L())?.code, 'upgrade');
  assertEquals(checkAccess('free', 'deepl', NONE, L())?.requiredPlan, 'premium');
  assertEquals(checkAccess('free', 'openai', NONE, L())?.requiredPlan, 'premium_plus');
});

Deno.test('Premium 可用 DeepL / Microsoft，不可用大模型', () => {
  assertEquals(checkAccess('premium', 'deepl', NONE, L('premium')), null);
  assertEquals(checkAccess('premium', 'microsoft', NONE, L('premium')), null);
  for (const e of ['openai', 'gemini', 'deepseek', 'claude']) {
    assertEquals(checkAccess('premium', e, NONE, L('premium'))?.requiredPlan, 'premium_plus');
  }
});

Deno.test('Premium+ 可用全部引擎；AI 点数到上限后拒绝大模型，机器翻译不受影响', () => {
  for (const e of ['deepl', 'microsoft', 'openai', 'gemini', 'deepseek', 'claude']) {
    assertEquals(checkAccess('premium_plus', e, NONE, L()), null);
  }
  const full = { points: DEFAULT_POINT_LIMIT, chars: 0 };
  assertEquals(checkAccess('premium_plus', 'deepseek', full, L())?.code, 'quota');
  assertEquals(checkAccess('premium_plus', 'deepseek', full, L())?.status, 429);
  assertEquals(checkAccess('premium_plus', 'deepseek', full, L())?.error, '本月 AI 点数（1500 万点）已用完，下月 1 日恢复');
  assertEquals(checkAccess('premium_plus', 'deepl', full, L()), null);
});

Deno.test('AI 点数：按引擎成本加权（Claude 1 倍、DeepSeek 2.5 倍、GPT 3.4 倍、Gemini 4.6 倍）', () => {
  assertEquals(pointsFor('claude', 1000), 1000);
  assertEquals(pointsFor('deepseek', 1000), 2500);
  assertEquals(pointsFor('openai', 1000), 3400);
  assertEquals(pointsFor('gemini', 1000), 4600);
  assertEquals(pointsFor('deepseek', 1), 3); // 向上取整，不会少算
  assertEquals(cnNum(15_000_000), '1500 万');
  assertEquals(cnNum(100_000), '10 万');
});

Deno.test('DeepL / Microsoft 字符额度：Premium 10 万、Premium+ 20 万，用完后拒绝，大模型不受影响', () => {
  assertEquals(DEFAULT_CHAR_LIMIT.premium, 100_000);
  assertEquals(DEFAULT_CHAR_LIMIT.premium_plus, 200_000);
  const p = { points: 0, chars: 100_000 };
  assertEquals(checkAccess('premium', 'deepl', p, L('premium'))?.code, 'quota');
  assertEquals(checkAccess('premium', 'microsoft', p, L('premium'))?.error, '本月 DeepL / Microsoft 翻译额度（10 万字符）已用完，下月 1 日恢复');
  assertEquals(checkAccess('premium_plus', 'deepl', p, L()), null); // Premium+ 额度更高
  assertEquals(checkAccess('premium_plus', 'deepl', { points: 0, chars: 200_000 }, L())?.code, 'quota');
  assertEquals(checkAccess('premium_plus', 'claude', { points: 0, chars: 200_000 }, L()), null);
  assertEquals(charLimitFor('premium', { premium: 50_000 }), 50_000); // 可用环境变量调整
});

Deno.test('暂不开放的引擎：返回 unavailable，提示即将开放', () => {
  const limits = { ...L(), disabled: new Set(['openai', 'gemini']) };
  const r = checkAccess('premium_plus', 'openai', NONE, limits);
  assertEquals(r?.code, 'unavailable');
  assertEquals(r?.status, 503);
  assertEquals(r?.error, 'OpenAI GPT 即将开放，暂时请使用其他翻译引擎');
  assertEquals(checkAccess('premium_plus', 'deepseek', NONE, limits), null);
});

Deno.test('未知引擎与超大请求被拒绝', () => {
  assertEquals(checkAccess('premium_plus', 'custom', NONE, L())?.code, 'unknown_engine');
  assertEquals(checkAccess('premium_plus', 'openai', NONE, L(), new Array(101).fill('a'))?.code, 'too_large');
  assertEquals(checkAccess('premium_plus', 'openai', NONE, L(), ['x'.repeat(20_001)])?.code, 'too_large');
});

Deno.test('月份键按 UTC 自然月', () => {
  assertEquals(monthKey(new Date('2026-11-30T23:59:00Z')), '2026-11');
  assertEquals(monthKey(new Date('2026-12-01T00:00:00Z')), '2026-12');
});

Deno.test('分批：每批不超过 16 段 / 2400 字符', () => {
  assertEquals(pack(new Array(40).fill('hello')).map((g) => g.length), [16, 16, 8]);
  assertEquals(pack(['a'.repeat(2000), 'b'.repeat(2000)]).length, 2);
});

Deno.test('解析模型返回：兼容代码围栏、裸数组，数量不符返回 null', () => {
  assertEquals(parseBatch('```json\n{"translations":["一","二"]}\n```', 2), ['一', '二']);
  assertEquals(parseBatch('好的：["一","二"]', 2), ['一', '二']);
  assertEquals(parseBatch('{"translations":["一"]}', 2), null);
});

Deno.test('批量翻译：一次请求多段，并累计 Token', async () => {
  let calls = 0;
  const chat: Chat = async (_s, user) => {
    calls++;
    const arr = JSON.parse(user.slice(user.lastIndexOf('\n\n') + 2));
    return { text: JSON.stringify({ translations: arr.map((x: string) => '译' + x) }), tokens: 100 };
  };
  const r = await llmTranslate(chat, ['a', 'b', 'c'], 'zh-CN');
  assertEquals(r.out, ['译a', '译b', '译c']);
  assertEquals(calls, 1);
  assertEquals(r.tokens, 100);
});

Deno.test('批量解析失败时逐段翻译，Token 全部计入', async () => {
  const chat: Chat = async (_s, user) =>
    user.includes('JSON array') ? { text: '无法解析的内容', tokens: 50 } : { text: '译' + user, tokens: 10 };
  const r = await llmTranslate(chat, ['a', 'b'], 'zh-CN');
  assertEquals(r.out, ['译a', '译b']);
  assertEquals(r.tokens, 70);
});

Deno.test('可用引擎：只返回配置了密钥且未暂停的付费引擎', () => {
  const env: Record<string, string> = { DEEPL_API_KEY: 'k', DEEPSEEK_API_KEY: 'k', OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: ' ' };
  const get = (n: string) => env[n];
  assertEquals(availableEngines(get, disabledEngines(undefined)), ['deepl', 'deepseek']); // GPT 默认暂停；Claude 密钥为空白
  assertEquals(availableEngines(get, disabledEngines('')), ['deepl', 'openai', 'deepseek']); // 全部开放
  assertEquals(availableEngines(() => undefined, disabledEngines('')), []);
});
