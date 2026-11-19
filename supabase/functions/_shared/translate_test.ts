// 运行：deno test supabase/functions/
import { assertEquals } from 'jsr:@std/assert@1.0.13';
import { checkAccess, llmTranslate, monthKey, pack, parseBatch, type Chat } from './translate.ts';

const LIMIT = 20_000_000;

Deno.test('会员等级与引擎：免费只能用 Google（不经过后端）', () => {
  assertEquals(checkAccess('free', 'deepl', 0, LIMIT)?.code, 'upgrade');
  assertEquals(checkAccess('free', 'deepl', 0, LIMIT)?.requiredPlan, 'premium');
  assertEquals(checkAccess('free', 'openai', 0, LIMIT)?.requiredPlan, 'premium_plus');
});

Deno.test('Premium 可用 DeepL / Microsoft，不可用大模型', () => {
  assertEquals(checkAccess('premium', 'deepl', 0, LIMIT), null);
  assertEquals(checkAccess('premium', 'microsoft', 0, LIMIT), null);
  for (const e of ['openai', 'gemini', 'deepseek', 'claude']) {
    assertEquals(checkAccess('premium', e, 0, LIMIT)?.requiredPlan, 'premium_plus');
  }
});

Deno.test('Premium+ 可用全部引擎；AI 用量到上限后拒绝，机器翻译不受影响', () => {
  for (const e of ['deepl', 'microsoft', 'openai', 'gemini', 'deepseek', 'claude']) {
    assertEquals(checkAccess('premium_plus', e, 0, LIMIT), null);
  }
  assertEquals(checkAccess('premium_plus', 'openai', LIMIT, LIMIT)?.code, 'quota');
  assertEquals(checkAccess('premium_plus', 'openai', LIMIT, LIMIT)?.status, 429);
  assertEquals(checkAccess('premium_plus', 'deepl', LIMIT, LIMIT), null);
});

Deno.test('未知引擎与超大请求被拒绝', () => {
  assertEquals(checkAccess('premium_plus', 'custom', 0, LIMIT)?.code, 'unknown_engine');
  assertEquals(checkAccess('premium_plus', 'openai', 0, LIMIT, new Array(101).fill('a'))?.code, 'too_large');
  assertEquals(checkAccess('premium_plus', 'openai', 0, LIMIT, ['x'.repeat(20_001)])?.code, 'too_large');
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
