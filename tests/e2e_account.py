"""账户与订阅端到端测试：用本地模拟的 Supabase 接口（Auth / REST / Edge Functions）驱动面板。

用法：python3 tests/e2e_account.py [--headed]
不需要真实的 Supabase 项目和 Stripe 密钥；真实联调见 docs/backend.md。
"""
import asyncio, http.server, json, os, sys, tempfile, threading, time, uuid
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT = os.path.join(ROOT, 'tests', 'output')
HEADED = '--headed' in sys.argv
PORT = 8768
BASE = f'http://127.0.0.1:{PORT}'
ANON = 'anon-test-key'


# ---------------- 模拟 Supabase ----------------
class DB:
    users = {}      # email -> {id, password, confirmed}
    tokens = {}     # access_token -> user_id
    refresh = {}    # refresh_token -> user_id
    profiles = {}   # user_id -> profile
    calls = []      # (method, path)
    expires_in = 3600


def session_for(uid, email):
    at, rt = 'at-' + uuid.uuid4().hex, 'rt-' + uuid.uuid4().hex
    DB.tokens[at] = uid
    DB.refresh[rt] = uid
    return {'access_token': at, 'refresh_token': rt, 'expires_in': DB.expires_in, 'token_type': 'bearer',
            'user': {'id': uid, 'email': email}}


class Mock(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body=None, ctype='application/json'):
        data = (json.dumps(body) if ctype == 'application/json' else body or '').encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(data)

    def user(self):
        tok = (self.headers.get('Authorization') or '').replace('Bearer ', '')
        return DB.tokens.get(tok)

    def do_OPTIONS(self):
        self.send(200, {})

    def do_GET(self):
        u = urlparse(self.path)
        DB.calls.append(('GET', u.path))
        if u.path == '/functions/v1/billing-return':
            return self.send(200, '<h1>ok</h1>', 'text/html')
        if u.path in ('/fake-stripe/checkout', '/fake-stripe/portal'):
            return self.send(200, '<h1>Stripe</h1>', 'text/html')
        if self.headers.get('apikey') != ANON:
            return self.send(401, {'message': 'No API key found in request'})
        if u.path == '/rest/v1/profiles':
            uid = self.user()
            if not uid:
                return self.send(401, {'message': 'JWT expired'})
            want = parse_qs(u.query)['id'][0].replace('eq.', '')
            return self.send(200, [DB.profiles[uid]] if want == uid else [])
        self.send(404, {'message': 'not found'})

    def do_POST(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'{}')
        DB.calls.append(('POST', u.path + ('?' + u.query if u.query else '')))
        if self.headers.get('apikey') != ANON:
            return self.send(401, {'message': 'No API key found in request'})
        # 新版 publishable key 不是 JWT，放进 Authorization 会被 Supabase 拒绝
        if self.headers.get('Authorization') == 'Bearer ' + ANON:
            return self.send(401, {'message': 'Invalid JWT: publishable key used as Authorization'})
        if u.path == '/auth/v1/signup':
            email = body['email']
            if email in DB.users:
                return self.send(422, {'code': 422, 'msg': 'User already registered'})
            uid = str(uuid.uuid4())
            confirm = email.startswith('confirm')
            DB.users[email] = {'id': uid, 'password': body['password'], 'confirmed': not confirm}
            DB.profiles[uid] = {'email': email, 'plan': 'free', 'subscription_status': None, 'current_period_end': None,
                                'cancel_at_period_end': False, 'stripe_customer_id': None}
            if confirm:
                return self.send(200, {'id': uid, 'email': email})
            return self.send(200, session_for(uid, email))
        if u.path == '/auth/v1/token' and q.get('grant_type') == ['password']:
            usr = DB.users.get(body['email'])
            if not usr or usr['password'] != body['password']:
                return self.send(400, {'error': 'invalid_grant', 'error_description': 'Invalid login credentials'})
            if not usr['confirmed']:
                return self.send(400, {'error': 'invalid_grant', 'error_description': 'Email not confirmed'})
            return self.send(200, session_for(usr['id'], body['email']))
        if u.path == '/auth/v1/token' and q.get('grant_type') == ['refresh_token']:
            uid = DB.refresh.pop(body.get('refresh_token'), None)
            if not uid:
                return self.send(400, {'error': 'invalid_grant', 'error_description': 'Invalid Refresh Token'})
            email = next(e for e, x in DB.users.items() if x['id'] == uid)
            return self.send(200, session_for(uid, email))
        if u.path == '/auth/v1/logout':
            return self.send(204, None, 'text/plain')
        if u.path == '/auth/v1/recover':
            return self.send(200, {})
        if u.path.startswith('/functions/v1/'):
            uid = self.user()
            if not uid:
                return self.send(401, {'error': '请先登录'})
            if u.path.endswith('billing-checkout'):
                DB.profiles[uid]['stripe_customer_id'] = 'cus_test'
                return self.send(200, {'url': f'{BASE}/fake-stripe/checkout?interval={body.get("interval")}'})
            if u.path.endswith('billing-portal'):
                return self.send(200, {'url': f'{BASE}/fake-stripe/portal'})
        self.send(404, {'message': 'not found'})


srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Mock)
threading.Thread(target=srv.serve_forever, daemon=True).start()

results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('  PASS  ' if ok else '  FAIL  ') + name + (f'  ({detail})' if detail != '' else ''))


async def wait_for(fn, timeout=8):
    end = time.time() + timeout
    while time.time() < end:
        v = await fn()
        if v:
            return v
        await asyncio.sleep(0.2)
    return await fn()


async def main():
    os.makedirs(OUTPUT, exist_ok=True)
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            tempfile.mkdtemp(prefix='glimmer-acct-'), channel='chromium', headless=not HEADED,
            args=[f'--disable-extensions-except={ROOT}', f'--load-extension={ROOT}'], viewport={'width': 1100, 'height': 900})
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        eid = sw.url.split('/')[2]
        await asyncio.sleep(1.5)
        for pg in ctx.pages:
            await pg.close()
        panel_url = f'chrome-extension://{eid}/panel/panel.html'

        async def open_panel(view='settings'):
            pp = await ctx.new_page()
            await pp.set_viewport_size({'width': 400, 'height': 590})
            await pp.goto(f'{panel_url}?view={view}')
            await pp.wait_for_timeout(500)
            return pp

        msg = lambda pp: pp.locator('.msg').inner_text()

        print('[1] 后端未配置')
        pp = await open_panel()
        check('设置页顶部显示账户行“登录 / 注册”', '登录 / 注册' in await pp.locator('[data-go=account]').inner_text())
        await pp.locator('[data-go=account]').click()
        check('账户页提示服务未配置', '尚未配置' in await pp.locator('.warn').inner_text())
        await pp.close()

        await sw.evaluate("(u)=>chrome.storage.local.set({backendOverride:{supabaseUrl:u,supabaseAnonKey:'anon-test-key'}})", BASE)

        print('\n[2] 注册')
        pp = await open_panel()
        await pp.locator('[data-go=account]').click()
        check('进入账户页显示返回箭头', await pp.locator('.back').count() == 1)
        await pp.screenshot(path=f'{OUTPUT}/account-signin.png')
        await pp.locator('[data-mode=signup]').click()
        await pp.fill('[name=email]', 'alice@example.com')
        await pp.fill('[name=password]', 'secret123')
        await pp.fill('[name=password2]', 'secret999')
        await pp.locator('.submit').click()
        check('两次密码不一致时提示', '不一致' in await msg(pp), await msg(pp))
        await pp.fill('[name=password2]', 'secret123')
        await pp.locator('.submit').click()
        ok = await wait_for(lambda: pp.locator('.acct-info').count())
        check('注册成功后直接登录', ok and 'alice@example.com' in await pp.locator('.acct-info').inner_text())
        check('新用户为免费版，显示升级 Pro', '免费版' in await pp.locator('.plan').inner_text() and await pp.locator('.pro-card').count() == 1)
        await pp.screenshot(path=f'{OUTPUT}/account-free.png')

        print('\n[3] 退出与错误提示')
        await pp.locator('[data-act=signOut]').click()
        await wait_for(lambda: pp.locator('#authForm').count())
        check('退出登录后显示登录表单', await pp.locator('#authForm').count() == 1)
        st = await sw.evaluate("chrome.storage.local.get(['auth','account'])")
        check('退出后本地会话已清除', not st.get('auth') and not st.get('account'), st)
        await pp.fill('[name=email]', 'alice@example.com')
        await pp.fill('[name=password]', 'wrongpass')
        await pp.locator('.submit').click()
        await wait_for(lambda: pp.locator('.msg').count())
        check('密码错误显示中文提示', '邮箱或密码错误' in await msg(pp), await msg(pp))
        await pp.locator('[data-mode=signup]').click()
        await pp.fill('[name=email]', 'alice@example.com')
        await pp.fill('[name=password]', 'secret123')
        await pp.fill('[name=password2]', 'secret123')
        await pp.locator('.submit').click()
        await wait_for(lambda: pp.locator('.msg').count())
        check('重复注册显示“已注册”', '已注册' in await msg(pp), await msg(pp))
        await pp.fill('[name=email]', 'confirm-bob@example.com')
        await pp.fill('[name=password]', 'secret123')
        await pp.fill('[name=password2]', 'secret123')
        await pp.locator('.submit').click()
        await wait_for(lambda: pp.locator('.msg.ok').count())
        check('需要邮箱验证时提示查收邮件', '验证邮件已发送' in await msg(pp), await msg(pp))
        await pp.fill('[name=password]', 'secret123')
        await pp.locator('.submit').click()
        await wait_for(lambda: pp.locator('.msg.err').count())
        check('未验证邮箱登录时提示', '尚未验证' in await msg(pp), await msg(pp))

        print('\n[4] 忘记密码、登录与会话刷新')
        await pp.fill('[name=email]', 'alice@example.com')
        await pp.locator('[data-act=forgot]').click()
        await wait_for(lambda: pp.locator('.msg.ok').count())
        check('忘记密码发送重置邮件', '重置密码邮件已发送' in await msg(pp), await msg(pp))
        DB.expires_in = 30  # 令牌即将过期，下次请求前应自动刷新
        await pp.fill('[name=password]', 'secret123')
        await pp.locator('.submit').click()
        await wait_for(lambda: pp.locator('.acct-info').count())
        check('登录成功', await pp.locator('.acct-info').count() == 1)
        DB.expires_in = 3600
        before = sum(1 for c in DB.calls if 'refresh_token' in c[1])
        await pp.locator('[data-act=acctRefresh]').click()
        await pp.wait_for_timeout(800)
        after = sum(1 for c in DB.calls if 'refresh_token' in c[1])
        check('令牌临近过期时自动刷新，保持登录', after > before and await pp.locator('.acct-info').count() == 1, f'{before}→{after}')

        print('\n[5] 订阅 Pro')
        await pp.locator('[data-act=checkout][data-interval=year]').click()
        tab = await wait_for(lambda: asyncio.sleep(0, next((x for x in ctx.pages if 'fake-stripe/checkout' in x.url), None)))
        check('点击年付在新标签页打开支付页', tab is not None and 'interval=year' in tab.url, tab.url if tab else None)
        # 模拟 Stripe webhook 已把用户升级为 Pro，然后浏览器打开支付成功返回页
        uid = DB.users['alice@example.com']['id']
        DB.profiles[uid].update({'plan': 'pro', 'subscription_status': 'active', 'current_period_end': '2027-11-17T00:00:00Z'})
        await tab.goto(f'{BASE}/functions/v1/billing-return?status=success')
        get_plan = lambda: sw.evaluate("chrome.storage.local.get('account').then(r=>r.account?.plan)")
        await wait_for(lambda: sw.evaluate("chrome.storage.local.get('account').then(r=>r.account?.plan==='pro')"))
        plan = await get_plan()
        check('支付返回后自动刷新为 Pro', plan == 'pro', plan)
        await pp.bring_to_front()
        await pp.wait_for_timeout(300)
        check('账户页显示 Pro 会员与续费日期', 'Pro 会员' in await pp.locator('.plan').inner_text() and '下次续费' in await pp.locator('.status-line').inner_text())
        await pp.screenshot(path=f'{OUTPUT}/account-pro.png')
        await pp.locator('[data-act=portal]').first.click()
        portal = await wait_for(lambda: asyncio.sleep(0, next((x for x in ctx.pages if 'fake-stripe/portal' in x.url), None)))
        check('管理订阅打开 Stripe 客户门户', portal is not None)
        DB.profiles[uid]['cancel_at_period_end'] = True
        await pp.bring_to_front()
        await pp.locator('[data-act=acctRefresh]').click()
        await pp.wait_for_timeout(600)
        check('取消续费后显示有效期', '已取消续费' in await pp.locator('.status-line').inner_text(), await pp.locator('.status-line').inner_text())

        print('\n[6] 其他界面')
        await pp.locator('.rail [data-go=home]').click()
        await pp.wait_for_timeout(200)
        check('首页标题栏显示 Pro 标识', 'Pro' in await pp.locator('.chip.pro').inner_text())
        await pp.locator('.rail [data-go=settings]').click()
        await pp.wait_for_timeout(200)
        row = await pp.locator('[data-go=account]').inner_text()
        check('设置页账户行显示邮箱和 Pro', 'alice@example.com' in row and 'Pro' in row, row)
        await ctx.close()

    failed = [n for n, ok in results if not ok]
    print(f'\n结果：{len(results) - len(failed)}/{len(results)} 通过')
    if failed:
        print('失败项：' + '；'.join(failed))
    sys.exit(1 if failed else 0)


asyncio.run(main())
