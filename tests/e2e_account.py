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
            st = parse_qs(u.query).get('status', ['success'])[0]
            text = {'success': '支付成功，正在确认会员状态', 'cancel': '已取消支付'}.get(st, '订阅设置已保存')
            return self.send(200, f'<h1>{text}</h1>', 'text/html; charset=utf-8')
        if u.path == '/auth/v1/settings':
            return self.send(200, {'external': {'email': True, 'google': False}})
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
        if u.path == '/functions/v1/check-email':  # 与云端一致：没有邮件服务器的域名收不到信
            DB.checked = getattr(DB, 'checked', []) + [body.get('domain')]
            d = body.get('domain') or ''
            return self.send(200, {'deliverable': None if d.endswith('.local') else d != 'panda.com'})
        if u.path == '/auth/v1/resend':
            DB.resent = getattr(DB, 'resent', []) + [body.get('email')]
            return self.send(200, {})
        if u.path == '/auth/v1/signup':
            email = body['email']
            if email.endswith('.local'):  # 与云端一致：拒绝无法收信的域名
                return self.send(400, {'code': 400, 'error_code': 'email_address_invalid', 'msg': f'Email address "{email}" is invalid'})
            if email in DB.users:
                if DB.users[email].get('confirmed'):  # 与云端一致：已验证的邮箱重复注册，返回假装成功、identities 为空
                    return self.send(200, {'id': str(uuid.uuid4()), 'email': email, 'identities': []})
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
                if DB.profiles[uid]['plan'] != 'free':
                    return self.send(409, {'error': '你已经是会员，请在“管理订阅”中升级或切换方案', 'code': 'use_portal'})
                DB.profiles[uid]['stripe_customer_id'] = 'cus_test'
                return self.send(200, {'url': f'{BASE}/fake-stripe/checkout?plan={body.get("plan")}&interval={body.get("interval")}'})
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

        # config.js 填了云端地址时连云端；没填时开发版自动使用本地后端
        import re as _re
        cfg_url = _re.search(r"BACKEND = \{\s*supabaseUrl: '([^']*)'", open(os.path.join(ROOT, 'src/shared/config.js'), encoding='utf-8').read()).group(1)
        print('[0] 默认后端：' + ('config.js 中的云端' if cfg_url else '开发版自动连接本地'))
        pp = await open_panel()
        st = await pp.evaluate("chrome.runtime.sendMessage({type:'accountState'}).then(r=>r.data)")
        be = st.get('backend') or {}
        if cfg_url:
            check('未做任何设置时，使用 config.js 中的云端后端', st['configured'] and be.get('source') == 'config' and be.get('url') == cfg_url, be)
        else:
            check('未做任何设置时，开发版自动使用本地后端', st['configured'] and be.get('source') == 'local-dev' and be.get('url') == 'http://127.0.0.1:54321', be)
        await pp.locator('[data-go=account]').click()
        await pp.wait_for_timeout(300)
        note = '本地开发' in await pp.locator('.body').inner_text()
        check('账户页的“后端：本地开发”说明只在连本地时出现', note == (not cfg_url))
        await pp.close()
        # 完整设置页 → 高级：开发版可在云端与本地之间切换，切换时退出登录
        op = await ctx.new_page()
        await op.goto(f'chrome-extension://{eid}/options/options.html#advanced')
        await op.wait_for_selector('#devBackendRow:not([hidden])', timeout=5000)
        check('开发版在高级设置中显示“后端”切换', await op.locator('#devBackendSel').is_visible())
        await sw.evaluate("()=>chrome.storage.local.set({auth:{access_token:'x',refresh_token:'y',expires_at:9e9,user:{email:'a@b.c'}}})")
        await op.select_option('#devBackendSel', 'local')
        await op.wait_for_timeout(400)
        st = await sw.evaluate("chrome.storage.local.get(['backendOverride','auth'])")
        check('切到本地：写入本机后端地址，并退出原登录', (st.get('backendOverride') or {}).get('supabaseUrl') == 'http://127.0.0.1:54321' and not st.get('auth'), st.get('backendOverride'))
        check('切换后显示 Mailpit 提示', 'Mailpit' in await op.locator('#devBackendHint').inner_text())
        if cfg_url:
            await op.select_option('#devBackendSel', 'cloud')
            await op.wait_for_timeout(400)
            st = await sw.evaluate("chrome.storage.local.get('backendOverride')")
            check('切回云端：清除覆盖地址', not st.get('backendOverride'))
        else:
            await sw.evaluate("()=>chrome.storage.local.remove('backendOverride')")
        await op.close()

        print('\n[1] 后端未配置')
        # 用空地址覆盖，模拟正式版未填写 config.js 的情况
        await sw.evaluate("()=>chrome.storage.local.set({backendOverride:{supabaseUrl:'',supabaseAnonKey:''}})")
        pp = await open_panel()
        check('设置页顶部显示账户行“登录 / 注册”', '登录 / 注册' in await pp.locator('[data-go=account]').inner_text())
        await pp.locator('[data-go=account]').click()
        check('账户页提示服务未配置', '尚未配置' in await pp.locator('.warn').inner_text())
        await pp.close()

        await sw.evaluate("(u)=>chrome.storage.local.set({backendOverride:{supabaseUrl:u,supabaseAnonKey:'anon-test-key'}})", BASE)

        print('\n[2] 注册')
        pp = await open_panel()
        await pp.locator('[data-go=account]').click()
        check('登录页：返回、欢迎回来、副标题说明登录的好处（不暗示必须登录）', await pp.locator('.back').count() == 1
              and '欢迎回来' in await pp.locator('.auth-title').inner_text()
              and '开通会员' in await pp.locator('.auth-sub').inner_text())
        check('登录页：“使用 Google 登录”、“或使用邮箱”分隔、邮箱密码框、“登录”、忘记密码、“还没有账号？免费注册”',
              await pp.locator('.oauth').inner_text() == '使用 Google 登录'
              and '或使用邮箱' in await pp.locator('.or').inner_text()
              and await pp.locator('.ifield').count() == 2
              and (await pp.locator('.gold.submit').inner_text()).strip() == '登录'
              and await pp.locator('[data-act=forgot]').count() == 1
              and '还没有账号？免费注册' in await pp.locator('.switch').inner_text())
        check('不提供 Apple 登录', 'Apple' not in await pp.locator('.body').inner_text())
        await pp.screenshot(path=f'{OUTPUT}/account-signin.png')
        await pp.locator('.oauth').click()
        await wait_for(lambda: pp.locator('.msg.err').count())
        check('Google 登录未开启时给出明确提示', '尚未开启 Google 登录' in await msg(pp), await msg(pp))
        await pp.locator('[data-act=authMode][data-mode=signup]').click()
        check('注册页：“创建账号”、“使用 Google 注册”、“免费注册”、“已有账号？登录”、继续免费使用、条款',
              '创建账号' in await pp.locator('.auth-title').inner_text()
              and await pp.locator('.oauth').inner_text() == '使用 Google 注册'
              and (await pp.locator('.gold.submit').inner_text()).strip() == '免费注册'
              and '已有账号？登录' in await pp.locator('.switch').inner_text()
              and '暂不注册，继续免费使用' in await pp.locator('[data-act=guest]').inner_text()
              and '服务条款' in await pp.locator('.terms').inner_text())
        await pp.screenshot(path=f'{OUTPUT}/account-signup.png')
        await pp.locator('[data-act=guest]').click()
        await pp.wait_for_timeout(200)
        check('暂不注册：回到首页', await pp.locator('.stat').count() == 2)
        await pp.locator('.rail [data-go=settings]').click()
        await pp.locator('[data-go=account]').click()
        await pp.locator('[data-act=authMode][data-mode=signup]').click()
        await pp.fill('[name=email]', 'alice@example.com')
        await pp.fill('[name=password]', '123')
        await pp.locator('.submit').click()
        check('密码少于 6 位时提示', '至少需要 6 位' in await msg(pp), await msg(pp))
        await pp.fill('[name=password]', 'secret123')
        await pp.locator('.submit').click()
        ok = await wait_for(lambda: pp.locator('.acct-info').count())
        check('注册成功后直接登录', ok and 'alice@example.com' in await pp.locator('.acct-info').inner_text())
        check('新用户为免费版，显示开通会员卡片', '免费版' in await pp.locator('.plan').inner_text() and await pp.locator('.pro-card').count() == 1)
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
        for _ in range(20):  # 页面上可能还留着上一条提示，等内容变成这次的结果
            if '邮箱或密码错误' in await msg(pp):
                break
            await pp.wait_for_timeout(200)
        check('密码错误显示中文提示', '邮箱或密码错误' in await msg(pp), await msg(pp))
        await pp.locator('[data-act=authMode][data-mode=signup]').click()
        await pp.fill('[name=email]', 'alice@example.com')
        await pp.fill('[name=password]', 'secret123')
        await pp.locator('.submit').click()
        for _ in range(20):  # 注册前要先检查邮箱域名，提示会晚一点出现
            if '已注册' in await msg(pp):
                break
            await pp.wait_for_timeout(200)
        check('重复注册显示“已注册”', '已注册' in await msg(pp), await msg(pp))
        await pp.fill('[name=email]', 'a@panda.com')
        await pp.locator('.submit').click()
        for _ in range(20):
            if '收不到邮件' in await msg(pp):
                break
            await pp.wait_for_timeout(200)
        check('域名没有邮件服务器（a@panda.com）：注册前拦下，提示检查邮箱地址，不创建账号',
              'panda.com 没有邮件服务器' in await msg(pp) and 'a@panda.com' not in DB.users
              and getattr(DB, 'checked', [])[-1:] == ['panda.com'], await msg(pp))
        await pp.fill('[name=email]', 'alice@example.com')
        check('出错后注册按钮仍显示“免费注册”', await pp.locator('.submit').inner_text() == '免费注册', await pp.locator('.submit').inner_text())
        await pp.fill('[name=email]', 'tester1@test.local')
        await pp.locator('.submit').click()
        await pp.wait_for_timeout(600)  # 上一条错误还在，等新的结果替换它
        check('无法收信的邮箱：提示换真实邮箱，而不是“格式不正确”',
              '请使用能正常收信的真实邮箱' in await msg(pp) and '格式' not in await msg(pp), await msg(pp))
        await pp.fill('[name=email]', 'confirm-bob@example.com')
        await pp.fill('[name=password]', 'secret123')
        await pp.locator('.submit').click()
        await wait_for(lambda: pp.locator('.msg.ok').count())
        check('需要邮箱验证时提示查收邮件', '验证邮件已发送' in await msg(pp), await msg(pp))
        await pp.fill('[name=password]', 'secret123')
        await pp.locator('.submit').click()
        await wait_for(lambda: pp.locator('.msg.err').count())
        check('未验证邮箱登录时提示', '尚未验证' in await msg(pp), await msg(pp))
        check('未验证时提示旁有“重新发送验证邮件”', await pp.locator('.msg [data-act=resendConfirm]').count() == 1)
        await pp.locator('.msg [data-act=resendConfirm]').click()
        for _ in range(20):
            if '已重新发送' in await msg(pp):
                break
            await pp.wait_for_timeout(200)
        check('点击后重新发送验证邮件到该邮箱', '验证邮件已重新发送到 confirm-bob@example.com' in await msg(pp)
              and getattr(DB, 'resent', []) == ['confirm-bob@example.com'], await msg(pp))

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
        op = await ctx.new_page()
        await op.goto(f'chrome-extension://{eid}/options/options.html#account')
        await op.wait_for_selector('#acctPlan', timeout=5000)
        box = await op.locator('#acctBox').inner_text()
        check('完整设置页“账户与会员”：邮箱、免费版、开通会员、退出登录；没付过款不显示“管理订阅”',
              'alice@example.com' in box and '免费版' in box and '开通会员' in box and '退出登录' in box and '管理订阅' not in box, box.replace('\n', ' / '))
        await op.close()
        DB.expires_in = 3600
        before = sum(1 for c in DB.calls if 'refresh_token' in c[1])
        await pp.locator('[data-act=acctRefresh]').click()
        await pp.wait_for_timeout(800)
        after = sum(1 for c in DB.calls if 'refresh_token' in c[1])
        check('令牌临近过期时自动刷新，保持登录', after > before and await pp.locator('.acct-info').count() == 1, f'{before}→{after}')

        print('\n[5] Premium 方案页与订阅 Premium+')
        await pp.locator('.pro-card [data-act=premium]').click()
        prem = await wait_for(lambda: asyncio.sleep(0, next((x for x in ctx.pages if 'premium/premium.html' in x.url), None)))
        check('账户页“查看会员方案”打开 Premium 页面', prem is not None)
        await asyncio.sleep(0.3)
        check('弹窗形态的面板打开 Premium 页后自动关闭', pp.is_closed())
        await prem.wait_for_selector('.plan.premium_plus')
        await prem.set_viewport_size({'width': 1280, 'height': 900})
        await prem.wait_for_timeout(600)
        check('三张方案卡片：免费 / Premium / Premium+', await prem.locator('.plan').count() == 3)
        check('免费卡片标为当前方案', await prem.locator('.plan.free.current').count() == 1)
        await prem.screenshot(path=f'{OUTPUT}/premium-page.png', full_page=True)
        await prem.locator('#period [data-interval=month]').click()
        check('切换月付：Premium+ 显示 $6 / 月', '$6' in await prem.locator('.plan.premium_plus .price').inner_text())
        check('Premium 只有年付', '仅年付' in await prem.locator('.plan.premium .sub').inner_text())
        await prem.locator('#period [data-interval=year]').click()
        check('切换年付：Premium+ 显示 $69 / 年', '$69' in await prem.locator('.plan.premium_plus .sub').inner_text())
        check('功能对比表与常见问题', await prem.locator('#compare tr').count() > 8 and await prem.locator('.faq details').count() >= 5)
        # 邮箱验证链接：后端返回页由扩展换成扩展内的结果页（云端会把 supabase.co 上的网页显示成源代码）
        vt = await ctx.new_page()
        await vt.goto(f'{BASE}/functions/v1/billing-return?status=verified#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired')
        await wait_for(lambda: asyncio.sleep(0, 'welcome/verified.html' in vt.url or None), 8)
        await vt.wait_for_timeout(300)
        check('验证链接失效：换成扩展结果页，显示“验证链接已失效”和错误信息',
              'welcome/verified.html' in vt.url and await vt.locator('#title').inner_text() == '验证链接已失效'
              and 'expired' in await vt.locator('#detail').inner_text(), vt.url)
        await vt.goto(f'{BASE}/functions/v1/billing-return?status=verified#access_token=secret-at&refresh_token=secret-rt&type=signup')
        await wait_for(lambda: asyncio.sleep(0, ('welcome/verified.html' in vt.url and 'error' not in vt.url) or None), 8)
        await vt.wait_for_timeout(300)
        check('验证成功：显示“邮箱已验证”，地址里不带登录令牌',
              await vt.locator('#title').inner_text() == '邮箱已验证' and 'secret' not in vt.url, vt.url)
        await vt.screenshot(path=f'{OUTPUT}/email-verified.png')
        await vt.close()
        # 先取消一次支付：支付页关闭，回到方案页并提示“已取消支付”
        await prem.locator('.plan.premium [data-act=buy]').click()
        tab = await wait_for(lambda: asyncio.sleep(0, next((x for x in ctx.pages if 'fake-stripe/checkout' in x.url), None)))
        await tab.goto(f'{BASE}/functions/v1/billing-return?status=cancel')
        await wait_for(lambda: asyncio.sleep(0, tab.is_closed() or None), 10)
        check('取消支付：支付页自动关闭', tab.is_closed())
        await wait_for(lambda: prem.locator('#notice:not([hidden])').count(), 5)
        check('取消支付：回到方案页并提示“已取消支付”', '已取消支付' in await prem.locator('#notice').inner_text(), await prem.locator('#notice').inner_text())

        await prem.locator('.plan.premium_plus [data-act=buy]').click()
        tab = await wait_for(lambda: asyncio.sleep(0, next((x for x in ctx.pages if 'fake-stripe/checkout' in x.url), None)))
        check('开通 Premium+ 年付：新标签页打开支付页', tab is not None and 'plan=premium_plus' in tab.url and 'interval=year' in tab.url, tab.url if tab else None)
        check('提示完成支付后会自动回到方案页', '自动回到这里' in await prem.locator('#notice').inner_text())
        # 支付成功后浏览器打开返回页；模拟 webhook 晚 2 秒才把用户升级为 Premium+
        uid = DB.users['alice@example.com']['id']
        await tab.goto(f'{BASE}/functions/v1/billing-return?status=success')
        check('返回页显示“支付成功，正在确认会员状态”', '正在确认会员状态' in await tab.content())
        await asyncio.sleep(2)
        DB.profiles[uid].update({'plan': 'premium_plus', 'subscription_status': 'active', 'current_period_end': '2027-11-17T00:00:00Z'})
        await wait_for(lambda: asyncio.sleep(0, tab.is_closed() or None), 20)
        check('会员生效后自动关闭支付页', tab.is_closed())
        get_plan = lambda: sw.evaluate("chrome.storage.local.get('account').then(r=>r.account?.plan)")
        plan = await get_plan()
        check('支付返回后自动刷新为 Premium+', plan == 'premium_plus', plan)
        await wait_for(lambda: prem.locator('#doneModal:not([hidden])').count(), 5)
        check('回到最初的方案页，弹出“支付成功”并说明当前等级', await prem.locator('#doneModal').is_visible()
              and 'Premium+' in await prem.locator('#doneText').inner_text(), await prem.locator('#doneText').inner_text())
        check('成功弹窗列出已解锁的功能', await prem.locator('#doneList li').count() == 4)
        check('方案页是当前激活的标签页', await prem.evaluate('document.visibilityState') == 'visible')
        await prem.screenshot(path=f'{OUTPUT}/premium-paid.png')
        opts = await prem.locator('#doneEngines .pe').all_inner_texts()
        check('成功弹窗可直接选择默认引擎：DeepSeek（默认选中）/ DeepL / Google', opts[:2] == ['DeepSeek', 'DeepL'] and 'Google' in opts[2]
              and await prem.locator('#doneEngines .pe.on').inner_text() == 'DeepSeek', opts)
        await prem.locator('#doneOk').click()
        eng = await sw.evaluate("chrome.storage.local.get('settings').then(r=>r.settings.engine)")
        check('点“开始使用”后默认引擎改为 DeepSeek', eng == 'deepseek', eng)
        # 从正在阅读的网页打开方案页（?from=标签ID）：开通成功后“开始使用”回到该网页并关闭方案页
        reader = await ctx.new_page()
        await reader.goto(f'{BASE}/fake-stripe/portal')
        rid = await sw.evaluate("chrome.tabs.query({}).then(ts=>ts.find(t=>(t.url||'').includes('fake-stripe/portal')).id)")
        p2 = await ctx.new_page()
        await p2.goto(f'chrome-extension://{eid}/premium/premium.html?from={rid}')
        await p2.wait_for_selector('.plan.premium_plus')
        await sw.evaluate("()=>chrome.storage.local.set({billingResult:{status:'success',plan:'premium_plus',at:Date.now()}})")
        await p2.wait_for_selector('#doneModal:not([hidden])', timeout=5000)
        check('弹窗注明“点击后回到你正在阅读的网页”', '回到你正在阅读的网页' in await p2.locator('#doneHint').inner_text())
        await p2.locator('#doneEngines [data-engine=deepl]').click()
        await p2.locator('#doneOk').click()
        await wait_for(lambda: asyncio.sleep(0, p2.is_closed() or None), 5)
        active = await sw.evaluate("chrome.tabs.query({active:true,lastFocusedWindow:true}).then(t=>t[0]?.url||'')")
        eng = await sw.evaluate("chrome.storage.local.get('settings').then(r=>r.settings.engine)")
        check('“开始使用”：关闭方案页，回到正在阅读的网页，默认引擎改为所选的 DeepL', p2.is_closed() and 'fake-stripe/portal' in active and eng == 'deepl', (active, eng))
        await reader.close()
        check('Premium 页面：Premium+ 标为当前方案，Premium 已包含', await prem.locator('.plan.premium_plus.current').count() == 1
              and '已包含' in await prem.locator('.plan.premium .btn').inner_text())
        pp = await open_panel('account')
        check('账户页显示 Premium+ 会员、续费日期与 AI 用量', 'Premium+ 会员' in await pp.locator('.plan').inner_text()
              and '下次续费' in await pp.locator('.status-line').inner_text() and await pp.locator('.usage .bar').count() == 1)
        await pp.screenshot(path=f'{OUTPUT}/account-pro.png')
        await pp.locator('[data-act=portal]').first.click()
        portal = await wait_for(lambda: asyncio.sleep(0, next((x for x in ctx.pages if 'fake-stripe/portal' in x.url), None)))
        check('管理订阅打开 Stripe 客户门户', portal is not None)
        await portal.close()
        # Premium 会员在方案页点“升级到 Premium+”：后端返回 use_portal，改为打开客户门户
        DB.profiles[uid]['plan'] = 'premium'
        await sw.evaluate("chrome.runtime.sendMessage({type:'accountRefresh'}).catch(()=>0)")
        await prem.bring_to_front()
        await prem.reload()
        await prem.wait_for_selector('.plan.premium_plus [data-act=buy]')
        check('Premium 会员看到“升级到 Premium+”', '升级到 Premium+' in await prem.locator('.plan.premium_plus [data-act=buy]').inner_text())
        await prem.locator('.plan.premium_plus [data-act=buy]').click()
        portal2 = await wait_for(lambda: asyncio.sleep(0, next((x for x in ctx.pages if 'fake-stripe/portal' in x.url), None)))
        check('升级时改为打开客户门户（避免重复订阅）', portal2 is not None)
        DB.profiles[uid].update({'plan': 'premium_plus', 'cancel_at_period_end': True})
        await pp.bring_to_front()
        await pp.locator('[data-act=acctRefresh]').click()
        await pp.wait_for_timeout(600)
        check('取消续费后显示有效期', '已取消续费' in await pp.locator('.status-line').inner_text(), await pp.locator('.status-line').inner_text())

        print('\n[6] 其他界面')
        await pp.locator('.rail [data-go=home]').click()
        await pp.wait_for_timeout(200)
        check('首页右上角 Premium 入口显示 Premium+（会员实心样式）', 'Premium+' in await pp.locator('.chip.premium.on').inner_text())
        await pp.locator('.rail [data-go=settings]').click()
        await pp.wait_for_timeout(200)
        row = await pp.locator('[data-go=account]').inner_text()
        check('设置页账户行显示邮箱和 Premium+', 'alice@example.com' in row and 'Premium+' in row, row)
        op = await ctx.new_page()
        await op.goto(f'chrome-extension://{eid}/options/options.html#account')
        await op.wait_for_selector('#acctPlan', timeout=5000)
        box = await op.locator('#acctBox').inner_text()
        check('完整设置页“账户与会员”：Premium+ 会员、续费信息、本月 AI 用量、管理订阅',
              'Premium+ 会员' in box and '本月 AI 用量' in box and '管理订阅' in box and '升级到 Premium+' not in box, box.replace('\n', ' / '))
        await op.screenshot(path=f'{OUTPUT}/options-account.png')
        await op.locator('[data-acct=logout]').click()
        await op.wait_for_selector('[data-acct=login]', timeout=5000)
        check('设置页退出登录后显示“登录 / 注册”与“查看会员方案”', '登录 / 注册' in await op.locator('#acctBox').inner_text())
        await op.locator('[data-acct=login]').click()
        await op.wait_for_selector('#loginModal:not([hidden])')
        frame = next(f for f in op.frames if 'panel/panel.html' in f.url)
        await frame.wait_for_selector('#authForm')
        await frame.fill('[name=email]', 'alice@example.com')
        await frame.fill('[name=password]', 'secret123')
        await frame.locator('.submit').click()
        await op.wait_for_selector('#loginModal', state='hidden', timeout=8000)
        await wait_for(lambda: op.locator('#acctBox:has-text("Premium+ 会员")').count(), 8)
        check('设置页中登录：弹窗内登录成功后自动关闭并显示会员信息', 'Premium+ 会员' in await op.locator('#acctBox').inner_text(), await op.locator('#acctBox').inner_text())
        await op.close()

        # 生词本按账号分开：换账号后看不到上一个人的生词；未登录时收藏的并入登录的账号
        print('\n[生词本归属] 换账号不混用生词本')
        ex = await ctx.new_page()
        await ex.goto(f'chrome-extension://{eid}/panel/panel.html')
        M = '(m)=>chrome.runtime.sendMessage(m)'
        W = "()=>chrome.storage.local.get('words').then(r=>(r.words||[]).map(w=>w.w).sort())"
        await ex.evaluate(M, {'type': 'accountSignOut'})
        await ex.evaluate("()=>chrome.storage.local.set({words:[{w:'guestword',t:'',url:'',ts:Date.now(),m:false,u:Date.now()}]})")
        await ex.evaluate(M, {'type': 'accountSignUp', 'email': 'ann@example.com', 'password': 'secret123'})
        check('登录后：未登录时收藏的生词并入这个账号', await ex.evaluate(W) == ['guestword'], await ex.evaluate(W))
        await ex.evaluate(M, {'type': 'toggleWord', 'word': 'annword', 'trans': '', 'url': ''})
        await ex.evaluate(M, {'type': 'accountSignOut'})
        check('退出登录后：生词本换成空的未登录生词本', await ex.evaluate(W) == [], await ex.evaluate(W))
        await ex.evaluate(M, {'type': 'accountSignUp', 'email': 'dave@example.com', 'password': 'secret123'})
        check('换成另一个账号：看不到上一个账号的生词', await ex.evaluate(W) == [], await ex.evaluate(W))
        await ex.evaluate(M, {'type': 'toggleWord', 'word': 'daveword', 'trans': '', 'url': ''})
        await ex.evaluate(M, {'type': 'accountSignOut'})
        await ex.evaluate(M, {'type': 'accountSignIn', 'email': 'ann@example.com', 'password': 'secret123'})
        check('换回原账号：之前的生词恢复，且没有混入别人的', await ex.evaluate(W) == ['annword', 'guestword'], await ex.evaluate(W))
        # 旧版本留下的生词（旧版退出登录不清空，且和云端同步过）：升级后不能并入新登录的账号
        await ex.evaluate(M, {'type': 'accountSignOut'})
        await ex.evaluate("""()=>chrome.storage.local.remove(['wordsOwner','wordsStash']).then(()=>chrome.storage.local.set({
          words:[{w:'word0',t:'',url:'',ts:Date.now(),m:false,u:Date.now()},{w:'word1',t:'',url:'',ts:Date.now(),m:false,u:Date.now()}],
          wordsSyncedAt: Date.now()}))""")
        await ex.evaluate(M, {'type': 'accountSignUp', 'email': 'erin@example.com', 'password': 'secret123'})
        check('旧版本留下、和云端同步过的生词：不并入新注册的账号', await ex.evaluate(W) == [], await ex.evaluate(W))
        await ex.close()
        await ctx.close()

    failed = [n for n, ok in results if not ok]
    print(f'\n结果：{len(results) - len(failed)}/{len(results)} 通过')
    if failed:
        print('失败项：' + '；'.join(failed))
    sys.exit(1 if failed else 0)


asyncio.run(main())
