// 运行在 YouTube 页面主世界（MAIN world）：拦截播放器请求的字幕数据，转交给内容脚本
(() => {
  if (window.__glimmerYtHook) return;
  window.__glimmerYtHook = true;
  const isCaption = (url) => typeof url === 'string' && url.includes('/api/timedtext');
  const post = (url, body) => window.postMessage({ source: 'glimmer-yt', url, body }, '*');

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const res = await origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input?.url;
      if (isCaption(url)) res.clone().text().then((t) => post(url, t));
    } catch {}
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (isCaption(String(url))) {
      this.addEventListener('load', () => {
        try {
          post(String(url), this.responseText);
        } catch {}
      });
    }
    return origOpen.apply(this, arguments);
  };
})();
