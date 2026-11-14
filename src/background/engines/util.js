export async function httpError(res, engine) {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      detail = j?.error?.message || j?.message || j?.error || text;
      if (typeof detail !== 'string') detail = JSON.stringify(detail);
    } catch {
      detail = text;
    }
  } catch {}
  const hints = {
    401: 'API Key 无效或未授权',
    403: '无访问权限（检查 Key 或额度）',
    429: '请求过于频繁或额度不足',
    456: '额度已用完',
  };
  const hint = hints[res.status] ? `${hints[res.status]}：` : '';
  const err = new Error(`${engine} 错误 ${res.status} ${hint}${String(detail).slice(0, 200)}`);
  err.status = res.status;
  err.detail = String(detail);
  return err;
}

// 并发受限的 map，保持顺序
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}
