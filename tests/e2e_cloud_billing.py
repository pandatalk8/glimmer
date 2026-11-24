"""旅程四（开通会员）在云端自动回归：云端 Supabase（glimmer）+ Stripe 沙盒，用 Stripe 公布的测试卡走完整的付款流程。

覆盖 docs/test-cases.md 的 D-01 ~ D-11（旅程四），E-01 ~ E-10（旅程五：用 D-09 开通的 Premium 账号测权益，并经客户门户升级到 Premium+），以及 F-01 ~ F-08（旅程六：用升级后的 Premium+ 账号测大模型、用量与额度）。云端的 Stripe 通知直接发到云端函数，不需要 stripe listen。

- 测试账号用云端管理接口直接创建（已验证邮箱），不发验证邮件，不受内置发信每小时约 2 封的限制
- 只用 Stripe 测试密钥（sk_test_）与公布的测试卡号，不会产生真实扣款
- 结束时取消测试订阅、删除 Stripe 测试客户和云端测试账号；加 --keep 保留，方便在 Studio / Stripe 后台查看

前提：已登录 Supabase CLI（npx supabase login），supabase/functions/.env 中有 Stripe 测试密钥与价格。
用法：python3 tests/e2e_cloud_billing.py [--headed] [--keep] [--skip-e] [--skip-f]
"""
import asyncio, base64, functools, http.server, json, os, re, secrets, subprocess, sys, tempfile, threading, time, urllib.error, urllib.parse, urllib.request
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT = os.path.join(ROOT, 'tests', 'output')
FIXTURES = os.path.join(ROOT, 'tests', 'fixtures')
HEADED = '--headed' in sys.argv
KEEP = '--keep' in sys.argv
SKIP_E = '--skip-e' in sys.argv  # 只跑旅程四
SKIP_F = SKIP_E or '--skip-f' in sys.argv  # 不跑旅程六
REF = 'btaihodwxgyhtbyjhbke'
API = f'https://{REF}.supabase.co'
ARTICLE = 'http://127.0.0.1:8766/article.html'
results = []

ENV = dict(l.split('=', 1) for l in open(os.path.join(ROOT, 'supabase/functions/.env'), encoding='utf-8').read().splitlines()
           if '=' in l and not l.startswith('#'))
CARD_OK, CARD_DECLINE, CARD_3DS = '4242424242424242', '4000000000000002', '4000002500003155'

http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8766), functools.partial(http.server.SimpleHTTPRequestHandler, directory=FIXTURES))
threading.Thread(target=srv.serve_forever, daemon=True).start()


T0 = time.time()


def step(msg):
    print(f'  [{time.time() - T0:5.0f}s] {msg}')


async def shot(pg, name):
    """截图失败或卡住都不影响测试继续"""
    try:
        await asyncio.wait_for(pg.screenshot(path=f'{OUTPUT}/{name}'), 15)
    except Exception:
        pass


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('  PASS  ' if ok else '  FAIL  ') + name + (f'  ({detail})' if detail != '' else ''))


def cloud_secret():
    """用 Supabase CLI 取云端的服务端密钥，只留在内存里，不打印、不落盘"""
    for extra in ([], ['--reveal']):
        out = subprocess.run(['npx', '-y', 'supabase@3.2.0', 'projects', 'api-keys', '--project-ref', REF, '-o', 'json', *extra],
                             cwd=ROOT, capture_output=True, text=True).stdout
        try:
            keys = json.loads(out)
        except Exception:
            continue
        for want in ('secret', None):
            for k in keys:
                v = k.get('api_key') or ''
                ok = k.get('type') == 'secret' if want else k.get('name') == 'service_role'
                if ok and re.fullmatch(r'[A-Za-z0-9_.\-]{30,}', v):
                    return v
    sys.exit('取不到云端服务端密钥：先执行 npx supabase login')


SECRET = cloud_secret()


def _http(url, method='GET', body=None, headers=None, form=False):
    data = None
    if body is not None:
        data = urllib.parse.urlencode(body).encode() if form else json.dumps(body).encode()
    for attempt in range(5):
        req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
        try:
            raw = urllib.request.urlopen(req, timeout=30).read()
            return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            raise RuntimeError(f'{method} {url.split("?")[0]} → {e.code}: {e.read().decode()[:200]}')
        except Exception:
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f'网络持续失败：{url.split("?")[0]}')


def admin(method, path, body=None, extra=None):
    h = {'apikey': SECRET, 'Content-Type': 'application/json', **(extra or {})}
    if SECRET.startswith('ey'):  # 旧版 service_role JWT 还需要 Authorization
        h['Authorization'] = 'Bearer ' + SECRET
    return _http(API + path, method, body, h)


def rest(table, query):
    return admin('GET', f'/rest/v1/{table}?{query}')


def stripe_api(method, path, data=None):
    key = ENV['STRIPE_SECRET_KEY'].strip()
    assert key.startswith('sk_test_'), '只允许使用 Stripe 测试密钥'
    return _http('https://api.stripe.com/v1' + path, method, data if method == 'POST' else None,
                 {'Authorization': 'Basic ' + base64.b64encode((key + ':').encode()).decode()}, form=True)


def new_user():
    email = f'glimmer-e2e-{secrets.token_hex(4)}@example.com'
    pw = secrets.token_urlsafe(12)
    u = admin('POST', '/auth/v1/admin/users', {'email': email, 'password': pw, 'email_confirm': True})
    return {'id': u['id'], 'email': email, 'pw': pw}


