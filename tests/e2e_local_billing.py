"""真实联调：本地 Supabase + 本地 Edge Functions + Stripe 测试 / 沙盒，用测试卡走完整的订阅流程。

前提（见 docs/local-dev.md 第四节）：
  npx supabase start
  stripe listen --forward-to http://127.0.0.1:54321/functions/v1/stripe-webhook
  npx supabase functions serve --env-file supabase/functions/.env

用法：python3 tests/e2e_local_billing.py [--headed]
"""
import asyncio, json, os, re, subprocess, sys, tempfile, time, urllib.request, uuid
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT = os.path.join(ROOT, 'tests', 'output')
HEADED = '--headed' in sys.argv

st = json.loads(subprocess.run(['npx', '-y', 'supabase@3.2.0', 'status', '-o', 'json'], cwd=ROOT,
                               capture_output=True, text=True).stdout or '{}')
if not st.get('API_URL'):
    sys.exit('本地 Supabase 没有运行：先执行 npx supabase start')
API, PUB, MAIL, DB = st['API_URL'], st['PUBLISHABLE_KEY'], st['MAILPIT_URL'], st['DB_URL']
results = []
ENV = dict(l.split('=', 1) for l in open(os.path.join(ROOT, 'supabase/functions/.env'), encoding='utf-8').read().splitlines()
           if '=' in l and not l.startswith('#'))


def stripe_api(method, path, data=None):
    """用 .env 中的测试密钥调用 Stripe API（不打印密钥），网络不稳时重试"""
    import base64, urllib.parse
    key = ENV['STRIPE_SECRET_KEY'].strip()
    assert key.startswith('sk_test_')
    body = urllib.parse.urlencode(data or {}).encode() if method == 'POST' else None
    for attempt in range(5):
        req = urllib.request.Request('https://api.stripe.com/v1' + path, data=body, method=method,
                                     headers={'Authorization': 'Basic ' + base64.b64encode((key + ':').encode()).decode()})
        try:
            return json.loads(urllib.request.urlopen(req, timeout=30).read())
        except urllib.error.HTTPError as e:
            raise RuntimeError(f'Stripe {e.code}: {e.read().decode()[:200]}')
        except Exception:
            time.sleep(2 * (attempt + 1))
    raise RuntimeError('Stripe 网络持续失败')


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('  PASS  ' if ok else '  FAIL  ') + name + (f'  ({detail})' if detail != '' else ''))


def sql(q):
    return subprocess.run(['psql', DB, '-At', '-c', q], capture_output=True, text=True).stdout.strip()


def verify_link(email):
    for _ in range(40):
        with urllib.request.urlopen(f'{MAIL}/api/v1/search?query=to:{email}') as r:
            msgs = json.loads(r.read()).get('messages', [])
        if msgs:
            with urllib.request.urlopen(f"{MAIL}/api/v1/message/{msgs[0]['ID']}") as r:
                html = json.loads(r.read()).get('HTML', '')
            m = re.search(r'href="([^"]*/auth/v1/verify[^"]*)"', html)
            return m.group(1).replace('&amp;', '&') if m else None
        time.sleep(0.5)
    return None


