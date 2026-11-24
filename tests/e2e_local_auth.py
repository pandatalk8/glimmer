"""本地后端回归：只能在本地验证的账户用例（docs/test-cases.md 的 A-05b、A-10、C-12c）。

- A-05b 重新发送验证邮件、A-10 忘记密码：需要收邮件，本地 Supabase 的邮件都进 Mailpit，不受云端发信额度限制
- C-12c 付费引擎出故障时：把后端切到一个没有启动的地址，模拟后端故障

前提：npx supabase start；npx supabase functions serve --env-file supabase/functions/.env（C-12c 恢复后用 DeepSeek 真实翻译）
用法：python3 tests/e2e_local_auth.py [--headed]
"""
import asyncio, functools, http.server, json, os, re, subprocess, sys, tempfile, threading, time, urllib.request, uuid
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT = os.path.join(ROOT, 'tests', 'output')
HEADED = '--headed' in sys.argv
st = json.loads(subprocess.run(['npx', '-y', 'supabase@3.2.0', 'status', '-o', 'json'], cwd=ROOT, capture_output=True, text=True).stdout or '{}')
if not st.get('API_URL'):
    sys.exit('本地 Supabase 没有运行：先执行 npx supabase start')
API, PUB, MAIL, DB = st['API_URL'], st['PUBLISHABLE_KEY'], st['MAILPIT_URL'], st['DB_URL']
DOWN = 'http://127.0.0.1:59999'  # 没有服务在监听：模拟后端故障
ARTICLE = 'http://127.0.0.1:8768/article.html'
results = []

http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8768), functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.join(ROOT, 'tests', 'fixtures')))
threading.Thread(target=srv.serve_forever, daemon=True).start()


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('  PASS  ' if ok else '  FAIL  ') + name + (f'  ({detail})' if detail != '' else ''))


def sql(q):
    return subprocess.run(['psql', DB, '-At', '-c', q], capture_output=True, text=True).stdout.strip()


def mails(to):
    with urllib.request.urlopen(f'{MAIL}/api/v1/search?query=to:{to}') as r:
        return json.loads(r.read()).get('messages', [])


def mail_html(mid):
    with urllib.request.urlopen(f'{MAIL}/api/v1/message/{mid}') as r:
        return json.loads(r.read()).get('HTML', '')


def link_of(html):
    m = re.search(r'href="([^"]*/auth/v1/verify[^"]*)"', html)
    return m.group(1).replace('&amp;', '&') if m else None


