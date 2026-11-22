"""旅程四（开通会员）在云端自动回归：云端 Supabase（glimmer）+ Stripe 沙盒，用 Stripe 公布的测试卡走完整的付款流程。

覆盖 docs/test-cases.md 的 D-01 ~ D-11。云端的 Stripe 通知直接发到云端函数，不需要 stripe listen。

- 测试账号用云端管理接口直接创建（已验证邮箱），不发验证邮件，不受内置发信每小时约 2 封的限制
- 只用 Stripe 测试密钥（sk_test_）与公布的测试卡号，不会产生真实扣款
- 结束时取消测试订阅、删除 Stripe 测试客户和云端测试账号；加 --keep 保留，方便在 Studio / Stripe 后台查看

前提：已登录 Supabase CLI（npx supabase login），supabase/functions/.env 中有 Stripe 测试密钥与价格。
用法：python3 tests/e2e_cloud_billing.py [--headed] [--keep]
"""
import asyncio, base64, functools, http.server, json, os, re, secrets, subprocess, sys, tempfile, threading, time, urllib.error, urllib.parse, urllib.request
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT = os.path.join(ROOT, 'tests', 'output')
FIXTURES = os.path.join(ROOT, 'tests', 'fixtures')
HEADED = '--headed' in sys.argv
KEEP = '--keep' in sys.argv
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


def admin(method, path, body=None):
    h = {'apikey': SECRET, 'Content-Type': 'application/json'}
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
        step('D-09 4242 付款'); await asyncio.wait_for(fill_card(pay, CARD_OK), 120)
        await pay.wait_for_url(re.compile(r'billing-return\?status=success'), timeout=90000)
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

        # D-09b：点“开通”后关闭方案页，再完成付款
        await sign_in(b)
        prem = await ctx.new_page()  # 所有标签都关闭后没有窗口，后台无法 tabs.create，直接新开标签
        await prem.goto(f'chrome-extension://{eid}/premium/premium.html')
        await prem.wait_for_selector('.plan.premium [data-act=buy]')
        await wait_for(lambda: prem.locator('#who .email').count(), 10)
        pay = await subscribe(prem, 'premium')
        await prem.close()
        step('D-09b 关闭方案页后付款'); await asyncio.wait_for(fill_card(pay, CARD_OK), 120)
        await wait_for(lambda: asyncio.sleep(0, (not pay.is_closed() and 'premium/premium.html' in pay.url) or None), 90)
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


async def _declined(pay):
    t = await page_text(pay)
    m = re.search(r'[^\n]*(declined|被拒)[^\n]*', t, re.I)
    return m.group(0).strip() if m else None


asyncio.run(main())
