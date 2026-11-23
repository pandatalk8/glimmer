"""真实网站与交互功能测试（需要联网，使用 Google 免费引擎）。

用法：python3 tests/e2e_real.py [--headed] [--only 名称,名称]
场景：wiki hn mdn hover yt input popup drawer toolbar preline webcomp build always import style ctxmenu
"""
import asyncio, functools, http.server, json, os, sys, tempfile, threading
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
            # 带链接的文字：段落内链接、整卡透明链接下的标题（Reddit 写法）、块级链接
            await page.goto('http://127.0.0.1:8765/links.html')
            await page.wait_for_timeout(600)
            # 检查译文出现在用户看到的那个标题 / 段落里，而不是叠在上面的透明元素里
            cases = [('#inlineLink a', '#inlineLink', '段落内的链接'),
                     ('#cardTitle a', '#cardTitle', '盖着整卡透明链接的标题（Reddit 写法）'),
                     ('#card2Title a', '#card2Title', '整卡链接里的透明读屏文字正好叠在标题上'),
                     ('#blockLink', '#blockLink', '块级链接')]
            for sel, box_sel, name in cases:
                b = await page.locator(sel).bounding_box()
                await page.mouse.move(b['x'] + 20, b['y'] + b['height'] / 2)
                await page.keyboard.press('Alt')
                q = f"document.querySelectorAll('{box_sel} gl-trans:not(.gl-loading):not(.gl-error)').length"
                for _ in range(20):
                    await page.wait_for_timeout(250)
                    if await page.evaluate(q):
                        break
                check(f'按 Alt 指向{name}：译文出现在它下方', await page.evaluate(q) == 1)
            await page.close()

        # ---------- YouTube 双语字幕（真实页面 + 模拟字幕数据）----------
        # 自动化浏览器里 YouTube 返回空字幕，所以用与 yt-hook.js 相同的消息格式送入一份字幕
        if run('yt'):
            print('\n[yt] YouTube 双语字幕：显示、关闭再开启、YouTube 自动翻译的字幕')
            page = await ctx.new_page()
            await page.goto('https://www.youtube.com/watch?v=arj7oStGLkU', wait_until='domcontentloaded', timeout=60000)
            await page.wait_for_selector('#movie_player', timeout=30000)
            await page.evaluate("document.querySelector('video')?.pause()")
            await page.wait_for_timeout(3000)  # 等内容脚本里的字幕模块就绪（它在 content.js 初始化后才开始监听）
            CAP = json.dumps({'events': [{'tStartMs': 0, 'dDurationMs': 3600000, 'segs': [{'utf8': 'Knowledge is power.'}]}]})
            POST = """([url, body])=>window.postMessage({source:'glimmer-yt', url, body}, '*')"""
            SUB = """()=>document.querySelector('#movie_player glimmer-ui')?.shadowRoot?.querySelector('.yt-sub')?.innerText||''"""
            async def sub_text(want_lines, tries=30):
                t = ''
                for _ in range(tries):
                    t = await page.evaluate(SUB)
                    if t and '…' not in t and t.count('\n') + 1 >= want_lines:
                        break
                    await page.wait_for_timeout(300)
                return t
            await sw.evaluate(SET, {'displayMode': 'bilingual', 'youtube': {'enabled': True}})
            await page.evaluate(POST, ['https://www.youtube.com/api/timedtext?v=arj7oStGLkU&lang=en&fmt=json3', CAP])
            t = await sub_text(2)
            check('双语字幕：英文原文 + 中文译文两行', 'Knowledge is power.' in t and '知识' in t, t)
            check('隐藏 YouTube 自带字幕', await page.evaluate("!!document.getElementById('glimmer-yt-style')"))
            await sw.evaluate(SET, {'youtube': {'enabled': False}})
            await page.wait_for_timeout(800)
            check('关闭双语字幕：我们的字幕消失、自带字幕恢复',
                  await page.evaluate(SUB) == '' and not await page.evaluate("!!document.getElementById('glimmer-yt-style')"))
            await sw.evaluate(SET, {'youtube': {'enabled': True}})
            t = await sub_text(2)
            check('再次开启：不用重新加载视频，双语字幕恢复', 'Knowledge is power.' in t and '知识' in t, t)
            await sw.evaluate(SET, {'displayMode': 'translation'})
            await page.wait_for_timeout(800)
            t = await sub_text(2)
            check('网页设为“仅显示译文”时，字幕仍显示原文 + 译文两行', 'Knowledge is power.' in t and '知识' in t, t)
            await sw.evaluate(SET, {'displayMode': 'bilingual'})
            # 播放器开着“自动翻译成中文”：截到的已是中文（带 tlang），取不到原文时只显示一行，不再重复翻译
            ZH = json.dumps({'events': [{'tStartMs': 0, 'dDurationMs': 3600000, 'segs': [{'utf8': '知识就是力量。'}]}]})
            await page.evaluate(POST, ['https://www.youtube.com/api/timedtext?v=arj7oStGLkU&lang=en&tlang=zh-Hans&fmt=json3&glimmer_test=1', ZH])
            for _ in range(40):  # 插件会先尝试取原文字幕（异步），等字幕切换过来
                t = await page.evaluate(SUB)
                if '知识就是力量' in t:
                    break
                await page.wait_for_timeout(300)
            await page.wait_for_timeout(1500)
            t = await page.evaluate(SUB)
            check('YouTube 自动翻译的中文字幕：只显示一行，不重复翻译', t.strip() == '知识就是力量。', t)
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
            # 翻译要一两秒：按下第三个空格后，应立刻去掉空格并在输入框旁显示“翻译中…”
            snap = await page.evaluate("""()=>({v:document.querySelector('#box').value,
              badge:document.querySelector('glimmer-ui').shadowRoot.querySelector('.input-badge')?.textContent||''})""")
            check('三空格后立刻去掉空格并显示“翻译中…”（不会让人以为只打出了三个空格）',
                  not snap['v'].endswith('   ') and (snap['badge'] == '翻译中…' or all(ord(c) < 128 for c in snap['v'])), snap)
            for _ in range(32):  # 网络慢时最多等 8 秒
                if await page.locator('glimmer-ui >> .input-badge').count() == 0:
                    break
                await page.wait_for_timeout(250)
            check('翻译完成后“翻译中…”标签消失', await page.locator('glimmer-ui >> .input-badge').count() == 0)
            v = await page.locator('#box').input_value()
            check('textarea 内容被替换为英文', v and all(ord(c) < 128 for c in v) and len(v) > 5, v)
            await page.locator('#inp').click()
            await page.keyboard.type('你好世界')
            await page.keyboard.type('   ')
            await page.wait_for_timeout(2500)
            v = await page.locator('#inp').input_value()
            check('input 内容被替换为英文', v and 'hello' in v.lower(), v)
            # 更难的输入框：在 shadow DOM 里（Reddit 搜索框）、网站阻止按键事件冒泡、中文输入法的全角空格
            await page.evaluate("""()=>{
              const host=document.createElement('search-box'); document.body.prepend(host);
              host.attachShadow({mode:'open'}).innerHTML='<input id="sh" type="text">';
              const s=document.createElement('input'); s.id='stop'; s.type='search'; document.body.prepend(s);
              s.addEventListener('keyup', e=>e.stopPropagation()); s.addEventListener('keydown', e=>e.stopPropagation());
              const f=document.createElement('input'); f.id='full'; document.body.prepend(f);}""")
            await page.locator('search-box').locator('#sh').click()
            await page.keyboard.type('你好世界')
            await page.keyboard.type('   ')
            await page.wait_for_timeout(2500)
            v = await page.evaluate("document.querySelector('search-box').shadowRoot.querySelector('#sh').value")
            check('shadow DOM 里的输入框（Reddit 搜索框写法）也能三空格翻译', v and 'hello' in v.lower(), v)
            await page.locator('#stop').click()
            await page.keyboard.type('你好世界')
            await page.keyboard.type('   ')
            await page.wait_for_timeout(2500)
            v = await page.locator('#stop').input_value()
            check('网站阻止按键事件冒泡时也能三空格翻译', v and 'hello' in v.lower(), v)
            await page.locator('#full').click()
            await page.keyboard.insert_text('你好世界　　')
            await page.keyboard.type(' ')
            await page.wait_for_timeout(2500)
            v = await page.locator('#full').input_value()
            check('中文输入法的全角空格也算', v and 'hello' in v.lower(), v)
            # 翻译期间用户继续打字：不能用译文覆盖用户刚输入的内容
            await page.locator('#full').fill('')
            await page.keyboard.type('今晚一起吃饭吗')
            await page.keyboard.type('   ')
            await page.keyboard.type('xyz')
            await page.wait_for_timeout(2500)
            v = await page.locator('#full').input_value()
            check('翻译期间继续打字：保留用户输入，不被译文覆盖', v.endswith('xyz') and '今晚' in v, v)
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
            head = await pp.locator('.quick .q-head').inner_text()
            check('快速翻译有标题“快速翻译”和“翻译”按钮（一眼看得出是输入框）',
                  '快速翻译' in head and await pp.locator('.quick [data-act=quick]').count() == 1, head)
            await pp.locator('#quickInput').fill('Good morning')
            await pp.locator('.quick [data-act=quick]').click()
            out = await quick_result(pp)
            check('点“翻译”按钮也能翻译', '早' in out, out)
            await pp.locator('.quick').screenshot(path=f'{OUTPUT}/panel-quick.png')

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
            tags = await pp.locator('.opt .tag').all_inner_texts()
            check('引擎选项标注会员等级', 'Premium' in tags and 'Premium+' in tags, tags)
            await pp.locator('[data-set=deepl]').click()
            await pp.wait_for_selector('.upsell', timeout=3000)
            await pp.wait_for_timeout(400)  # 等滑入动画结束再截图
            up = await pp.locator('.up-card').inner_text()
            await pp.screenshot(path=f'{OUTPUT}/panel-upsell.png')
            check('免费版选择 DeepL：面板内弹出升级提示卡（等级、价格、权益），不直接跳转',
                  'DeepL 需要 Premium 会员' in up and '$29 / 年' in up and '查看会员方案' in up and '以后再说' in up
                  and not any('premium/premium.html' in x.url for x in ctx.pages), up.replace('\n', ' / '))
            await pp.locator('[data-up=close]').click()
            check('“以后再说”关闭提示卡', await pp.locator('.upsell').count() == 0)
            await pp.locator('[data-set=deepl]').click()
            await pp.locator('[data-up=go]').click()
            prem = None
            for _ in range(25):
                prem = next((x for x in ctx.pages if 'premium/premium.html' in x.url), None)
                if prem:
                    break
                await asyncio.sleep(0.2)
            eng = await sw.evaluate("chrome.storage.local.get('settings').then(r=>r.settings.engine)")
            check('点“查看会员方案”才打开方案页，引擎仍为 Google', prem is not None and eng == 'google', eng)
            if prem:
                await prem.close()
            if not pp.is_closed():
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

        # ---------- 工具栏图标开关侧面板 + 本页生词 ----------
        if run('toolbar'):
            print('\n[toolbar] 工具栏图标开关侧面板、本页生词')
            await sw.evaluate("""()=>chrome.storage.local.set({words:[
              {w:'vocabulary',t:'词汇',ts:3},{w:'grammar',t:'语法',ts:2},{w:'Learners',t:'学习者',ts:1},
              {w:'serendipity',t:'意外发现',ts:0},{w:'comprehensible input',t:'可理解输入',ts:4}]})""")
            page = await ctx.new_page()
            await page.goto(LOCAL)
            await page.wait_for_timeout(600)
            click = """async ()=>{const [t]=await chrome.tabs.query({url:'http://127.0.0.1:8765/*'});return self.__glimmerActionClick(t)}"""
            r = await sw.evaluate(click)
            check('点击工具栏图标在网页内打开侧面板', r == 'drawer', r)
            frame = None
            for _ in range(20):
                frame = next((f for f in page.frames if 'panel/panel.html' in f.url), None)
                if frame:
                    break
                await asyncio.sleep(0.2)
            await frame.wait_for_selector('.words-card .wl-head')
            await page.wait_for_timeout(400)
            box = await page.evaluate("""()=>{const r=document.querySelector('glimmer-ui').shadowRoot.querySelector('.drawer').getBoundingClientRect();
              return [r.top, Math.round(innerHeight-r.bottom), Math.round(innerWidth-r.right), r.width]}""")
            check('面板贴右边缘、占满全高', box[0] == 0 and box[1] == 0 and box[2] == 0, box)
            head = await frame.locator('.words-card .wl-head').inner_text()
            names = await frame.locator('.words-card .word b').all_inner_texts()
            check('本页生词数量正确（4 个，排除页面上没有的词）', '本页生词' in head and len(names) == 4, f'{head!r} {names}')
            check('本页生词按字母排序', names == sorted(names, key=str.lower), names)
            await frame.locator('[data-act=expand]').click()
            await page.wait_for_timeout(200)
            trans = await frame.locator('.words-card .word small').all_inner_texts()
            check('展开释义显示译文', '语法' in trans and len(trans) == 4, trans)
            await page.screenshot(path=f'{OUTPUT}/toolbar-drawer.png')
            await frame.locator('.words-card .word:has(b:text("grammar")) [data-act=master]').click()
            await page.wait_for_timeout(300)
            m = await sw.evaluate("chrome.storage.local.get('words').then(r=>r.words.find(w=>w.w==='grammar').m)")
            check('标记已掌握', m is True, m)
            await frame.locator('.words-card .word:has(b:text("vocabulary")) [data-act=unsave]').click()
            await page.wait_for_timeout(400)
            names = await frame.locator('.words-card .word b').all_inner_texts()
            check('取消收藏后从本页生词移除', 'vocabulary' not in names and len(names) == 3, names)
            r = await sw.evaluate(click)
            await page.wait_for_timeout(500)
            gone = await page.evaluate("!document.querySelector('glimmer-ui').shadowRoot.querySelector('.drawer')")
            check('再次点击工具栏图标收起侧面板', r == 'drawer' and gone, r)
            await page.close()

            cp = await ctx.new_page()
            await cp.goto('chrome://version')
            await cp.wait_for_timeout(500)
            r = await sw.evaluate("""async ()=>{const t=(await chrome.tabs.query({})).find(t=>!t.url);
              const how=await self.__glimmerActionClick(t);const p=await chrome.action.getPopup({tabId:t.id});return [how,p]}""")
            check('浏览器内置页面退回弹窗形态', r[1].endswith('panel/panel.html'), r)
            # 提前设定：不点击也已是弹窗模式（点击后再判断会因手势过期打不开）
            pre = await sw.evaluate("""async ()=>{const ts=await chrome.tabs.query({});const out={};
              for (const t of ts){out[t.url||'(内置页)']=await chrome.action.getPopup({tabId:t.id});} return out}""")
            check('内置页、插件设置页提前设为弹窗，普通网页保持侧面板', any(k=='(内置页)' and v.endswith('panel.html') for k,v in pre.items())
                  and all(v=='' for k,v in pre.items() if k.startswith('http')), pre)
            await cp.close()

        # ---------- Web Components 网站（如 Reddit）：自定义元素不能被隐藏 ----------
        if run('preline'):
            print('\n[preline] 靠换行分段的文字（Product Hunt 评论）')
            page = await ctx.new_page()
            await page.goto('http://127.0.0.1:8765/preline.html')
            await page.wait_for_timeout(800)
            await sw.evaluate("""async ()=>{const t=(await chrome.tabs.query({})).find(t=>t.url&&t.url.includes('preline'));
              await chrome.tabs.sendMessage(t.id,{type:'setPage',on:true})}""")
            await wait_count(page, 2)
            r = await page.evaluate("""()=>{const g=document.querySelector('#c gl-trans');const t=g?.querySelector('.gl-t')?.textContent||'';
              return {pre:g?.classList.contains('gl-pre'),ws:g&&getComputedStyle(g).whiteSpace,lines:t.split('\\n'),
                      normal:document.querySelectorAll('#normal gl-trans.gl-pre').length,
                      src:document.querySelector('#c').firstChild.nodeType===3&&document.querySelector('#c').childNodes.length}}""")
            lines = r['lines']
            check('按行翻译：译文保留原文的 5 段与段间空行', len(lines) == 9 and all(lines[i] for i in (0, 2, 4, 6, 8))
                  and not any(lines[i] for i in (1, 3, 5, 7)), lines)
            check('小标题单独成行（📺、🎧 开头）', lines[2].startswith('📺') and lines[6].startswith('🎧'), lines[2][:20])
            check('译文为中文，且以 pre-line 显示', r['pre'] and r['ws'] == 'pre-line' and all(any('一' <= ch <= '鿿' for ch in lines[i]) for i in (0, 4, 8)))
            check('不改动原文的文字节点；普通段落仍整段翻译', r['src'] == 2 and r['normal'] == 0, r['src'])
            await page.screenshot(path=f'{OUTPUT}/preline.png')
            await page.close()

        if run('webcomp'):
            print('\n[webcomp] 隐藏未注册自定义元素的网站')
            page = await ctx.new_page()
            await page.goto('http://127.0.0.1:8765/webcomponents.html')
            await page.wait_for_timeout(800)
            vis = "(sel)=>{const e=document.querySelector(sel);return e?getComputedStyle(e).visibility:'none'}"
            check('悬浮球所在的 glimmer-ui 可见', await page.evaluate(vis, 'glimmer-ui') == 'visible')
            r = await sw.evaluate("""async ()=>{const t=(await chrome.tabs.query({})).find(t=>t.url&&t.url.includes('webcomponents'));
              return self.__glimmerActionClick(t)}""")
            await page.wait_for_timeout(800)
            ok = await page.evaluate("""()=>{const d=document.querySelector('glimmer-ui').shadowRoot.querySelector('.drawer');
              return !!d && getComputedStyle(d).visibility==='visible'}""")
            check('侧面板打开且可见', r == 'drawer' and ok, r)
            await sw.evaluate("""async ()=>{const t=(await chrome.tabs.query({})).find(t=>t.url&&t.url.includes('webcomponents'));
              await self.__glimmerActionClick(t); await chrome.tabs.sendMessage(t.id,{type:'setPage',on:true})}""")
            await wait_count(page, 2)
            check('网页译文 gl-trans 可见', await page.evaluate(vis, 'gl-trans') == 'visible')
            await page.screenshot(path=f'{OUTPUT}/webcomponents.png')
            await page.close()

        # ---------- 当前加载版本与“需要刷新”提示 ----------
        if run('build'):
            print('\n[build] 版本显示与刷新提示')
            bpath = os.path.join(ROOT, 'build.json')
            original = open(bpath, encoding='utf-8').read() if os.path.exists(bpath) else None
            op = await ctx.new_page()
            try:
                await op.goto(f'chrome-extension://{eid}/options/options.html#advanced')
                await op.wait_for_timeout(800)
                info = await op.evaluate("chrome.runtime.sendMessage({type:'buildInfo'}).then(r=>r.data)")
                commit = json.loads(original)['commit'] if original else None
                shown = await op.locator('#buildVal').inner_text()
                check('设置页显示当前加载的版本', (commit or info['loaded']['fp']) in shown, shown)
                check('刚加载时不提示刷新', not info['stale'] and await op.locator('#staleBar').is_hidden())
                with open(bpath, 'w', encoding='utf-8') as f:  # 模拟磁盘上的代码已更新
                    f.write(json.dumps({'commit': 'abc1234', 'time': '2026-11-20T10:00:00+08:00', 'branch': 'dev'}))
                await op.reload()
                await op.wait_for_timeout(800)
                shown = await op.locator('#buildVal').inner_text()
                check('代码更新后设置页提示需要刷新', await op.locator('#staleBar').is_visible() and 'abc1234' in shown, shown)
                pp = await ctx.new_page()
                await pp.goto(f'chrome-extension://{eid}/panel/panel.html')
                await pp.wait_for_timeout(600)
                check('代码更新后面板首页显示刷新提示', await pp.locator('.stale-bar').count() == 1)
                await pp.close()
            finally:
                if original is None:
                    os.remove(bpath)
                else:
                    open(bpath, 'w', encoding='utf-8').write(original)
            await op.close()

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
