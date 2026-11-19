// 浏览器中直接调用的免费引擎：Google 翻译。DeepL、Microsoft 与大模型由后端调用（supabase/functions/translate）
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
