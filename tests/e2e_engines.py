"""翻译引擎真实 API 测试：读取 tests/.env.local 中的 Key，逐个验证连通性、批量翻译和整页翻译。

用法：
    cp tests/env.example tests/.env.local   # 填入你有的 Key，没有的留空
    python3 tests/e2e_engines.py            # 只测试填了 Key 的引擎

.env.local 已加入 .gitignore，脚本不会打印任何 Key。
"""
import asyncio, functools, http.server, os, sys, tempfile, threading, time
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = os.path.join(ROOT, 'tests', '.env.local')
FIXTURES = os.path.join(ROOT, 'tests', 'fixtures')


def load_env():
    env = {}
    if os.path.exists(ENV):
        for line in open(ENV, encoding='utf-8'):
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    for k, v in os.environ.items():
        if k.startswith('GLIMMER_'):
            env[k] = v
    return env


E = load_env()
g = lambda k: E.get('GLIMMER_' + k, '')
ENGINES = {
    'deepl': {'apiKey': g('DEEPL_KEY')},
    'microsoft': {'apiKey': g('AZURE_KEY'), 'region': g('AZURE_REGION')},
    'openai': {'apiKey': g('OPENAI_KEY'), 'baseUrl': g('OPENAI_BASE_URL') or 'https://api.openai.com/v1', 'model': g('OPENAI_MODEL') or 'gpt-4.1-mini'},
    'gemini': {'apiKey': g('GEMINI_KEY'), 'model': g('GEMINI_MODEL') or 'gemini-2.5-flash'},
    'deepseek': {'apiKey': g('DEEPSEEK_KEY'), 'baseUrl': 'https://api.deepseek.com', 'model': g('DEEPSEEK_MODEL') or 'deepseek-chat'},
    'claude': {'apiKey': g('CLAUDE_KEY'), 'model': g('CLAUDE_MODEL') or 'claude-haiku-5-5'},
    'custom': {'apiKey': g('CUSTOM_KEY'), 'baseUrl': g('CUSTOM_BASE_URL'), 'model': g('CUSTOM_MODEL')},
}
ACTIVE = [k for k, v in ENGINES.items() if (v.get('baseUrl') if k == 'custom' else v.get('apiKey'))]
if '--only' in sys.argv:
    ACTIVE = [k for k in ACTIVE if k in sys.argv[sys.argv.index('--only') + 1].split(',')]

http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8765), functools.partial(http.server.SimpleHTTPRequestHandler, directory=FIXTURES))
threading.Thread(target=srv.serve_forever, daemon=True).start()

ZH = lambda s: any('一' <= c <= '鿿' for c in s or '')
rows = []


async def main():
    if not ACTIVE:
        print(f'没有可测试的引擎：请在 {ENV} 中填写至少一个 Key（参考 tests/env.example）')
        sys.exit(2)
    print('待测引擎：' + '、'.join(ACTIVE) + '\n')
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            tempfile.mkdtemp(prefix='glimmer-eng-'), channel='chromium', headless=True,
            args=[f'--disable-extensions-except={ROOT}', f'--load-extension={ROOT}'], viewport={'width': 1100, 'height': 900})
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        eid = sw.url.split('/')[2]
        await asyncio.sleep(1.5)
        for pg in ctx.pages:
            await pg.close()
        await sw.evaluate("(engines)=>chrome.storage.local.set({settings:{engines}})", {k: ENGINES[k] for k in ACTIVE})
        ext = await ctx.new_page()
        await ext.goto(f'chrome-extension://{eid}/options/options.html')

        for eng in ACTIVE:
            print(f'[{eng}]')
            res = {'engine': eng}
            # 1. 单句：设置页“测试连接”同款
            t0 = time.time()
            r = await ext.evaluate("(e)=>chrome.runtime.sendMessage({type:'testEngine',engine:e})", eng)
            ok = r.get('ok') and ZH(r['data']['text'])
            res['single'] = ok
            print(('  PASS' if ok else '  FAIL') + f"  测试连接  {r['data']['ms']}ms  {r['data']['text']}" if r.get('ok') else f"  FAIL  测试连接  {r.get('error')}")
            if not r.get('ok'):
                rows.append(res)
                continue
            # 2. 批量：8 段一次，检查数量与顺序
            texts = [f'Sentence number {i}: the quick brown fox jumps over the lazy dog.' for i in range(1, 9)]
            t0 = time.time()
            r = await ext.evaluate("([e,t])=>chrome.runtime.sendMessage({type:'translate',engine:e,texts:t,to:'zh-CN',noCache:true})", [eng, texts])
            ms = int((time.time() - t0) * 1000)
            if r.get('ok'):
                out = r['data']
                in_order = all(str(i) in out[i - 1] for i in range(1, 9))
                ok = len(out) == 8 and all(ZH(x) for x in out) and in_order
                print(('  PASS' if ok else '  FAIL') + f'  批量 8 段  {ms}ms  数量={len(out)} 顺序正确={in_order}')
            else:
                ok = False
                print(f"  FAIL  批量 8 段  {r.get('error')}")
            res['batch'] = ok
            # 3. 中译英
            r = await ext.evaluate("(e)=>chrome.runtime.sendMessage({type:'translate',engine:e,texts:['今天的会议改到下午三点。'],to:'en',noCache:true})", eng)
            ok = r.get('ok') and 'three' in r['data'][0].lower() or '3' in (r.get('data') or [''])[0]
            res['zh2en'] = bool(ok)
            print(('  PASS' if ok else '  FAIL') + f"  中译英  {r.get('data', [r.get('error')])[0]}")
            # 4. 整页
            await sw.evaluate("async (e)=>{const {settings}=await chrome.storage.local.get('settings');await chrome.storage.local.set({settings:{...settings,engine:e}})}", eng)
            page = await ctx.new_page()
            await page.goto('http://127.0.0.1:8765/article.html')
            await page.wait_for_timeout(600)
            await sw.evaluate("""async ()=>{const [t]=await chrome.tabs.query({url:'http://127.0.0.1:8765/*'});await chrome.tabs.sendMessage(t.id,{type:'setPage',on:true})}""")
            t0 = time.time()
            done = 0
            for _ in range(240):
                done = await page.evaluate("document.querySelectorAll('gl-trans:not(.gl-loading)').length")
                if done >= 11:
                    break
                await asyncio.sleep(0.25)
            errs = await page.evaluate("[...document.querySelectorAll('gl-trans.gl-error')].map(e=>e.title)[0] || ''")
            ms = int((time.time() - t0) * 1000)
            ok = done >= 11 and not errs
            res['page'] = ok
            print(('  PASS' if ok else '  FAIL') + f'  整页翻译  {done}/11 段  {ms}ms' + (f'  错误：{errs}' if errs else ''))
            await page.close()
            rows.append(res)

        await ctx.close()

    print('\n汇总')
    print('| 引擎 | 测试连接 | 批量 | 中译英 | 整页 |')
    print('| --- | --- | --- | --- | --- |')
    mark = lambda v: '✓' if v else ('✗' if v is False else '—')
    for r in rows:
        print(f"| {r['engine']} | {mark(r.get('single'))} | {mark(r.get('batch'))} | {mark(r.get('zh2en'))} | {mark(r.get('page'))} |")
    sys.exit(0 if all(r.get('page') for r in rows) else 1)


asyncio.run(main())