async def wait_for(fn, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        v = await fn()
        if v:
            return v
        await asyncio.sleep(0.5)
    return await fn()


def poll(fn, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        try:
            v = fn()
        except Exception:
            v = None
        if v:
            return v
        time.sleep(1)
    return None


async def payment_frame(pay, timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        for f in pay.frames:
            if 'elements-inner' not in f.url:
                continue
            try:
                if await f.locator('#payment-numberInput, [role=button]:has-text("Card")').count():
                    return f
            except Exception:
                pass
        if await pay.locator('#cardNumber').count():
            return pay.main_frame
        await asyncio.sleep(1)
    raise TimeoutError('支付表单未出现')


async def fill_card(pay, number):
    """在 Stripe Checkout 页面填写测试卡并提交（兼容新旧两版页面）"""
    f = await payment_frame(pay)
    if f is pay.main_frame:
        await f.locator('#cardNumber').fill(number)
        await f.locator('#cardExpiry').fill('12 / 34')
        await f.locator('#cardCvc').fill('123')
        for sel, val in [('#billingName', 'Glimmer Tester'), ('#billingPostalCode', '10001')]:
            if await f.locator(sel).count():
                await f.locator(sel).fill(val)
        await f.locator('button[type="submit"], .SubmitButton').first.click()
        return
    if not await f.locator('#payment-numberInput').is_visible():
        await f.locator('[role=button]:has-text("Card")').first.click()
    await f.locator('#payment-numberInput').fill(number, timeout=30000)
    await f.locator('#payment-expiryInput').fill('1234')
    await f.locator('#payment-cvcInput').fill('123')
    if await f.locator('#payment-nameInput').count():
        await f.locator('#payment-nameInput').fill('Glimmer Tester')
    if await f.locator('#payment-postalCodeInput').count():
        await f.locator('#payment-postalCodeInput').fill('10001')
    opt = f.locator('#payment-linkOptInInput')
    # “保存到 Link”默认不勾选，不去点它（自定义控件，点击位置不准会误选 Cash App Pay 等其他付款方式）；
    # 万一已勾上，填测试手机号满足必填
    phone = f.locator('#payment-linkMobilePhoneInput')
    if await opt.count() and await opt.is_checked() and await phone.count() and await phone.is_visible():
        await phone.fill('2015550123')
    # 2026-11 起新版页面的“Subscribe”在支付表单 iframe 里；旧版在主页面
    btn = f.locator('button[data-testid="payment-form-submit-button"]:visible').first
    if not await btn.count():
        btn = pay.locator('button[data-testid="hosted-payment-submit-button"]:visible, .SubmitButton:visible').first
    if not await btn.count():
        btn = pay.get_by_role('button', name=re.compile(r'^(Subscribe|Pay|Start trial)', re.I)).first
    await btn.click()


async def page_text(pay):
    """支付页所有 frame 的文字（错误提示可能在 iframe 里）"""
    out = []
    for f in pay.frames:
        if f is not pay.main_frame and 'elements-inner' not in f.url:
            continue
        try:
            out.append(await asyncio.wait_for(f.evaluate('document.body ? document.body.innerText : ""'), 3))
        except Exception:
            pass
    return '\n'.join(out)


async def pass_3ds(pay, timeout=60):
    """3D 验证弹窗：Stripe 测试页的“Complete / 完成”按钮在多层 iframe 中"""
    # 测试用的发卡行页面在两层跨域 iframe 里，模拟鼠标点击常常没反应：在页面内触发按钮的 click，直到验证窗口消失
    end = time.time() + timeout
    clicked = False
    while time.time() < end:
        acs = [f for f in pay.frames if '3d_secure' in f.url and not f.is_detached()] if not pay.is_closed() else []
        if clicked and not acs:
            return True  # 验证窗口已关闭
        for f in acs:
            try:
                if await asyncio.wait_for(f.evaluate("()=>{const b=document.getElementById('test-source-authorize-3ds');if(!b)return false;b.click();return true}"), 5):
                    if not clicked:
                        step('D-11 已在 3D 验证窗口点“COMPLETE”')
                    clicked = True
            except Exception:
                pass
        await asyncio.sleep(2)
    return clicked


async def main():
    os.makedirs(OUTPUT, exist_ok=True)
    users = []
    try:
        a, b, c = new_user(), new_user(), new_user()
        users += [a, b, c]
        print(f'创建了 3 个已验证的云端测试账号：{a["email"]}（D-05 ~ D-10）、{b["email"]}（D-09b）、{c["email"]}（D-11）')
        await run(a, b, c)
    finally:
        cleanup(users)
        srv.shutdown()
    failed = [n for n, ok in results if not ok]
    print(f'\n结果：{len(results) - len(failed)}/{len(results)} 通过')
    if failed:
        print('失败项：' + '；'.join(failed))
    sys.exit(1 if failed else 0)


def cleanup(users):
    if KEEP:
        print('\n保留测试数据（--keep）：' + '、'.join(u['email'] for u in users))
        return
    print('\n清理：取消测试订阅、删除 Stripe 测试客户与云端测试账号')
    for u in users:
        try:
            cus = (rest('profiles', f'id=eq.{u["id"]}&select=stripe_customer_id') or [{}])[0].get('stripe_customer_id')
            if cus:
                stripe_api('DELETE', f'/customers/{cus}')  # 删除客户会立即取消它的订阅
            admin('DELETE', f'/auth/v1/admin/users/{u["id"]}')
        except Exception as e:
            print('  清理失败：', u['email'], str(e)[:120])


async def run(a, b, c):
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            tempfile.mkdtemp(prefix='glimmer-cloud-billing-'), channel='chromium', headless=not HEADED,
            args=[f'--disable-extensions-except={ROOT}', f'--load-extension={ROOT}'],
            viewport={'width': 1200, 'height': 900}, locale='en-US')
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        eid = sw.url.split('/')[2]
        await asyncio.sleep(1.5)
        for pg in ctx.pages:
            await pg.close()
        await sw.evaluate("chrome.storage.local.remove('backendOverride')")  # 用 config.js 中的云端后端
        account = lambda: sw.evaluate("chrome.storage.local.get('account').then(r=>r.account||{})")
        tab_of = lambda frag: next((x for x in ctx.pages if frag in x.url and not x.is_closed()), None)
        find_tab = lambda frag, t=30: wait_for(lambda: asyncio.sleep(0, tab_of(frag)), t)

        async def panel(view='home'):
            pp = await ctx.new_page()
            await pp.set_viewport_size({'width': 400, 'height': 640})
            await pp.goto(f'chrome-extension://{eid}/panel/panel.html' + (f'?view={view}' if view != 'home' else ''))
            await pp.wait_for_timeout(800)
            return pp

        async def sign_in(u):
            pp = await panel('account')
            await pp.evaluate("chrome.runtime.sendMessage({type:'accountSignOut'})")
            r = await pp.evaluate("(m)=>chrome.runtime.sendMessage(m)", {'type': 'accountSignIn', 'email': u['email'], 'password': u['pw']})
            await pp.close()
            return r

        async def subscribe(prem, plan, interval=None):
            await prem.wait_for_selector('#who .email', timeout=15000)  # 等方案页读到登录状态，否则“开通”会弹登录窗口
            if interval:
                await prem.locator(f'#period [data-interval={interval}]').click()
            await prem.locator(f'.plan.{plan} [data-act=buy]').click()
            return await find_tab('checkout.stripe.com')

        print('[6.1] 方案页（未登录）')
        pp = await panel()
        await pp.locator('header [data-act=premium]').click()
        prem = await find_tab('premium/premium.html', 15)
        check('D-01 面板首页右上角“Premium”在新标签页打开方案页', prem is not None)
        await prem.wait_for_selector('.plan.premium_plus [data-act=buy]')
        t = await prem.locator('body').inner_text()
        faq = await prem.locator('.faq details').count()
        rows = await prem.locator('#compare tbody tr').count()
        check('D-02 方案页：标题、月付 / 年付切换、三张卡片、功能对比表、常见问题、免费为当前方案',
              '会员方案' in t and await prem.locator('#period button').count() == 2 and await prem.locator('#plans .plan').count() == 3
              and rows > 5 and faq >= 5 and await prem.locator('.plan.free.current').count() == 1, f'对比表 {rows} 行，问题 {faq} 个')
        await prem.locator('#period [data-interval=year]').click()
        pr, pl = await prem.locator('.plan.premium').inner_text(), await prem.locator('.plan.premium_plus').inner_text()
        check('D-03 年付：Premium $29 / 年（约 $2.42 / 月），Premium+ $69 / 年（约 $5.75 / 月）',
              '$29' in pr and '$2.42' in pr and '$69' in pl and '$5.75' in pl, re.sub(r'\s+', ' ', pl)[:80])
        await prem.locator('#period [data-interval=month]').click()
        pr, pl = await prem.locator('.plan.premium').inner_text(), await prem.locator('.plan.premium_plus').inner_text()
        check('D-04 月付：Premium+ $6 / 月“按月付费，随时取消”，Premium 仍为“$29 / 年，仅年付”',
              '$6' in pl and '按月付费，随时取消' in pl and '$29 / 年，仅年付' in pr)
        await prem.screenshot(path=f'{OUTPUT}/cloud-premium-page.png', full_page=True)

        await prem.locator('.plan.premium_plus [data-act=buy]').click()
        await prem.wait_for_selector('#loginModal:not([hidden])', timeout=5000)
        lf = None
        for _ in range(20):
            lf = next((f for f in prem.frames if 'panel/panel.html' in f.url), None)
            if lf:
                break
            await asyncio.sleep(0.3)
        await lf.wait_for_selector('#authForm [name=email]')
        await lf.fill('#authForm [name=email]', a['email'])
        await lf.fill('#authForm [name=password]', a['pw'])
        await lf.locator('#authForm .submit').click()
        pay = await find_tab('checkout.stripe.com', 40)
        if not pay:
            try:
                print('  登录窗口提示：', (await lf.locator('#authForm').inner_text())[-120:].replace('\n', ' '))
            except Exception as e:
                print('  读取登录窗口失败：', type(e).__name__)
        check('D-05 未登录点“开通 Premium+”弹出登录窗口，登录后自动打开 Stripe 支付页', pay is not None)
        who = await prem.locator('#who').inner_text()
        check('D-06 方案页右上角显示邮箱和“免费版”', a['email'] in who and '免费版' in who, who)

        print('\n[6.2] 付款')
        via = '支付页左上角返回'
        try:
            back = pay.locator('a[href*="status=cancel"]').first
            await back.wait_for(state='attached', timeout=60000)
            await back.click(force=True)
        except Exception:
            via = '直接打开取消返回地址'
            await pay.goto(f'{API}/functions/v1/billing-return?status=cancel')
        await wait_for(lambda: asyncio.sleep(0, pay.is_closed() or None), 30)
        n = await wait_for(lambda: prem.locator('#notice:not([hidden])').inner_text(), 10)
        plan = (await account()).get('plan')
        check(f'D-07 取消支付（{via}）：支付页关闭，方案页提示“已取消支付，没有产生任何费用”，仍是免费版',
              pay.is_closed() and '已取消支付，没有产生任何费用' in n and plan == 'free', f'{n} / {plan}')

        pay = await subscribe(prem, 'premium')
        declined = ''
        if pay:
            try:
                step('D-08 填写被拒卡并提交')
                await asyncio.wait_for(fill_card(pay, CARD_DECLINE), 120)
                step('D-08 等待被拒提示')
                declined = await asyncio.wait_for(wait_for(lambda: _declined(pay), 45), 90)
            except Exception as e:
                declined = ''
                print('  支付页操作失败：', (str(e).splitlines() or [type(e).__name__])[0][:100])
            await shot(pay, 'cloud-declined.png')
        plan = (await account()).get('plan')
        check('D-08 卡号 4000 0000 0000 0002：Stripe 页面提示卡被拒，账户仍是免费版', bool(declined) and plan == 'free', (declined or '没看到被拒提示')[:60])
        if pay and not pay.is_closed():
            await pay.close()
        await prem.close()

        # D-09：在网页上打开侧面板 → Premium → 开通 Premium（年付），4242 付款
        web = await ctx.new_page()
        await web.goto(ARTICLE)
        await web.wait_for_timeout(800)
        await web.locator('glimmer-ui >> .ball').hover()
        await web.wait_for_timeout(300)
        await web.locator('glimmer-ui >> [data-act=panel]').click()
        fr = None
        for _ in range(25):
            fr = next((f for f in web.frames if 'panel/panel.html' in f.url), None)
            if fr:
                break
            await asyncio.sleep(0.2)
        await fr.wait_for_selector('header [data-act=premium]')
        await fr.locator('header [data-act=premium]').click()
        prem = await find_tab('premium/premium.html', 15)
        await prem.wait_for_selector('.plan.premium [data-act=buy]')
        pay = await subscribe(prem, 'premium')
        for attempt in range(2):  # 第三方支付页偶尔没提交出去：60 秒没跳回就刷新重填一次
            step(f'D-09 4242 付款（第 {attempt + 1} 次）')
            try:
                await asyncio.wait_for(fill_card(pay, CARD_OK), 120)
                await pay.wait_for_url(re.compile(r'billing-return\?status=success'), timeout=60000)
                break
            except Exception as e:
                print('  支付页操作失败：', (str(e).splitlines() or [type(e).__name__])[0][:100])
                await shot(pay, f'cloud-d09-try{attempt + 1}.png')
                if attempt:
                    raise
                await pay.reload()
        try:
            first = await pay.locator('body').inner_text(timeout=3000)
        except Exception:
            first = '（返回页已被扩展接管）'
        await wait_for(lambda: asyncio.sleep(0, pay.is_closed() or None), 60)
        await wait_for(lambda: prem.locator('#doneModal:not([hidden])').count(), 15)
        done = await prem.locator('#doneModal').inner_text()
        on = await prem.locator('#doneEngines .pe.on').get_attribute('data-engine') if await prem.locator('#doneEngines .pe.on').count() else ''
        await shot(prem, 'cloud-paid-premium.png')
        check('D-09 4242 付款后支付页自动关闭，方案页弹出“支付成功 · 你现在是 Premium 会员”、解锁功能、默认引擎 DeepL 选中、“开始使用”与回到网页的提示',
              pay.is_closed() and '你现在是 Premium 会员' in done and 'DeepL 专业翻译' in done and on == 'deepl'
              and '保持 Google 翻译' in done and '开始使用' in done and '点击后回到你正在阅读的网页' in done,
              f'返回页：{re.sub(chr(10), " ", first)[:40]}')
        acc = await account()
        pp2 = await panel('account')
        body = await pp2.locator('body').inner_text()
        await pp2.close()
        pp2 = await panel()  # 右上角的“Premium”在面板首页
        chip = pp2.locator('header [data-act=premium]')
        cls = await chip.get_attribute('class', timeout=10000) if await chip.count() else ''
        crown = await chip.locator('svg').count() if await chip.count() else 0
        check('D-09 面板账户页显示“Premium 会员”与下次续费日期，首页右上角为带皇冠的实心“Premium”',
              acc.get('plan') == 'premium' and 'Premium 会员' in body and '下次续费' in body
              and ' on' in f' {cls}' and crown >= 1, f'{acc.get("plan")} / chip: {cls}')
        await pp2.close()

        await prem.locator('#doneOk').click()
        await wait_for(lambda: asyncio.sleep(0, prem.is_closed() or None), 10)
        active = await sw.evaluate("chrome.tabs.query({active:true,lastFocusedWindow:true}).then(t=>t[0]?.url||'')")
        eng = await sw.evaluate("chrome.storage.local.get('settings').then(r=>r.settings?.engine)")
        check('D-09c 保持 DeepL 点“开始使用”：方案页关闭，回到之前阅读的网页，默认引擎变为 DeepL',
              prem.is_closed() and 'article.html' in active and eng == 'deepl', f'{active[-20:]} / {eng}')

        prof = poll(lambda: next((r for r in rest('profiles', f'id=eq.{a["id"]}&select=plan,subscription_status,stripe_customer_id')
                                  if r['plan'] == 'premium'), None), 20) or {}
        subs = rest('subscriptions', f'user_id=eq.{a["id"]}&select=id,status,billing_interval')
        # 这个账号先做了 D-08：被拒的卡会留下一条 incomplete 订阅（Stripe 约 23 小时后标为过期），只看有效的那条
        live = [r for r in subs if r['status'] == 'active']
        cus = prof.get('stripe_customer_id') or ''
        ss = stripe_api('GET', f'/subscriptions?customer={cus}&status=all').get('data', []) if cus else []
        ss = [x for x in ss if x['status'] == 'active']
        price = ss[0]['items']['data'][0]['price']['id'] if ss else ''
        evs = [e for e in stripe_api('GET', '/events?limit=50').get('data', []) if (e['data']['object'].get('customer') == cus)]
        pending = poll(lambda: all(e['pending_webhooks'] == 0 for e in
                                   [x for x in stripe_api('GET', '/events?limit=50').get('data', []) if x['data']['object'].get('customer') == cus]) or None, 30)
        check('D-10 数据库：profiles.plan = premium、subscription_status = active，subscriptions 有一条有效的年付记录（D-08 被拒留下的 incomplete 不影响）',
              prof.get('subscription_status') == 'active' and len(live) == 1 and live[0]['billing_interval'] == 'year',
              f'{prof.get("plan")},{prof.get("subscription_status")} / {subs}')
        check('D-10 Stripe：该客户有一个有效的 Premium 年付订阅，相关通知全部成功送达云端（没有待重试的 webhook）',
              len(ss) == 1 and price == ENV['STRIPE_PRICE_PREMIUM_YEARLY'].strip() and evs and pending,
              f'{len(evs)} 个事件，类型：{sorted({e["type"] for e in evs})[:4]}')
        await web.close()

        if not SKIP_E:
            await journey5(ctx, sw, eid, a, prof.get('stripe_customer_id') or '', panel, account, find_tab)
            if not SKIP_F:
                await journey6(ctx, sw, eid, a, panel, account)

        # D-09b：点“开通”后关闭方案页，再完成付款
        await sign_in(b)
        prem = await ctx.new_page()  # 所有标签都关闭后没有窗口，后台无法 tabs.create，直接新开标签
        await prem.goto(f'chrome-extension://{eid}/premium/premium.html')
        await prem.wait_for_selector('.plan.premium [data-act=buy]')
        await wait_for(lambda: prem.locator('#who .email').count(), 10)
        pay = await subscribe(prem, 'premium')
        await prem.close()
        for attempt in range(2):  # 第三方支付页偶尔没提交出去：60 秒后还停在支付页就刷新重填一次
            step(f'D-09b 关闭方案页后付款（第 {attempt + 1} 次）')
            try:
                await asyncio.wait_for(fill_card(pay, CARD_OK), 120)
            except Exception as e:
                print('  支付页操作失败：', (str(e).splitlines() or [type(e).__name__])[0][:100])
            await wait_for(lambda: asyncio.sleep(0, (not pay.is_closed() and 'checkout.stripe.com' not in pay.url) or None), 60)
            if 'checkout.stripe.com' not in pay.url:
                break
            await shot(pay, f'cloud-d09b-try{attempt + 1}.png')
            await pay.reload()
        await wait_for(lambda: asyncio.sleep(0, (not pay.is_closed() and 'premium/premium.html' in pay.url) or None), 60)
        ok = 'premium/premium.html' in pay.url
        if ok:
            await wait_for(lambda: pay.locator('#doneModal:not([hidden])').count(), 15)
        txt = await pay.locator('#doneModal').inner_text() if ok else pay.url[:60]
        check('D-09b 原方案页已关闭：支付标签页自动变成方案页，并弹出“支付成功”', ok and '支付成功' in txt and 'Premium' in txt, txt[:40])
        await pay.close()

        # D-11：另一个新账号开通 Premium+，3D 验证卡
        await sign_in(c)
        prem = await ctx.new_page()  # 所有标签都关闭后没有窗口，后台无法 tabs.create，直接新开标签
        await prem.goto(f'chrome-extension://{eid}/premium/premium.html')
        await prem.wait_for_selector('.plan.premium_plus [data-act=buy]')
        await wait_for(lambda: prem.locator('#who .email').count(), 10)
        pay = await subscribe(prem, 'premium_plus', interval='year')
        shown = False
        for attempt in range(2):  # 第三方支付页偶尔没提交出去：45 秒内没出现验证窗口就刷新重填一次
            step(f'D-11 3D 验证卡付款（第 {attempt + 1} 次）')
            try:
                await asyncio.wait_for(fill_card(pay, CARD_3DS), 120)
                shown = await pass_3ds(pay, 45)
            except Exception as e:
                print('  支付页操作失败：', (str(e).splitlines() or [type(e).__name__])[0][:100])
            if shown or pay.is_closed():
                break
            await shot(pay, 'cloud-3ds.png')
            await pay.reload()
        await wait_for(lambda: asyncio.sleep(0, pay.is_closed() or None), 90)
        await wait_for(lambda: prem.locator('#doneModal:not([hidden])').count(), 15)
        done = await prem.locator('#doneModal').inner_text()
        acc = await account()
        check('D-11 卡号 4000 0025 0000 3155：弹出 3D 验证，通过后付款成功并变为 Premium+',
              shown and acc.get('plan') == 'premium_plus' and '你现在是 Premium+ 会员' in done, f'验证窗口 {"出现" if shown else "未出现"} / {acc.get("plan")}')
        await ctx.close()


async def journey5(ctx, sw, eid, a, cus, panel, account, find_tab):
    """旅程五（E-01 ~ E-10）：用 D-09 真实付款开通的 Premium 账号，测会员权益、边界与升级到 Premium+"""
    print('\n[旅程五] Premium 会员的权益与边界')
    tr = lambda pg, eng, text='Good morning, my friend.': pg.evaluate(
        "(e)=>chrome.runtime.sendMessage({type:'translate',engine:e.eng,texts:[e.text],to:'zh-CN',noCache:true})", {'eng': eng, 'text': text})
    zh = lambda s: any('一' <= ch <= '鿿' for ch in (s or ''))
    W = "()=>chrome.storage.local.get('words').then(r=>r.words||[])"
    cloud_words = lambda: rest('words', f'user_id=eq.{a["id"]}&select=key,deleted')

    pp = await panel()
    await pp.locator('[data-pick=engine]').first.click()
    await pp.wait_for_selector('.opt[data-set=deepl]')
    tag = lambda e: pp.locator(f'.opt[data-set={e}] .tag').get_attribute('class')
    t = {e: await tag(e) for e in ('deepl', 'microsoft', 'deepseek', 'openai')}
    check('E-01 引擎列表：DeepL、Microsoft 可选（已解锁），大模型仍标 Premium+ 未解锁',
          all('pro' in t[e] for e in ('deepl', 'microsoft')) and all('need' in t[e] for e in ('deepseek', 'openai')), t)
    await pp.locator('.opt[data-set=deepseek]').click()
    up = await wait_for(lambda: pp.locator('.upsell').count(), 5)
    txt = await pp.locator('.upsell').inner_text() if up else ''
    eng = await sw.evaluate("chrome.storage.local.get('settings').then(r=>r.settings?.engine)")
    r = await tr(pp, 'deepseek')
    check('E-04 点 DeepSeek 弹出升级卡“DeepSeek 需要 Premium+ 会员”“$6 / 月 或 $69 / 年”，引擎不切换；手动用 DeepSeek 翻译被拒',
          'DeepSeek 需要 Premium+ 会员' in txt and '$6 / 月 或 $69 / 年' in txt and eng != 'deepseek'
          and not r.get('ok') and '需要 Premium+ 会员' in (r.get('error') or ''), (r.get('error') or '')[:40])
    await pp.close()

    pg = await panel()
    r = await tr(pg, 'deepl')
    await pg.close()
    check('E-02 DeepL 经云端返回中文译文', r.get('ok') and zh(r['data'][0]), (r.get('data') or [r.get('error')])[0])
    web = await ctx.new_page()
    await web.goto(ARTICLE)
    await web.wait_for_timeout(800)
    await sw.evaluate("""async ()=>{const t=(await chrome.tabs.query({})).find(t=>t.url&&t.url.includes('article.html'));
      await chrome.tabs.sendMessage(t.id,{type:'setPage',on:true})}""")
    done = await wait_for(lambda: web.evaluate("""()=>[...document.querySelectorAll('gl-trans:not(.gl-loading):not(.gl-error)')]
      .filter(g=>/[\\u4e00-\\u9fff]/.test(g.textContent)).length"""), 30)
    errs = await web.evaluate("document.querySelectorAll('gl-trans.gl-error').length")
    check('E-02 默认引擎 DeepL（D-09c 选的）整页翻译：译文正常显示', eng == 'deepl' and done >= 3 and errs == 0, f'{eng}，{done} 段，失败 {errs}')
    await web.close()
    pg = await panel()
    r = await tr(pg, 'microsoft')
    check('E-03 Microsoft：等级校验通过，提示“服务端尚未配置 Microsoft 的 API Key”',
          not r.get('ok') and '服务端尚未配置 Microsoft' in (r.get('error') or ''), (r.get('error') or '')[:50])

    await sw.evaluate("""()=>chrome.storage.local.set({words:Array.from({length:100},(_,i)=>({w:'word'+i,t:'',url:'',ts:Date.now(),m:false,u:Date.now()}))})""")
    r = await pg.evaluate("chrome.runtime.sendMessage({type:'toggleWord',word:'serendipity',trans:'意外发现',url:'https://example.com'})")
    n = len(await sw.evaluate(W))
    check('E-05 生词本不限数量：已有 100 个时再收藏一个成功，共 101 个', n == 101 and not (r or {}).get('error'), n)
    row = poll(lambda: next((w for w in cloud_words() if w['key'] == 'serendipity' and not w['deleted']), None), 20)
    check('E-06 收藏后几秒内上传到云端 words 表（deleted = false）', row is not None)
    await pg.evaluate("chrome.runtime.sendMessage({type:'toggleWord',word:'serendipity'})")
    gone = poll(lambda: next((w for w in cloud_words() if w['key'] == 'serendipity' and w['deleted']), None), 20)
    check('E-07 取消收藏后云端标记 deleted = true', gone is not None)
    await pg.close()
    await sw.evaluate("chrome.storage.local.set({words:[]})")
    pp = await panel('account')
    await pp.locator('[data-act=acctRefresh]').click()
    back = await wait_for(lambda: _count_ge(sw, W, 100), 20)
    keys = {w['w'] for w in await sw.evaluate(W)}
    check('E-08 清空本机生词后点刷新：云端的生词回到生词本（已删除的不会回来）',
          back and 'word0' in keys and 'serendipity' not in keys, len(keys))

    # E-09：账户页“升级到 Premium+” → 方案页“升级到 Premium+” → 打开的是 Stripe 客户门户
    body = await pp.locator('body').inner_text()
    has_btn = '升级到 Premium+ 解锁全部 AI 引擎' in body
    await pp.locator('[data-act=premium]:has-text("升级到 Premium+")').click()
    prem = await find_tab('premium/premium.html', 15)
    await prem.wait_for_selector('#who .email', timeout=15000)
    await prem.locator('#period [data-interval=year]').click()
    label = await prem.locator('.plan.premium_plus [data-act=buy]').inner_text()
    await prem.locator('.plan.premium_plus [data-act=buy]').click()
    portal = await find_tab('billing.stripe.com', 40)
    checkouts = [x for x in ctx.pages if 'checkout.stripe.com' in x.url]
    check('E-09 账户页有“升级到 Premium+”；方案页按钮为“升级到 Premium+”，打开的是 Stripe 客户门户（不是新的支付页）',
          has_btn and label.strip() == '升级到 Premium+' and portal is not None and not checkouts, label)
    sub = next((s for s in stripe_api('GET', f'/subscriptions?customer={cus}&status=active').get('data', [])), None)
    via = '客户门户页面'
    plus_price = ENV['STRIPE_PRICE_PLUS_YEARLY'].strip()
    is_plus = lambda: (stripe_api('GET', f'/subscriptions/{sub["id"]}')['items']['data'][0]['price']['id'] == plus_price)
    if portal:
        try:
            await portal_switch(portal)
            poll(is_plus, 20)
        except Exception as e:
            print('  门户页面操作失败：', (str(e).splitlines() or [type(e).__name__])[0][:100])
            await shot(portal, 'cloud-portal.png')
    if sub and not is_plus():
        # 门户页面不稳定时，用 API 做门户里“切换方案”的同一操作：换价格并按剩余天数折算
        print('  改用 Stripe API 切换到 Premium+ 年付（与门户中切换方案效果相同）')
        stripe_api('POST', f'/subscriptions/{sub["id"]}', {'items[0][id]': sub['items']['data'][0]['id'], 'items[0][price]': plus_price,
                                                          'proration_behavior': 'always_invoice'})
        via = 'Stripe API'
    # 面板以弹窗形态打开方案页时会自动关闭，重新打开账户页
    pp = await panel('account')
    plus = await wait_for(lambda: _plan_after_refresh(pp, account, 'premium_plus'), 40)
    await pp.reload()
    await pp.wait_for_timeout(1200)
    check(f'E-09 切换到 Premium+ 后（{via}）几秒内面板显示“Premium+ 会员”',
          plus and 'Premium+ 会员' in await pp.locator('.plan').inner_text(), plus and plus.get('plan'))
    await shot(pp, 'cloud-plus-account.png')
    active = stripe_api('GET', f'/subscriptions?customer={cus}&status=active').get('data', [])
    prices = [s['items']['data'][0]['price']['id'] for s in active]
    invs = stripe_api('GET', f'/invoices?customer={cus}&limit=5').get('data', [])
    prorated = any(l.get('proration') or (l.get('parent') or {}).get('subscription_item_details', {}).get('proration')
                   for i in invs for l in i.get('lines', {}).get('data', []))
    items = stripe_api('GET', f'/invoiceitems?customer={cus}&limit=10').get('data', [])
    prorated = prorated or any(x.get('proration') for x in items)
    check('E-10 不会重复订阅：该客户只有一个有效订阅，价格已是 Premium+，并按剩余天数折算差价',
          len(active) == 1 and prices == [plus_price] and prorated, f'{len(active)} 个有效订阅，折算 {prorated}')
    for x in (portal, prem, pp):
        if x and not x.is_closed():
            await x.close()


async def journey6(ctx, sw, eid, a, panel, account):
    """旅程六（F-01 ~ F-08）：E-09 升级后的 Premium+ 账号，测全部引擎、DeepSeek 真实翻译、用量记录、预警与额度用完"""
    print('\n[旅程六] Premium+ 会员的权益与额度')
    month = time.strftime('%Y-%m', time.gmtime())
    usage = lambda: (rest('usage_monthly', f'user_id=eq.{a["id"]}&month=eq.{month}&select=tokens,chars,requests') or [{'tokens': 0, 'chars': 0, 'requests': 0}])[0]
    def set_tokens(n):
        admin('POST', '/rest/v1/usage_monthly?on_conflict=user_id,month', {'user_id': a['id'], 'month': month, 'tokens': n},
              {'Prefer': 'resolution=merge-duplicates,return=minimal'})
    tr = lambda pg, eng, text='Good morning, my friend.': pg.evaluate(
        "(e)=>chrome.runtime.sendMessage({type:'translate',engine:e.eng,texts:[e.text],to:'zh-CN',noCache:true})", {'eng': eng, 'text': text})
    zh = lambda s: any('一' <= ch <= '鿿' for ch in (s or ''))
    toast_js = "()=>document.querySelector('glimmer-ui')?.shadowRoot?.textContent||''"

    async def translate_page(url=ARTICLE):
        web = await ctx.new_page()
        await web.goto(url)
        await web.wait_for_timeout(800)
        await sw.evaluate("""async (u)=>{const t=(await chrome.tabs.query({})).find(t=>t.url===u);
          await chrome.tabs.sendMessage(t.id,{type:'setPage',on:true})}""", url)
        done = await wait_for(lambda: web.evaluate("""()=>{const g=[...document.querySelectorAll('gl-trans')];
          return g.length && !g.some(x=>x.classList.contains('gl-loading')) ? g.filter(x=>/[\\u4e00-\\u9fff]/.test(x.textContent)).length : 0}"""), 60)
        errs = await web.evaluate("document.querySelectorAll('gl-trans.gl-error').length")
        return web, done, errs

    pp = await panel()
    await pp.locator('[data-pick=engine]').first.click()
    await pp.wait_for_selector('.opt[data-set=deepseek]')
    tags = await pp.evaluate("[...document.querySelectorAll('.opt[data-set]')].map(o=>[o.dataset.set,o.querySelector('.tag')?.className||''])")
    check('F-01 全部 7 个引擎都可选择，没有未解锁的', len(tags) == 7 and not any('need' in t for _, t in tags), tags)
    await pp.locator('.opt[data-set=deepseek]').click()
    await pp.wait_for_timeout(500)
    eng = await sw.evaluate("chrome.storage.local.get('settings').then(r=>r.settings?.engine)")
    await pp.close()

    before = usage()
    web, done, errs = await translate_page()
    after = poll(lambda: (lambda u: u if u['tokens'] > before['tokens'] else None)(usage()), 20) or usage()
    reqs = after['requests'] - before['requests']
    check('F-02 默认引擎切到 DeepSeek，整页翻译译文正常；一屏多段只发少量请求',
          eng == 'deepseek' and done >= 3 and errs == 0 and 0 < reqs < done, f'{done} 段，{reqs} 次请求，失败 {errs}')
    await web.close()
    pp = await panel('account')
    await pp.locator('[data-act=acctRefresh]').click()
    acc = await wait_for(lambda: _usage_ge(account, after['tokens']), 15)
    check('F-03 用量增加：usage_monthly 的 tokens、requests 增加，账户状态中的本月用量同步更新',
          after['tokens'] > before['tokens'] and reqs > 0 and acc, f"tokens {before['tokens']} → {after['tokens']}")

    await pp.reload()
    await pp.wait_for_timeout(1200)
    card = await pp.locator('.usage').inner_text() if await pp.locator('.usage').count() else ''
    op = await ctx.new_page()
    await op.goto(f'chrome-extension://{eid}/options/options.html')
    await op.wait_for_timeout(1500)
    opt = await op.locator('body').inner_text()
    await op.close()
    check('F-04 账户页用量卡：“本月 AI 用量 … / 20 百万 Token”、进度条、“每月 1 日重置”；完整设置页同样显示本月 AI 用量',
          '本月 AI 用量' in card and '20 百万 Token' in card and '每月 1 日重置' in card and await pp.locator('.usage .bar').count() == 1
          and '本月 AI 用量' in opt and '每月 1 日重置' in opt, card.replace('\n', ' ')[:60])

    set_tokens(17_000_000)
    await pp.locator('[data-act=acctRefresh]').click()
    await wait_for(lambda: _usage_ge(account, 17_000_000), 15)
    home = await panel()
    bar = await home.locator('.usage-bar').inner_text() if await home.locator('.usage-bar').count() else ''
    await home.close()
    await pp.reload()
    await pp.wait_for_timeout(1200)
    warn = await pp.locator('.usage.warn').count()
    hint = await pp.locator('.usage .hint').inner_text() if await pp.locator('.usage .hint').count() else ''
    check('F-04b 用量 85%：面板首页出现“本月 AI 用量已用 85%”，用量卡变金色并提示用完后改用 Google',
          '本月 AI 用量已用 85%' in bar and warn == 1 and '已用 85%，用完后大模型会暂停到下月 1 日，期间自动改用 Google 翻译' in hint, bar.strip()[:30])

    errs5 = {}
    for e in ('openai', 'gemini', 'claude'):
        r = await tr(pp, e)
        errs5[e] = r.get('error') or ''
    check('F-05 GPT、Gemini、Claude：等级校验通过，提示“服务端尚未配置 … 的 API Key”',
          all('服务端尚未配置' in v for v in errs5.values()), {k: v[:24] for k, v in errs5.items()})

    set_tokens(20_000_000)
    await pp.locator('[data-act=acctRefresh]').click()
    await wait_for(lambda: _usage_ge(account, 20_000_000), 15)
    # 换一个没翻译过的网页：F-02 翻过的段落会直接用本机缓存，不经过后端，也就不会触发额度用完的回退
    web, done, errs = await translate_page(ARTICLE.replace('article.html', 'preline.html'))
    notice = await wait_for(lambda: _toast_has(web, toast_js, '本月 AI 翻译额度已用完，已改用 Google 翻译'), 10)
    r = await tr(pp, 'deepseek')
    home = await panel()
    bar = await home.locator('.usage-bar').inner_text() if await home.locator('.usage-bar').count() else ''
    await home.close()
    check('F-06 额度用完：整页自动改用 Google 并提示“本月 AI 翻译额度已用完，已改用 Google 翻译”；手动用 DeepSeek 提示“20 百万 Token 已用完，下月 1 日恢复”；首页显示额度已用完',
          done >= 2 and errs == 0 and notice and '本月 AI 翻译额度（20 百万 Token）已用完，下月 1 日恢复' in (r.get('error') or '')
          and '本月 AI 额度已用完' in bar, f"{done} 段 / 网页提示 {'有' if notice else '无'} / 首页：{bar.strip()[:24]}")
    await web.close()
    ok = {}
    for e in ('deepl', 'google'):
        r = await tr(pp, e)
        ok[e] = bool(r.get('ok')) and zh(r['data'][0])
    check('F-07 额度用完后 DeepL、Google 仍能正常翻译', all(ok.values()), ok)

    # 预置账号在本地用 seed 脚本恢复；云端测试账号把用量改回测试前，并确认大模型恢复可用
    set_tokens(after['tokens'])
    await pp.locator('[data-act=acctRefresh]').click()
    await wait_for(lambda: _usage_le(account, after['tokens']), 15)
    r = await tr(pp, 'deepseek')
    check('F-08 用量恢复后 DeepSeek 重新可用', r.get('ok') and zh(r['data'][0]), (r.get('data') or [r.get('error')])[0])
    await pp.close()


async def _usage_ge(account, n):
    a = await account()
    return a if (a.get('usage') or {}).get('tokens', 0) >= n else None


async def _usage_le(account, n):
    a = await account()
    return a if (a.get('usage') or {}).get('tokens', 0) <= n else None


async def _toast_has(page, js, text):
    t = await page.evaluate(js)
    return text if text in t else None


async def _count_ge(sw, W, n):
    ws = await sw.evaluate(W)
    return len(ws) >= n or None


async def _plan_after_refresh(pp, account, want):
    await pp.evaluate("chrome.runtime.sendMessage({type:'accountRefresh'})")
    a = await account()
    return a if a.get('plan') == want else None


async def portal_switch(portal):
    """在 Stripe 客户门户中把订阅切换到 Premium+ 年付"""
    upd = portal.locator('a:has-text("Update subscription"), button:has-text("Update subscription"), a:has-text("Update plan"), button:has-text("Update plan"), [data-test="update-subscription"]').first
    await upd.wait_for(state='visible', timeout=60000)
    await upd.click()
    # 方案列表：选含 Premium+ 的那一项（年付）
    yearly = portal.locator('button:has-text("Yearly"), [role=tab]:has-text("Yearly"), label:has-text("Yearly")').first
    if await yearly.count():
        try:
            await yearly.click(timeout=5000)
        except Exception:
            pass
    # 方案列表：当前方案的按钮是“Selected”，另一档（Premium+）是“Select”
    await portal.get_by_role('button', name='Select', exact=True).first.click(timeout=30000)
    cont = portal.get_by_role('button', name=re.compile(r'^Continue$', re.I))
    await cont.click(timeout=30000)  # 选中新方案后才可点；click 会等到按钮可用
    # 确认页：显示折算差价，点“Confirm”
    confirm = portal.get_by_role('button', name=re.compile(r'^(Confirm|Subscribe and pay|Pay and subscribe)', re.I)).first
    await confirm.wait_for(state='visible', timeout=30000)
    await shot(portal, 'cloud-portal-confirm.png')
    await confirm.click()


async def _declined(pay):
    t = await page_text(pay)
    m = re.search(r'[^\n]*(declined|被拒)[^\n]*', t, re.I)
    return m.group(0).strip() if m else None


asyncio.run(main())
