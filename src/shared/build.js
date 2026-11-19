// 版本显示：v0.2.0 · c59de6a · 11-19 12:00（有 build.json 时），否则 v0.2.0 · 指纹 1a2b3c4d
const pad = (n) => String(n).padStart(2, '0');

function stamp(iso) {
  const t = iso ? new Date(iso) : null;
  if (!t || isNaN(t)) return '';
  return `${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

/** info 为后台 buildInfo 的返回值；which：'loaded' 当前运行的版本，'disk' 磁盘上的最新代码 */
export function buildLabel(info, which = 'loaded') {
  const v = 'v' + (info?.version || chrome.runtime.getManifest().version);
  const part = info?.[which];
  const b = part?.build;
  if (b?.commit) return [v, b.commit, stamp(b.time)].filter(Boolean).join(' · ');
  return part?.fp ? `${v} · 指纹 ${part.fp}` : v;
}

/** 只显示提交编号（或指纹），用于空间较小的地方 */
export function buildShort(info, which = 'loaded') {
  const part = info?.[which];
  return part?.build?.commit || (part?.fp ? '指纹 ' + part.fp : '');
}
