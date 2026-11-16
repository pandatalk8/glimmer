"""检查文档中的 Mermaid 图：逐张渲染，报告语法错误，并截图到 tests/output/diagrams/。

用法：python3 tests/check_diagrams.py [md 文件 ...]
不带参数时检查 README.md 和 docs/ 下所有 Markdown。需要联网（从 CDN 加载 mermaid）。
"""
import asyncio, json, os, re, sys
from playwright.async_api import async_playwright

import glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'tests', 'output', 'diagrams')
os.makedirs(OUT, exist_ok=True)
files = sys.argv[1:] or [os.path.join(ROOT, 'README.md')] + sorted(glob.glob(os.path.join(ROOT, 'docs', '*.md')))
jobs = []
for md in files:
    for i, code in enumerate(re.findall(r'```mermaid\n(.*?)```', open(md, encoding='utf-8').read(), re.S), 1):
        jobs.append((os.path.basename(md), i, code))
print(f'共 {len(jobs)} 张图')

HTML = '''<!doctype html><html><head><meta charset="utf-8">
<style>body{margin:0;background:#fff;font-family:-apple-system,"PingFang SC",sans-serif} .d{padding:16px;width:1400px}</style>
</head><body><div id="out"></div>
<script type="module">
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs';
mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' });
window.renderOne = async (code, i) => {
  try {
    const { svg } = await mermaid.render('m' + i + '_' + Date.now(), code);
    document.getElementById('out').innerHTML = '<div class="d" id="d">' + svg + '</div>';
    return 'ok';
  } catch (e) { return 'ERROR: ' + (e.message || e); }
};
window.ready = true;
</script></body></html>'''


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        page = await b.new_page(viewport={'width': 1600, 'height': 1200}, device_scale_factor=1.5)
        await page.set_content(HTML)
        await page.wait_for_function('window.ready === true', timeout=30000)
        bad = 0
        for n, (name, i, code) in enumerate(jobs, 1):
            r = await page.evaluate('([c, i]) => window.renderOne(c, i)', [code, n])
            first = code.strip().splitlines()[0]
            if r != 'ok':
                bad += 1
                print(f'  FAIL  {name} 第 {i} 张（{first}）：{r[:300]}')
                continue
            await page.locator('#d').screenshot(path=os.path.join(OUT, f'{name[:-3]}_{i:02d}.png'))
            print(f'  ok    {name} 第 {i} 张（{first}）')
        await b.close()
        print('全部渲染成功' if not bad else f'{bad} 张失败')
        sys.exit(1 if bad else 0)

asyncio.run(main())
