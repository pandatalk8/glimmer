// 大模型翻译：OpenAI / DeepSeek / 自定义(OpenAI 兼容) / Gemini / Claude
import { getLang } from '../../shared/languages.js';
import { DEFAULT_PROMPT } from '../../shared/settings.js';
import { httpError, mapLimit } from './util.js';

// ---------- 各家 chat 调用：(system, user) -> string ----------
async function openaiChat(cfg, system, user, temperature, defaultBase) {
  const base = (cfg.baseUrl || defaultBase).replace(/\/$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey.trim();
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature,
  };
  let res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  // 部分推理模型不支持自定义 temperature，去掉后重试一次
  if (res.status === 400) {
    const err = await httpError(res, 'LLM');
    if (!/temperature/i.test(err.detail)) throw err;
    delete body.temperature;
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  }
  if (!res.ok) throw await httpError(res, cfg._name || 'LLM');
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

async function geminiChat(cfg, system, user, temperature) {
  if (!cfg.apiKey) throw new Error('请先在设置中填写 Gemini API Key');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    cfg.model
  )}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey.trim() },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature },
    }),
  });
  if (!res.ok) throw await httpError(res, 'Gemini');
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((p) => !p.thought)
    .map((p) => p.text || '')
    .join('');
}

async function claudeChat(cfg, system, user, temperature) {
  if (!cfg.apiKey) throw new Error('请先在设置中填写 Claude API Key');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey.trim(),
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 8192,
      system,
      temperature,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw await httpError(res, 'Claude');
  const data = await res.json();
  return (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

const CHAT = {
  openai: (cfg, s, u, t) => {
    if (!cfg.apiKey) throw new Error('请先在设置中填写 OpenAI API Key');
    return openaiChat({ ...cfg, _name: 'OpenAI' }, s, u, t, 'https://api.openai.com/v1');
  },
  deepseek: (cfg, s, u, t) => {
    if (!cfg.apiKey) throw new Error('请先在设置中填写 DeepSeek API Key');
    return openaiChat({ ...cfg, _name: 'DeepSeek' }, s, u, t, 'https://api.deepseek.com');
  },
  custom: (cfg, s, u, t) => openaiChat({ ...cfg, _name: '自定义模型' }, s, u, t, ''),
  gemini: geminiChat,
  claude: claudeChat,
};

// ---------- 批量翻译 ----------
function stripFence(s) {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
}

function parseBatch(raw, n) {
  const s = stripFence(raw);
  const tryParse = (str) => {
    try {
      const j = JSON.parse(str);
      const arr = Array.isArray(j) ? j : j?.translations || j?.t;
      if (Array.isArray(arr) && arr.length === n) return arr.map((x) => String(x ?? ''));
    } catch {}
    return null;
  };
  return (
    tryParse(s) ||
    tryParse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)) ||
    tryParse(s.slice(s.indexOf('['), s.lastIndexOf(']') + 1))
  );
}

// 按字符数把段落打包，减少请求次数
function pack(texts, maxChars = 2400, maxItems = 16) {
  const groups = [];
  let cur = [];
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

export async function llmTranslate(engineId, texts, { from, to, cfg, settings }) {
  const chat = CHAT[engineId];
  const toName = getLang(to).en;
  const fromName = from && from !== 'auto' ? getLang(from).en : '';
  const temperature = Number(settings.llm?.temperature ?? 0.3);
  const system =
    (settings.llm?.prompt || DEFAULT_PROMPT).replaceAll('{{to}}', toName).replaceAll('{{from}}', fromName || 'the source language');

  const single = (t) => chat(cfg, system, t, temperature).then((r) => r.trim());

  if (texts.length === 1) return [await single(texts[0])];

  const out = new Array(texts.length);
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
    let parsed = null;
    try {
      parsed = parseBatch(await chat(cfg, system, user, temperature), segs.length);
    } catch (e) {
      if (e.status && e.status !== 400) throw e;
    }
    if (!parsed) parsed = await mapLimit(segs, 3, single); // 批量解析失败则逐条翻译
    idxs.forEach((i, k) => (out[i] = parsed[k]));
  });
  return out;
}