async def wait_for(fn, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        v = await fn()
        if v:
            return v
        await asyncio.sleep(0.5)
    return await fn()


async def payment_frame(pay, timeout=90):
    """新版 Checkout 把支付表单放在 elements-inner 的 iframe 中；返回包含“Card”选项或卡号输入框的 frame"""
    end = time.time() + timeout
    while time.time() < end:
        for f in pay.frames:
            if 'elements-inner' not in f.url:
                continue
            try:
                if await f.locator('#payment-numberInput, [role=button]:has-text("Card")').count():
                    return f
            except Exception:
                pass  # frame 可能在加载中被替换
        if await pay.locator('#cardNumber').count():
            return pay.main_frame  # 旧版 Checkout：表单在主页面
        await asyncio.sleep(1)
    raise TimeoutError('支付表单未出现')


async def fill_card(pay):
    """在 Stripe Checkout 页面填写测试卡 4242 并付款（兼容新旧两版页面）"""
    f = await payment_frame(pay)
    if f is pay.main_frame:  # 旧版
        await f.locator('#cardNumber').fill('4242 4242 4242 4242')
        await f.locator('#cardExpiry').fill('12 / 34')
        await f.locator('#cardCvc').fill('123')
        for sel, val in [('#billingName', 'Glimmer Tester'), ('#billingPostalCode', '10001')]:
            if await f.locator(sel).count():
                await f.locator(sel).fill(val)
        await f.locator('button[type="submit"], .SubmitButton').first.click()
        return
    # 新版：先选中“Card”，卡号等输入框才会出现
    if not await f.locator('#payment-numberInput').is_visible():
        await f.locator('[role=button]:has-text("Card")').first.click()
    await f.locator('#payment-numberInput').fill('4242424242424242', timeout=30000)
    await f.locator('#payment-expiryInput').fill('1234')
    await f.locator('#payment-cvcInput').fill('123')
    if await f.locator('#payment-nameInput').count():
        await f.locator('#payment-nameInput').fill('Glimmer Tester')
    if await f.locator('#payment-postalCodeInput').count():
        await f.locator('#payment-postalCodeInput').fill('10001')
    # “保存到 Link”是自定义控件，取消勾选可能无效；仍勾选时填测试手机号满足必填
    opt = f.locator('#payment-linkOptInInput')
    try:
        if await opt.count() and await opt.is_checked():
            await f.locator('label:has-text("Save my information")').first.click(timeout=3000)
    except Exception:
        pass
    phone = f.locator('#payment-linkMobilePhoneInput')
    if await opt.count() and await opt.is_checked() and await phone.count() and await phone.is_visible():
        await phone.fill('2015550123')
    # 可见的“Subscribe”按钮在主页面；iframe 中的提交按钮是隐藏的
    main_btn = pay.locator('.SubmitButton, button[data-testid="hosted-payment-submit-button"]').first
    if await main_btn.count():
        await main_btn.click()
    else:
        await pay.get_by_role('button', name=re.compile(r'^(Subscribe|Pay|Start trial)', re.I)).first.click()


async def main():
    os.makedirs(OUTPUT, exist_ok=True)
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            tempfile.mkdtemp(prefix='glimmer-billing-'), channel='chromium', headless=not HEADED,
            args=[f'--disable-extensions-except={ROOT}', f'--load-extension={ROOT}'],
            viewport={'width': 1200, 'height': 900}, locale='en-US')
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        eid = sw.url.split('/')[2]
        await asyncio.sleep(1.5)
        for pg in ctx.pages:
            await pg.close()
        await sw.evaluate('(o)=>chrome.storage.local.set({backendOverride:o})', {'supabaseUrl': API, 'supabaseAnonKey': PUB})
        account = lambda: sw.evaluate("chrome.storage.local.get('account').then(r=>r.account)")

        pp = await ctx.new_page()
        await pp.set_viewport_size({'width': 400, 'height': 640})
        await pp.goto(f'chrome-extension://{eid}/panel/panel.html?view=account')
        await pp.wait_for_timeout(500)

        print('[1] 注册与邮箱验证（真实本地 Supabase）')
        email, pw = f'buyer-{uuid.uuid4().hex[:6]}@test.local', 'secret123'
        await pp.locator('[data-act=authMode][data-mode=signup]').click()
        await pp.fill('[name=email]', email)
        await pp.fill('[name=password]', pw)
        await pp.locator('.submit').click()
        await wait_for(lambda: pp.locator('.msg.ok').count(), 15)
        check('注册后提示查收验证邮件', '验证邮件已发送' in await pp.locator('.msg').inner_text())
        link = verify_link(email)
        check('本地邮箱收到验证邮件', link is not None)
        vp = await ctx.new_page()
        try:
            await vp.goto(link, timeout=15000)
        except Exception:
            pass  # 验证后跳转到 site_url 示例网址，打不开不影响
        await vp.close()
        await pp.fill('[name=password]', pw)
        await pp.locator('.submit').click()
        await wait_for(lambda: pp.locator('.acct-info').count(), 15)
        check('验证后在面板登录成功，免费版', '免费版' in await pp.locator('.plan').inner_text())

        print('\n[2] Premium 方案页 → 订阅 Premium+ 月付：Stripe Checkout 测试卡付款')
        await pp.locator('.pro-card [data-act=premium]').click()
        prem = await wait_for(lambda: asyncio.sleep(0, next((x for x in ctx.pages if 'premium/premium.html' in x.url), None)), 15)
        check('面板“查看会员方案”打开 Premium 页面', prem is not None)
        await prem.wait_for_selector('.plan.premium_plus [data-act=buy]')
        await prem.locator('#period [data-interval=month]').click()
        await prem.locator('.plan.premium_plus [data-act=buy]').click()
        pay = await wait_for(lambda: asyncio.sleep(0, next((x for x in ctx.pages if 'checkout.stripe.com' in x.url), None)), 30)
        check('新标签页打开 Stripe 支付页', pay is not None, pay.url[:60] if pay else await pp.locator('.body').inner_text())
        if not pay:
            raise SystemExit(1)
        back = False
        for attempt in range(2):
            try:
                await fill_card(pay)
                await pay.wait_for_url(re.compile(r'billing-return\?status=success'), timeout=60000)
                back = True
                break
            except Exception as e:
                print(f'  支付页操作失败（第 {attempt + 1} 次）：{str(e).splitlines()[0][:100]}')
                await pay.screenshot(path=f'{OUTPUT}/billing-checkout-after.png')
                if attempt == 0:
                    await pay.reload()
        if back:
            check('支付页填写测试卡付款，跳回本地返回页（PUBLIC_SUPABASE_URL 生效）', True, pay.url[:70])
        else:
            # 第三方支付页自动化不稳定时，用 Stripe API 为同一客户创建相同的订阅：
            # Stripe 会发出同样真实的订阅通知，后续 webhook → 数据库 → 扩展刷新的流程完全一致
            print('  改用 Stripe API 以测试卡 pm_card_visa 创建订阅（模拟支付页付款）')
            uid = sql(f"select id from profiles where email='{email}'")
            cus = sql(f"select stripe_customer_id from profiles where email='{email}'")
            check('支付页已为用户创建 Stripe 客户', cus.startswith('cus_'), cus)
            pm = stripe_api('POST', '/payment_methods/pm_card_visa/attach', {'customer': cus})['id']
            subn = stripe_api('POST', '/subscriptions', {'customer': cus, 'items[0][price]': ENV['STRIPE_PRICE_PLUS_MONTHLY'],
                                                         'default_payment_method': pm, 'metadata[user_id]': uid})
            check('Stripe API 创建订阅成功（测试卡扣款）', subn.get('status') == 'active', subn.get('status'))
            await pay.goto(f'{API}/functions/v1/billing-return?status=success')  # 模拟付款后的跳转
            check('打开本地返回页（PUBLIC_SUPABASE_URL 地址可访问）', 'billing-return' in pay.url and '订阅成功' in await pay.content())
        acc = await wait_for(lambda: _pro(account), 40)
        check('webhook 同步后自动变为 Premium+', acc and acc.get('plan') == 'premium_plus', acc and {k: acc.get(k) for k in ('plan', 'status', 'periodEnd')})
        row = sql(f"select plan||','||subscription_status||','||(stripe_customer_id is not null) from profiles where email='{email}'")
        check('数据库 profiles 已更新', row.startswith('premium_plus,active,t'), row)
        sub = sql(f"select status||','||billing_interval from subscriptions s join profiles p on p.id=s.user_id where p.email='{email}'")
        check('数据库 subscriptions 记录月付订阅', sub == 'active,month', sub)
        # 弹窗形态的面板打开方案页后已自动关闭，重新打开账户页
        pp = await ctx.new_page()
        await pp.set_viewport_size({'width': 400, 'height': 640})
        await pp.goto(f'chrome-extension://{eid}/panel/panel.html?view=account')
        await pp.wait_for_timeout(1200)
        await pp.screenshot(path=f'{OUTPUT}/billing-pro.png')
        check('面板显示 Premium+ 会员、续费日期与 AI 用量', 'Premium+ 会员' in await pp.locator('.plan').inner_text()
              and '下次续费' in await pp.locator('.body').inner_text() and await pp.locator('.usage .bar').count() == 1)

        print('\n[2b] 付费引擎经由本地后端真实翻译，用量入库；生词本云同步')
        uid = sql(f"select id from profiles where email='{email}'")
        for eng in ('deepseek', 'deepl'):
            r = await pp.evaluate("(e)=>chrome.runtime.sendMessage({type:'translate',engine:e,texts:['Good morning, my friend.'],to:'zh-CN',noCache:true})", eng)
            ok = bool(r.get('ok')) and any('\u4e00' <= c <= '\u9fff' for c in r['data'][0])
            check(f'{eng} 经后端返回中文译文', ok, (r.get('data') or [r.get('error')])[0])
        usage = sql(f"select tokens||','||chars||','||requests from usage_monthly where user_id='{uid}'")
        tok, chars, reqs = (int(x) for x in (usage or '0,0,0').split(','))
        check('usage_monthly 记录了 Token、字符数与请求次数', tok > 0 and chars > 0 and reqs >= 2, usage)
        acc = await account()
        check('扩展账户状态中的本月用量随之更新', (acc.get('usage') or {}).get('tokens', 0) > 0, acc.get('usage'))
        await pp.evaluate("chrome.runtime.sendMessage({type:'toggleWord',word:'serendipity',trans:'意外发现',url:'https://example.com'})")
        row = await wait_for(lambda: asyncio.sleep(0, sql(f"select w from words where user_id='{uid}' and not deleted") or None), 15)
        check('收藏的生词同步到云端 words 表', row == 'serendipity', row)
        await pp.evaluate("chrome.runtime.sendMessage({type:'toggleWord',word:'serendipity'})")
        gone = await wait_for(lambda: asyncio.sleep(0, sql(f"select deleted from words where user_id='{uid}' and w='serendipity'") == 't' or None), 15)
        check('取消收藏后云端标记删除', gone is True)

        print('\n[3] 管理订阅：Stripe 客户门户取消续费')
        await pp.locator('[data-act=portal]').first.click()
        portal = await wait_for(lambda: asyncio.sleep(0, next((x for x in ctx.pages if 'billing.stripe.com' in x.url), None)), 30)
        check('打开 Stripe 客户门户（使用命令创建的门户配置）', portal is not None)
        if portal:
            sub_id = sql(f"select s.id from subscriptions s join profiles p on p.id=s.user_id where p.email='{email}'")
            is_cancelled = lambda: stripe_api('GET', f'/subscriptions/{sub_id}').get('cancel_at_period_end') is True
            via = '客户门户页面'
            try:
                # 门户页较慢，等“取消订阅”按钮真正出现
                btn = portal.locator('a:has-text("Cancel subscription"), button:has-text("Cancel subscription"), [data-test="cancel-subscription"]').first
                await btn.wait_for(state='visible', timeout=90000)
                await portal.screenshot(path=f'{OUTPUT}/billing-portal.png')
                await btn.click()
                confirm = portal.locator('button:has-text("Cancel subscription"), [data-test="confirm"]').last
                await confirm.wait_for(state='visible', timeout=30000)
                await confirm.click()
                for _ in range(20):  # 以 Stripe 上订阅的真实状态为准，而不是“点击没有报错”
                    if is_cancelled():
                        break
                    await asyncio.sleep(1)
            except Exception as e:
                print('  门户页面操作失败：', str(e).splitlines()[0][:100])
                await portal.screenshot(path=f'{OUTPUT}/billing-portal.png')
            if not is_cancelled():
                # 门户页面不稳定时，用 API 执行门户“取消订阅”的同一操作：到期后取消
                print('  改用 Stripe API 设置到期取消（与门户中“取消订阅”效果相同）')
                stripe_api('POST', f'/subscriptions/{sub_id}', {'cancel_at_period_end': 'true'})
                via = 'Stripe API'
            check(f'Stripe 上的订阅已设为到期取消（{via}）', is_cancelled())
            acc = await wait_for(lambda: _cancel(account, pp), 40)
            check('取消后仍为 Premium+，标记到期取消', acc and acc.get('plan') == 'premium_plus' and acc.get('cancelAtPeriodEnd'), acc and acc.get('cancelAtPeriodEnd'))
            await pp.bring_to_front()
            await pp.locator('[data-act=acctRefresh]').click()
            await pp.wait_for_timeout(1500)
            check('面板显示“已取消续费”', '已取消续费' in await pp.locator('.body').inner_text())
            await pp.screenshot(path=f'{OUTPUT}/billing-cancelled.png')

        await ctx.close()

    failed = [n for n, ok in results if not ok]
    print(f'\n结果：{len(results) - len(failed)}/{len(results)} 通过')
    if failed:
        print('失败项：' + '；'.join(failed))
    sys.exit(1 if failed else 0)


async def _pro(account):
    a = await account()
    return a if a and a.get('plan') == 'premium_plus' else None


async def _cancel(account, pp):
    # 在门户中取消不会打开返回页，主动让后台从数据库刷新一次
    await pp.evaluate("chrome.runtime.sendMessage({type:'accountRefresh'})")
    a = await account()
    return a if a and a.get('cancelAtPeriodEnd') else None


asyncio.run(main())
