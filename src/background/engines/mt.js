// 传统机器翻译引擎：Google / Microsoft / DeepL
import { deeplSource, deeplTarget, msCode } from '../../shared/languages.js';
import { fetchT, httpError, mapLimit } from './util.js';

// ---------- Google（免费 gtx 接口） ----------
async function googleOne(text, from, to) {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t' +
    `&sl=${encodeURIComponent(from || 'auto')}&tl=${encodeURIComponent(to)}`;
  const res = await fetchT(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: 'q=' + encodeURIComponent(text),
  });
  if (!res.ok) throw await httpError(res, 'Google');
  const data = await res.json();
  return (data?.[0] || []).map((s) => s?.[0] || '').join('');
}

// 批量接口：一个请求携带多个 q，比逐段请求快一个数量级
async function googleBatch(texts, from, to) {
  const url =
    'https://translate.googleapis.com/translate_a/t?client=gtx&dj=1' +
    `&sl=${encodeURIComponent(from || 'auto')}&tl=${encodeURIComponent(to)}`;
  const res = await fetchT(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: texts.map((t) => 'q=' + encodeURIComponent(t)).join('&'),
  });
  if (!res.ok) throw await httpError(res, 'Google');
  const data = await res.json();
  // sl=auto 时每项为 [译文, 检测语言]，指定源语言时每项为译文字符串
  const out = Array.isArray(data) ? data.map((x) => (Array.isArray(x) ? x[0] : x)) : [];
  if (out.length !== texts.length || out.some((x) => typeof x !== 'string')) {
    throw new Error('Google 批量结果数量不匹配');
  }
  return out;
}

function chunkBy(texts, maxChars, maxItems) {
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const t of texts) {
    if (cur.length && (size + t.length > maxChars || cur.length >= maxItems)) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(t);
    size += t.length;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

export async function google(texts, { from, to }) {
  const out = await mapLimit(chunkBy(texts, 4500, 64), 3, async (chunk) => {
    try {
      return await googleBatch(chunk, from, to);
    } catch (e) {
      if (e.status === 429) throw e; // 限流时逐段重试只会更糟
      return mapLimit(chunk, 4, (t) => googleOne(t, from, to)); // 降级为单段接口
    }
  });
  return out.flat();
}

// ---------- Microsoft（Azure Translator 官方 API，免费层每月 200 万字符） ----------
export async function microsoft(texts, { from, to, cfg }) {
  if (!cfg.apiKey) throw new Error('请先在设置中填写 Azure Translator Key');
  const headers = {
    'Content-Type': 'application/json',
    'Ocp-Apim-Subscription-Key': cfg.apiKey.trim(),
  };
  if (cfg.region?.trim()) headers['Ocp-Apim-Subscription-Region'] = cfg.region.trim();
  const chunks = [];
  for (let i = 0; i < texts.length; i += 50) chunks.push(texts.slice(i, i + 50));
  const out = await mapLimit(chunks, 3, async (chunk) => {
    const src = msCode(from);
    const url =
      'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0' +
      (src ? `&from=${src}` : '') +
      `&to=${msCode(to)}`;
    const res = await fetchT(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(chunk.map((t) => ({ Text: t }))),
    });
    if (!res.ok) throw await httpError(res, 'Microsoft');
    const data = await res.json();
    return data.map((d) => d?.translations?.[0]?.text || '');
  });
  return out.flat();
}

// ---------- DeepL（官方 API） ----------
export async function deepl(texts, { from, to, cfg }) {
  if (!cfg.apiKey) throw new Error('请先在设置中填写 DeepL API Key');
  const base =
    cfg.apiUrl?.trim() ||
    (cfg.apiKey.trim().endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com');
  const chunks = [];
  for (let i = 0; i < texts.length; i += 50) chunks.push(texts.slice(i, i + 50));
  const out = await mapLimit(chunks, 2, async (chunk) => {
    const body = { text: chunk, target_lang: deeplTarget(to) };
    const src = deeplSource(from);
    if (src) body.source_lang = src;
    const res = await fetchT(base.replace(/\/$/, '') + '/v2/translate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'DeepL-Auth-Key ' + cfg.apiKey.trim(),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await httpError(res, 'DeepL');
    const data = await res.json();
    return data.translations.map((t) => t.text);
  });
  return out.flat();
}
