"""真实网站与交互功能测试（需要联网，使用 Google 免费引擎）。

用法：python3 tests/e2e_real.py [--headed] [--only 名称,名称]
场景：wiki hn mdn hover input popup drawer always import style ctxmenu
"""
import asyncio, functools, http.server, os, sys, tempfile, threading
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES = os.path.join(ROOT, 'tests', 'fixtures')
OUTPUT = os.path.join(ROOT, 'tests', 'output')
HEADED = '--headed' in sys.argv
ONLY = sys.argv[sys.argv.index('--only') + 1].split(',') if '--only' in sys.argv else None
LOCAL = 'http://127.0.0.1:8765/article.html'

http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8765), functools.partial(http.server.SimpleHTTPRequestHandler, directory=FIXTURES))
threading.Thread(target=srv.serve_forever, daemon=True).start()

results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('  PASS  ' if ok else '  FAIL  ') + name + (f'  ({detail})' if detail != '' else ''))


SET = """async (patch)=>{const {settings}=await chrome.storage.local.get('settings');
  await chrome.storage.local.set({settings:{...(settings||{}),...patch}})}"""
TAB = """async ([pattern, msg])=>{const ts=await chrome.tabs.query({});const t=ts.find(t=>t.url&&t.url.includes(pattern));
  if(!t) return 'no-tab'; await chrome.tabs.sendMessage(t.id,msg); return 'ok'}"""
COUNT_DONE = "document.querySelectorAll('gl-trans:not(.gl-loading):not(.gl-error)').length"


