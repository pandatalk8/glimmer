"""微光翻译端到端测试：用 Playwright 加载扩展，在本地测试页上验证核心功能。

用法（在项目根目录）：
    pip3 install playwright && python3 -m playwright install chromium
    python3 tests/e2e.py            # 无头运行
    python3 tests/e2e.py --headed   # 打开浏览器窗口观看

依赖网络访问 Google 翻译；大模型部分使用本地 mock 服务，不需要 API Key。
截图输出到 tests/output/。
"""
import asyncio, functools, http.server, json, os, sys, tempfile, threading
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES = os.path.join(ROOT, 'tests', 'fixtures')
OUTPUT = os.path.join(ROOT, 'tests', 'output')
HEADED = '--headed' in sys.argv
PAGE_URL = 'http://127.0.0.1:8765/article.html'

# ---------- 本地服务：测试页 + 模拟 OpenAI 兼容接口 ----------
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
LLM_CALLS = []


class MockBackend(http.server.BaseHTTPRequestHandler):
    """模拟微光翻译后端的翻译代理：校验登录令牌，返回译文与用量"""
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        LLM_CALLS.append({'path': self.path, 'auth': self.headers.get('Authorization'), 'engine': body.get('engine'), 'n': len(body.get('texts', []))})
        if self.headers.get('Authorization') != 'Bearer test-token':
            code, out = 401, {'error': '请先登录', 'code': 'login'}
        else:
            code, out = 200, {'translations': ['【译】' + t for t in body['texts']], 'usage': {'tokens': 1234, 'limit': 20000000, 'month': '2026-11'}}
        data = json.dumps(out, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(data)


def serve(port, handler):
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()


serve(8765, functools.partial(http.server.SimpleHTTPRequestHandler, directory=FIXTURES))
serve(8766, MockBackend)

# ---------- 断言工具 ----------
results = []


def check(name, ok, detail=''):
    results.append(ok)
    print(('  PASS  ' if ok else '  FAIL  ') + name + (f'  ({detail})' if detail else ''))


SET = """async (patch)=>{const {settings}=await chrome.storage.local.get('settings');
  await chrome.storage.local.set({settings:{...(settings||{}),...patch}})}"""
PAGE = """async (on)=>{const [t]=await chrome.tabs.query({url:'http://127.0.0.1:8765/*'});
  await chrome.tabs.sendMessage(t.id,{type:'setPage',on})}"""
TRANS = """()=>[...document.querySelectorAll('gl-trans')].map(e=>e.textContent)"""


async def main():
    os.makedirs(OUTPUT, exist_ok=True)
    profile = tempfile.mkdtemp(prefix='glimmer-test-')
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            profile, channel='chromium', headless=not HEADED,
            args=[f'--disable-extensions-except={ROOT}', f'--load-extension={ROOT}'],
            viewport={'width': 1100, 'height': 900})
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        eid = sw.url.split('/')[2]
        print(f'扩展已加载：{eid}\n')

        # 1. 引擎
        print('[1] 翻译引擎')
        ext = await ctx.new_page()
        await ext.goto(f'chrome-extension://{eid}/panel/panel.html')
        r = await ext.evaluate("""()=>chrome.runtime.sendMessage({type:'translate',engine:'google',texts:['Hello world'],to:'zh-CN',noCache:true})""")
        check('Google 翻译返回中文', r.get('ok') and '你好' in r['data'][0], str(r))
        r = await ext.evaluate("""()=>chrome.runtime.sendMessage({type:'translate',engine:'deepl',texts:['Hi']})""")
        check('未登录使用付费引擎时提示需要会员', not r.get('ok') and '需要登录并开通会员' in r.get('error', ''), r.get('error'))
        r = await ext.evaluate("""()=>chrome.runtime.sendMessage({type:'translate',engine:'custom',texts:['Hi']})""")
        check('已移除的自定义引擎被拒绝', not r.get('ok') and '未知翻译引擎' in r.get('error', ''), r.get('error'))

        # 2. 整页翻译
        print('\n[2] 整页双语翻译')
        page = await ctx.new_page()
        await page.goto(PAGE_URL)
        await page.wait_for_timeout(800)
        await sw.evaluate(PAGE, True)
        await page.wait_for_function("document.querySelectorAll('gl-trans:not(.gl-loading)').length >= 9", timeout=15000)
        texts = await page.evaluate(TRANS)
        check('翻译单元数量 = 11', len(texts) == 11, f'实际 {len(texts)}')
        check('代码块未被翻译', await page.locator('pre gl-trans').count() == 0)
        check('中文段落未被翻译', await page.evaluate("[...document.querySelectorAll('p')].find(p=>p.textContent.startsWith('这一段')).querySelector('gl-trans')===null"))
        check('导航链接逐个翻译', await page.locator('nav gl-trans').count() == 3)
        await page.screenshot(path=f'{OUTPUT}/bilingual.png', full_page=True)

        # 3. 仅译文模式
        print('\n[3] 仅译文模式')
        await sw.evaluate(SET, {'displayMode': 'translation'})
        await page.wait_for_timeout(500)
        fs = await page.evaluate("getComputedStyle(document.querySelector('h1')).fontSize")
        check('原文被隐藏（font-size:0）', fs == '0px', fs)
        await page.screenshot(path=f'{OUTPUT}/translation-only.png', full_page=True)
        await sw.evaluate(SET, {'displayMode': 'bilingual'})

        # 4. 划词翻译
        print('\n[4] 划词翻译')
        box = await page.locator('#sel').bounding_box()
        await page.mouse.move(box['x'] + 2, box['y'] + 10)
        await page.mouse.down()
        await page.mouse.move(box['x'] + box['width'] - 2, box['y'] + 10, steps=5)
        await page.mouse.up()
        await page.wait_for_timeout(300)
        check('出现划词图标', await page.locator('glimmer-ui >> .sel-icon').count() == 1)
        await page.locator('glimmer-ui >> .sel-icon').click()
        await page.wait_for_function("document.querySelector('glimmer-ui').shadowRoot.querySelector('.p-out')?.innerText.trim().length > 2", timeout=10000)
        out = await page.locator('glimmer-ui >> .p-out').inner_text()
        check('面板显示译文', '翻译' in out or '选择' in out, out)
        opts = await page.locator('glimmer-ui >> .p-engine option').all_inner_texts()
        check('免费用户：引擎下拉框标注会员等级', 'DeepL（Premium）' in opts and 'DeepSeek（Premium+）' in opts and 'Google 翻译' in opts, opts)
        await page.screenshot(path=f'{OUTPUT}/selection.png')

        # 5. 还原
        print('\n[5] 还原页面')
        await sw.evaluate(PAGE, False)
        await page.wait_for_timeout(300)
        check('译文全部移除', await page.locator('gl-trans').count() == 0)
        check('host 标记清理干净', await page.locator('.gl-host').count() == 0)

        # 6. 付费引擎经由后端翻译代理（模拟后端）
        print('\n[6] 付费引擎经由后端翻译代理（本地模拟）')
        import time as _t
        await sw.evaluate("""(o)=>chrome.storage.local.set(o)""", {
            'backendOverride': {'supabaseUrl': 'http://127.0.0.1:8766', 'supabaseAnonKey': 'anon-test'},
            'auth': {'access_token': 'test-token', 'refresh_token': 'r', 'expires_at': int(_t.time()) + 3600, 'user': {'id': 'u1', 'email': 'a@b.c'}},
            'account': {'email': 'a@b.c', 'plan': 'premium_plus', 'usage': {'tokens': 0, 'limit': 20000000}},
        })
        await sw.evaluate(SET, {'engine': 'deepseek'})
        await page.reload()
        await page.wait_for_timeout(800)
        LLM_CALLS.clear()
        await sw.evaluate(PAGE, True)
        await page.wait_for_function("document.querySelectorAll('gl-trans:not(.gl-loading)').length >= 11", timeout=15000)
        texts = await page.evaluate(TRANS)
        check('全部段落使用后端返回的译文', all(t.startswith('【译】') for t in texts), f'{len(texts)} 段')
        check('11 段只发 1 次后端请求，并带登录令牌', len(LLM_CALLS) == 1 and LLM_CALLS[0]['auth'] == 'Bearer test-token'
              and LLM_CALLS[0]['engine'] == 'deepseek' and LLM_CALLS[0]['path'] == '/functions/v1/translate', LLM_CALLS)
        used = await sw.evaluate("chrome.storage.local.get('account').then(r=>r.account.usage.tokens)")
        check('返回的本月用量写入账户状态', used == 1234, used)

        await ctx.close()

    passed = sum(results)
    print(f'\n结果：{passed}/{len(results)} 通过，截图在 tests/output/')
    sys.exit(0 if passed == len(results) else 1)


asyncio.run(main())