async def wait_for(fn, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        v = await fn()
        if v:
            return v
        await asyncio.sleep(0.5)
    return await fn()


def poll(fn, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(0.5)
    return fn()


async def main():
    os.makedirs(OUTPUT, exist_ok=True)
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            tempfile.mkdtemp(prefix='glimmer-local-auth-'), channel='chromium', headless=not HEADED,
            args=[f'--disable-extensions-except={ROOT}', f'--load-extension={ROOT}'], viewport={'width': 1200, 'height': 900})
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        eid = sw.url.split('/')[2]
        await asyncio.sleep(1.5)
        for pg in ctx.pages:
            await pg.close()
        await sw.evaluate('(o)=>chrome.storage.local.set({backendOverride:o})', {'supabaseUrl': API, 'supabaseAnonKey': PUB})

        async def panel(view='account'):
            pp = await ctx.new_page()
            await pp.set_viewport_size({'width': 400, 'height': 640})
            await pp.goto(f'chrome-extension://{eid}/panel/panel.html?view={view}')
            await pp.wait_for_timeout(600)
            return pp

        msg = lambda pp: pp.locator('#authForm .msg').inner_text()

        # ---------- A-05b 重新发送验证邮件 ----------
        print('[A-05b] 重新发送验证邮件')
        email, pw = f'resend-{uuid.uuid4().hex[:6]}@test.local', 'secret123'
        pp = await panel()
        await pp.locator('[data-act=authMode][data-mode=signup]').click()
        await pp.fill('[name=email]', email)
        await pp.fill('[name=password]', pw)
        await pp.locator('.submit').click()
        await wait_for(lambda: pp.locator('.msg.ok').count(), 15)
        first = poll(lambda: mails(email), 15)
        if await pp.locator('[data-act=authMode][data-mode=signin]').count():  # 注册后可能已自动回到登录页
            await pp.locator('[data-act=authMode][data-mode=signin]').click()
        await pp.fill('[name=email]', email)
        await pp.fill('[name=password]', pw)
        await pp.locator('.submit').click()
        await wait_for(lambda: pp.locator('#authForm [data-act=resendConfirm]').count(), 15)
        before = await msg(pp)
        await pp.locator('#authForm [data-act=resendConfirm]').click()
        told = await wait_for(lambda: _has(pp, '验证邮件已重新发送到'), 20)
        allm = poll(lambda: (lambda m: m if len(m) >= 2 else None)(mails(email)), 30) or mails(email)
        check('A-05b 未验证登录时出现“重新发送验证邮件”，点击后提示“验证邮件已重新发送到 …，请查收（也看看垃圾邮件），点击最新一封邮件中的链接”',
              '邮箱尚未验证' in before and told and f'验证邮件已重新发送到 {email}' in told and '点击最新一封邮件中的链接' in told, (told or before)[:60])
        check('A-05b Mailpit 收到第二封验证邮件', len(first or []) == 1 and len(allm) >= 2, f'{len(allm)} 封')
        # Mailpit 按时间倒序：[0] 最新
        new_link, old_link = link_of(mail_html(allm[0]['ID'])), link_of(mail_html(allm[-1]['ID']))
        vp = await ctx.new_page()
        try:
            await vp.goto(old_link, timeout=15000)
        except Exception:
            pass
        await vp.wait_for_timeout(1500)
        old_url = vp.url
        try:
            await vp.goto(new_link, timeout=15000)
        except Exception:
            pass
        await vp.wait_for_timeout(1500)
        new_url = vp.url
        confirmed = sql(f"select email_confirmed_at is not null from auth.users where email='{email}'")
        check('A-05b 旧邮件中的链接失效，最新一封的链接验证成功', ('error' in old_url or 'expired' in old_url) and confirmed == 't',
              f'旧链接 → {old_url[-60:]}；验证状态 {confirmed}')
        await vp.close()
        await pp.close()

        # ---------- A-10 忘记密码 ----------
        print('\n[A-10] 忘记密码')
        pp = await panel()
        await pp.fill('[name=email]', email)
        n0 = len(mails(email))
        await pp.locator('[data-act=forgot]').click()
        told = await wait_for(lambda: _has(pp, '重置密码邮件已发送到'), 20)
        got = poll(lambda: (lambda m: m if len(m) > n0 else None)(mails(email)), 30)
        subj = got[0].get('Subject', '') if got else ''
        check('A-10 登录页点“忘记密码？”：提示“重置密码邮件已发送到 …”，Mailpit 收到重置邮件', told and f'重置密码邮件已发送到 {email}' in told and got,
              f'{(told or "")[:30]} / 主题：{subj}')
        await pp.close()

        # ---------- C-12c 付费引擎出故障时 ----------
        print('\n[C-12c] 付费引擎出故障时（后端连不上）')
        sql(f"update profiles set plan='premium_plus' where email='{email}'")
        pp = await panel()
        r = await pp.evaluate("(m)=>chrome.runtime.sendMessage(m)", {'type': 'accountSignIn', 'email': email, 'password': pw})
        await pp.evaluate("chrome.runtime.sendMessage({type:'accountRefresh'})")
        await pp.close()
        await sw.evaluate("()=>chrome.storage.local.get('settings').then(r=>chrome.storage.local.set({settings:{...(r.settings||{}),engine:'deepseek'}}))")
        await sw.evaluate('(o)=>chrome.storage.local.set({backendOverride:o})', {'supabaseUrl': DOWN, 'supabaseAnonKey': PUB})
        web = await ctx.new_page()
        await web.goto(ARTICLE)
        await web.wait_for_timeout(800)
        await sw.evaluate("""async ()=>{const t=(await chrome.tabs.query({})).find(t=>t.url&&t.url.includes('article.html'));
          await chrome.tabs.sendMessage(t.id,{type:'setPage',on:true})}""")
        done = await wait_for(lambda: web.evaluate("""()=>{const g=[...document.querySelectorAll('gl-trans')];
          return g.length && !g.some(x=>x.classList.contains('gl-loading')) ? g.length : 0}"""), 40)
        errs = await web.evaluate("document.querySelectorAll('gl-trans.gl-error').length")
        shadow = await web.evaluate("()=>document.querySelector('glimmer-ui')?.shadowRoot?.textContent||''")
        btn = await web.evaluate("()=>[...(document.querySelector('glimmer-ui')?.shadowRoot?.querySelectorAll('.toast button')||[])].map(b=>b.textContent)")
        await web.screenshot(path=f'{OUTPUT}/local-c12c.png')
        check('C-12c 后端连不上时整页仍用 Google 翻译完成，没有“翻译失败”；网页提示“DeepSeek 暂时无法使用，已改用 Google 翻译”（不带按钮）',
              done >= 3 and errs == 0 and 'DeepSeek 暂时无法使用，已改用 Google 翻译' in shadow and not btn, f'{done} 段，失败 {errs}，按钮 {btn}')
        await web.close()
        await sw.evaluate('(o)=>chrome.storage.local.set({backendOverride:o})', {'supabaseUrl': API, 'supabaseAnonKey': PUB})
        pp = await panel()
        r = await pp.evaluate("chrome.runtime.sendMessage({type:'translate',texts:['Good morning, my friend.'],to:'zh-CN',noCache:true})")
        check('C-12c 恢复后端后重新翻译即恢复 DeepSeek（经本地后端返回中文）',
              r.get('ok') and any('一' <= ch <= '鿿' for ch in r['data'][0]), (r.get('data') or [r.get('error')])[0])
        await pp.close()
        await ctx.close()
    srv.shutdown()
    failed = [n for n, ok in results if not ok]
    print(f'\n结果：{len(results) - len(failed)}/{len(results)} 通过')
    if failed:
        print('失败项：' + '；'.join(failed))
    sys.exit(1 if failed else 0)


async def _has(pp, text):
    t = await pp.locator('#authForm .msg').inner_text() if await pp.locator('#authForm .msg').count() else ''
    return t if text in t else None


asyncio.run(main())