async def wait_count(page, n, timeout=20000):
    # 在 Python 侧轮询：wait_for_function 默认依赖 requestAnimationFrame，后台标签页中不触发
    for _ in range(timeout // 250):
        if await page.evaluate(COUNT_DONE) >= n:
            return await page.evaluate(COUNT_DONE)
        await asyncio.sleep(0.25)
    if True:
        diag = await page.evaluate("""()=>({all:document.querySelectorAll('gl-trans').length,
          loading:document.querySelectorAll('gl-trans.gl-loading').length,
          error:[...new Set([...document.querySelectorAll('gl-trans.gl-error')].map(e=>e.title))].slice(0,2)})""")
        print('        诊断：', diag)
    return await page.evaluate(COUNT_DONE)


async def quick_result(pp):
    # 扩展页面的 CSP 禁止字符串 eval，因此在 Python 侧轮询
    for _ in range(50):
        out = await pp.locator('#quickOut').inner_text()
        if out and out != '翻译中…':
            return out
        await asyncio.sleep(0.2)
    return out


async def main():
    os.makedirs(OUTPUT, exist_ok=True)
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            tempfile.mkdtemp(prefix='glimmer-real-'), channel='chromium', headless=not HEADED,
            args=[f'--disable-extensions-except={ROOT}', f'--load-extension={ROOT}'],
            viewport={'width': 1200, 'height': 900}, locale='en-US')
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        eid = sw.url.split('/')[2]
        if '--net' in sys.argv:  # 调试：打印引擎请求（需设置 PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1）
            import time
            t0 = time.time()
            api = lambda r: 'googleapis' in r.url or 'deepl' in r.url or 'openai' in r.url
            ctx.on('request', lambda r: api(r) and print(f'        +{time.time()-t0:5.1f}s REQ items={(r.post_data or "").count("q=")}'))
            ctx.on('requestfinished', lambda r: api(r) and print(f'        +{time.time()-t0:5.1f}s DONE'))
            ctx.on('requestfailed', lambda r: api(r) and print(f'        +{time.time()-t0:5.1f}s FAIL {r.failure}'))
        await asyncio.sleep(1.5)  # 等首次安装打开的设置页出现后关闭，避免抢占测试标签页
        for pg in ctx.pages:
            await pg.close()
        await sw.evaluate(SET, {'floatBall': True})
        run = lambda name: ONLY is None or name in ONLY

        # ---------- 维基百科：长文、懒加载、跳过公式 ----------
        if run('wiki'):
            print('\n[wiki] 维基百科长文')
            page = await ctx.new_page()
            await page.goto('https://en.wikipedia.org/wiki/Language_acquisition', wait_until='domcontentloaded', timeout=60000)
            await page.wait_for_timeout(1500)
            await sw.evaluate(TAB, ['wikipedia.org', {'type': 'setPage', 'on': True}])
            first = await wait_count(page, 10)
            total_units = await page.evaluate("document.querySelectorAll('gl-trans').length")
            check('首屏已翻译', first >= 10, f'{first} 段')
            sample = None
            for _ in range(40):  # 首批多为短标题，正文段落稍后返回
                sample = await page.evaluate("[...document.querySelectorAll('#mw-content-text p gl-trans:not(.gl-loading)')].map(e=>e.textContent).find(t=>t.length>20)?.slice(0,40)")
                if sample:
                    break
                await asyncio.sleep(0.25)
            check('正文段落有中文译文', sample and any('一' <= c <= '鿿' for c in sample), sample)
            await page.mouse.wheel(0, 6000)
            await page.wait_for_timeout(4000)
            after = await page.evaluate("document.querySelectorAll('gl-trans').length")
            check('滚动后懒加载更多段落', after > total_units, f'{total_units} → {after}')
            bad = await page.evaluate("document.querySelectorAll('pre gl-trans, code gl-trans, math gl-trans, .mwe-math-element gl-trans').length")
            check('公式/代码内无译文', bad == 0, bad)
            errs = await page.evaluate("document.querySelectorAll('gl-trans.gl-error').length")
            check('无翻译失败段落', errs == 0, errs)
            await page.evaluate('scrollTo(0,0)')
            await page.wait_for_timeout(500)
            await page.screenshot(path=f'{OUTPUT}/real-wiki.png')
            await sw.evaluate(SET, {'displayMode': 'translation'})
            await page.wait_for_timeout(600)
            await page.screenshot(path=f'{OUTPUT}/real-wiki-translation.png')
            await sw.evaluate(SET, {'displayMode': 'bilingual'})
            await sw.evaluate(TAB, ['wikipedia.org', {'type': 'setPage', 'on': False}])
            await page.wait_for_timeout(300)
            check('关闭后完全还原', await page.evaluate("document.querySelectorAll('gl-trans,.gl-host,.gl-src').length") == 0)
            await page.close()

        # ---------- Hacker News：列表页 + 动态插入 ----------
        if run('hn'):
            print('\n[hn] Hacker News 列表与动态内容')
            page = await ctx.new_page()
            await page.goto('https://news.ycombinator.com/', wait_until='domcontentloaded', timeout=60000)
            await page.wait_for_timeout(1000)
            await sw.evaluate(TAB, ['ycombinator.com', {'type': 'setPage', 'on': True}])
            n = await wait_count(page, 15)
            check('标题列表已翻译', n >= 15, f'{n} 段')
            await page.evaluate("""()=>{const td=document.querySelector('.titleline').closest('table');
              const d=document.createElement('div');d.id='dyn';d.textContent='This paragraph was loaded dynamically after the page finished rendering.';
              td.parentElement.appendChild(d);d.scrollIntoView({block:'center'})}""")
            await page.wait_for_timeout(2500)
            dyn = await page.evaluate("document.querySelector('#dyn gl-trans')?.textContent")
            check('动态插入的内容自动翻译', bool(dyn), dyn)
            await page.screenshot(path=f'{OUTPUT}/real-hn.png')
            await page.close()

        # ---------- MDN：技术文档，代码块必须跳过 ----------
        if run('mdn'):
            print('\n[mdn] MDN 技术文档')
            page = await ctx.new_page()
            await page.goto('https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map', wait_until='domcontentloaded', timeout=60000)
            await page.wait_for_timeout(1500)
            await sw.evaluate(TAB, ['developer.mozilla.org', {'type': 'setPage', 'on': True}])
            n = await wait_count(page, 8)
            check('文档正文已翻译', n >= 8, f'{n} 段')
            in_code = await page.evaluate("document.querySelectorAll('pre gl-trans').length")
            check('代码块内无译文', in_code == 0, in_code)
            await page.screenshot(path=f'{OUTPUT}/real-mdn.png')
            await page.close()

        # ---------- 悬停翻译 ----------
        if run('hover'):
            print('\n[hover] Alt 悬停翻译')
            page = await ctx.new_page()
            await page.goto(LOCAL)
            await page.wait_for_timeout(600)
            p2 = page.locator('p').nth(1)
            b = await p2.bounding_box()
            await page.mouse.move(b['x'] + 50, b['y'] + 8)
            await page.keyboard.press('Alt')
            await page.wait_for_timeout(2000)
            check('按 Alt 只翻译指向的段落', await page.evaluate("document.querySelectorAll('gl-trans').length") == 1)
            await page.keyboard.press('Alt')
            await page.wait_for_timeout(300)
            check('再按 Alt 还原该段', await page.evaluate("document.querySelectorAll('gl-trans').length") == 0)
            await page.keyboard.press('Alt')
            await page.wait_for_timeout(2000)
            check('还原后可再次翻译', await page.evaluate("document.querySelectorAll('gl-trans').length") == 1)
            await page.close()

        # ---------- 输入框翻译 ----------
        if run('input'):
            print('\n[input] 输入框三空格翻译')
            await sw.evaluate(SET, {'inputTranslate': {'enabled': True, 'targetLang': 'en'}})
            page = await ctx.new_page()
            await page.goto(LOCAL)
            await page.evaluate("""()=>{const t=document.createElement('textarea');t.id='box';document.body.prepend(t);
              const i=document.createElement('input');i.id='inp';i.type='text';document.body.prepend(i)}""")
            await page.wait_for_timeout(300)
            await page.locator('#box').click()
            await page.keyboard.type('今天天气很好，我们去公园散步吧')
            await page.keyboard.type('   ')
            await page.wait_for_timeout(2500)
            v = await page.locator('#box').input_value()
            check('textarea 内容被替换为英文', v and all(ord(c) < 128 for c in v) and len(v) > 5, v)
            await page.locator('#inp').click()
            await page.keyboard.type('你好世界')
            await page.keyboard.type('   ')
            await page.wait_for_timeout(2500)
            v = await page.locator('#inp').input_value()
            check('input 内容被替换为英文', v and 'hello' in v.lower(), v)
            await sw.evaluate(SET, {'inputTranslate': {'enabled': False, 'targetLang': 'en'}})
            await page.close()

        # ---------- 面板（工具栏弹窗） ----------
        if run('popup'):
            print('\n[popup] 面板：首页与设置')
            pp = await ctx.new_page()
            await pp.set_viewport_size({'width': 400, 'height': 590})
            await pp.goto(f'chrome-extension://{eid}/panel/panel.html')
            await pp.wait_for_timeout(600)
            check('首页显示生词本与引擎卡片', await pp.locator('.stat').count() == 2)
            await pp.screenshot(path=f'{OUTPUT}/panel-home.png')
            await pp.locator('#quickInput').fill('Knowledge is power.')
            await pp.locator('#quickInput').press('Enter')
            out = await quick_result(pp)
            check('快速翻译 英→中', '知识' in out, out)
            await pp.locator('#quickInput').fill('知识就是力量')
            await pp.locator('#quickInput').press('Enter')
            out = await quick_result(pp)
            check('快速翻译 中→英（自动互译）', 'knowledge' in out.lower(), out)

            await pp.locator('.rail [data-go=settings]').click()
            await pp.wait_for_timeout(200)
            check('设置页分组行数 ≥ 12', await pp.locator('.ri').count() >= 12, await pp.locator('.ri').count())
            await pp.screenshot(path=f'{OUTPUT}/panel-settings.png')
            await pp.locator('[data-pick=targetLang]').click()
            await pp.locator('[data-set=ja]').click()
            await pp.wait_for_timeout(200)
            st = await sw.evaluate("chrome.storage.local.get('settings').then(r=>r.settings.targetLang)")
            check('选项页切换翻译语言已保存', st == 'ja', st)
            await pp.locator('[data-act=back]').click()
            val = await pp.locator('[data-pick=targetLang] .val').inner_text()
            check('返回设置页显示新值', val == '日本語', val)
            await pp.locator('[data-pick=targetLang]').click()
            await pp.locator('[data-set="zh-CN"]').click()

            await pp.locator('.rail [data-go=settings]').click()
            await pp.locator('[data-pick=engine]').click()
            await pp.wait_for_timeout(200)
            await pp.screenshot(path=f'{OUTPUT}/panel-engines.png')
            await pp.locator('[data-set=deepl]').click()
            await pp.wait_for_timeout(200)
            t = await pp.locator('#toast').inner_text()
            check('选择未配置引擎时提示需要 API Key', '需要先配置 API Key' in t, t)
            await pp.locator('[data-set=google]').click()
            await pp.wait_for_timeout(200)
            await pp.close()

        # ---------- 网页内侧边面板（抽屉） ----------
        if run('drawer'):
            print('\n[drawer] 网页内侧边面板与生词本')
            await sw.evaluate("()=>chrome.storage.local.set({words:[]})")
            page = await ctx.new_page()
            await page.goto(LOCAL)
            await page.wait_for_timeout(600)
            await page.locator('glimmer-ui >> .ball').hover()
            await page.wait_for_timeout(300)
            await page.locator('glimmer-ui >> [data-act=panel]').click()
            frame = None
            for _ in range(20):
                frame = next((f for f in page.frames if 'panel/panel.html' in f.url), None)
                if frame:
                    break
                await asyncio.sleep(0.2)
            check('悬浮球菜单打开侧边面板', frame is not None)
            await frame.wait_for_selector('.hero')
            await page.wait_for_timeout(400)
            await page.screenshot(path=f'{OUTPUT}/drawer.png')
            await frame.locator('.hero [data-act=togglePage]').click()
            n = await wait_count(page, 9)
            check('在面板中开启整页翻译', n >= 9, f'{n} 段')
            await page.locator('glimmer-ui >> .ball').click()
            await page.wait_for_timeout(500)
            on = await frame.locator('.hero [data-act=togglePage]').is_checked()
            check('悬浮球关闭翻译后面板状态同步', on is False)

            box = await page.locator('#sel').bounding_box()
            await page.mouse.move(box['x'] + 2, box['y'] + 10)
            await page.mouse.down()
            await page.mouse.move(box['x'] + 60, box['y'] + 10, steps=5)
            await page.mouse.up()
            await page.wait_for_timeout(300)
            await page.locator('glimmer-ui >> .sel-icon').click()
            await page.wait_for_timeout(2000)
            await page.locator('glimmer-ui >> .p-save').click()
            await page.wait_for_timeout(500)
            saved = await page.locator('glimmer-ui >> .p-save').inner_text()
            check('划词面板收藏单词', '已收藏' in saved, saved)
            cnt = await frame.locator('.stat b').first.inner_text()
            check('面板生词数实时更新', cnt == '1', cnt)
            await page.keyboard.press('Escape')
            await page.wait_for_timeout(300)
            await page.screenshot(path=f'{OUTPUT}/drawer-words.png')
            await frame.locator('.rail [data-act=close]').click()
            await page.wait_for_timeout(500)
            check('点击关闭按钮收起面板', await page.evaluate("!document.querySelector('glimmer-ui').shadowRoot.querySelector('.drawer')"))
            await page.close()

        # ---------- 总是翻译网站规则 ----------
        if run('always'):
            print('\n[always] 网站规则')
            await sw.evaluate(SET, {'alwaysSites': ['127.0.0.1'], 'neverSites': []})
            page = await ctx.new_page()
            await page.goto(LOCAL)
            n = await wait_count(page, 9, 10000)
            check('“总是翻译”网站打开即翻译', n >= 9, f'{n} 段')
            await sw.evaluate(SET, {'alwaysSites': ['127.0.0.1'], 'neverSites': ['127.0.0.1']})
            await page.reload()
            await page.wait_for_timeout(2500)
            n = await page.evaluate("document.querySelectorAll('gl-trans').length")
            check('“永不翻译”优先级更高', n == 0, n)
            await sw.evaluate(SET, {'alwaysSites': [], 'neverSites': []})
            await page.close()

        # ---------- 导入示例配置 ----------
        if run('import'):
            print('\n[import] 导入设置')
            op = await ctx.new_page()
            op.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
            await op.goto(f'chrome-extension://{eid}/options/options.html')
            await op.wait_for_timeout(500)
            await op.locator('#importFile').set_input_files(os.path.join(ROOT, 'docs', 'settings.example.json'))
            await op.wait_for_timeout(800)
            s = await sw.evaluate("chrome.storage.local.get('settings').then(r=>r.settings)")
            check('导入后网站规则生效', s.get('alwaysSites') == ['news.ycombinator.com', 'medium.com'], s.get('alwaysSites'))
            check('导入后设置页同步刷新', await op.locator('textarea[data-path=alwaysSites]').input_value() == 'news.ycombinator.com\nmedium.com')
            await sw.evaluate(SET, {'alwaysSites': [], 'neverSites': []})
            await op.close()

        # ---------- 译文样式实时切换 ----------
        if run('style'):
            print('\n[style] 译文样式')
            page = await ctx.new_page()
            await page.goto(LOCAL)
            await page.wait_for_timeout(500)
            await sw.evaluate(TAB, ['127.0.0.1', {'type': 'setPage', 'on': True}])
            await wait_count(page, 9)
            for style, prop, expect in [('blur', 'filter', 'blur'), ('highlight', 'backgroundColor', '0.18'), ('underline', 'textDecorationLine', 'underline')]:
                await sw.evaluate(SET, {'transStyle': style})
                await page.wait_for_timeout(400)
                v = await page.evaluate(f"getComputedStyle(document.querySelector('p gl-trans .gl-t')).{prop}")
                check(f'样式 {style} 实时生效', expect in v, v)
            await sw.evaluate(SET, {'transStyle': 'none'})
            await page.close()

        # ---------- 右键菜单入口（消息） ----------
        if run('ctxmenu'):
            print('\n[ctxmenu] 右键“翻译选中文字”')
            page = await ctx.new_page()
            await page.goto(LOCAL)
            await page.wait_for_timeout(500)
            await sw.evaluate(TAB, ['127.0.0.1', {'type': 'translateSelection', 'text': 'Practice makes perfect.'}])
            await page.wait_for_timeout(2500)
            out = await page.locator('glimmer-ui >> .p-out').inner_text()
            check('面板弹出并显示译文', len(out.strip()) > 1 and '熟能生巧' in out or any('一' <= c <= '鿿' for c in out), out)
            menus = await sw.evaluate("new Promise(r=>chrome.contextMenus.update('toggle-page',{},()=>r(!chrome.runtime.lastError)))")
            check('右键菜单已注册', menus)
            await page.close()

        await ctx.close()

    failed = [n for n, ok in results if not ok]
    print(f'\n结果：{len(results) - len(failed)}/{len(results)} 通过')
    if failed:
        print('失败项：' + '；'.join(failed))
    sys.exit(1 if failed else 0)


asyncio.run(main())
