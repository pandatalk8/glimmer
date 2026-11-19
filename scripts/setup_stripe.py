"""一键准备 Stripe：创建微光翻译的两个会员产品、三个价格、客户门户配置，并写入 .env。

用法：python3 scripts/setup_stripe.py [supabase/functions/.env]
  - 读取 .env 中的 STRIPE_SECRET_KEY（只允许 sk_test_ 测试密钥）
  - 写入 STRIPE_PRICE_PREMIUM_YEARLY、STRIPE_PRICE_PLUS_MONTHLY、STRIPE_PRICE_PLUS_YEARLY、STRIPE_PORTAL_CONFIGURATION
  - 可重复执行：价格按 lookup_key、产品按 metadata、门户配置按 metadata 复用；创建请求带幂等键，网络重试不会重复创建
  - 不打印任何密钥
价格在下方 PLANS 中修改（已创建的价格不会被修改：需在 Stripe 后台归档旧价格，并修改 lookup_key 后重新执行）。
"""
import base64, hashlib, json, sys, time, urllib.error, urllib.parse, urllib.request

ENV = sys.argv[1] if len(sys.argv) > 1 else 'supabase/functions/.env'
CURRENCY = 'usd'
PLANS = [
    # (产品 metadata.plan, 产品名称, 描述, [(lookup_key, 金额（分）, 周期, .env 变量名)])
    ('premium', '微光翻译 Premium', '无限生词本、生词本云同步、DeepL 与 Microsoft 专业翻译',
     [('glimmer_premium_yearly', 2900, 'year', 'STRIPE_PRICE_PREMIUM_YEARLY')]),
    ('premium_plus', '微光翻译 Premium+ 高级 AI', 'Premium 全部功能 + GPT、Gemini、DeepSeek、Claude，每月 2000 万 Token',
     [('glimmer_plus_monthly', 600, 'month', 'STRIPE_PRICE_PLUS_MONTHLY'),
      ('glimmer_plus_yearly', 6900, 'year', 'STRIPE_PRICE_PLUS_YEARLY')]),
]

env_lines = open(ENV, encoding='utf-8').read().splitlines()
env = dict(l.split('=', 1) for l in env_lines if '=' in l and not l.startswith('#'))
KEY = env['STRIPE_SECRET_KEY'].strip()
assert KEY.startswith('sk_test_'), '只允许测试密钥'
AUTH = 'Basic ' + base64.b64encode((KEY + ':').encode()).decode()


def api(method, path, data=None):
    body = urllib.parse.urlencode(data or [], doseq=True).encode() if method == 'POST' else None
    url = 'https://api.stripe.com/v1' + path
    if method == 'GET' and data:
        url += '?' + urllib.parse.urlencode(data, doseq=True)
    headers = {'Authorization': AUTH}
    if method == 'POST':  # 幂等键：重试时 Stripe 返回第一次的结果
        headers['Idempotency-Key'] = 'glimmer-setup-' + hashlib.sha256(path.encode() + body).hexdigest()[:32]
    for attempt in range(5):
        req = urllib.request.Request(url, data=body, method=method, headers=headers)
        try:
            return json.loads(urllib.request.urlopen(req, timeout=30).read())
        except urllib.error.HTTPError as e:
            raise SystemExit(f'Stripe 错误 {e.code}: {e.read().decode()[:300]}')
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            print(f'  网络错误，{2 * (attempt + 1)} 秒后重试（{attempt + 1}/5）：{getattr(e, "reason", e)}')
            time.sleep(2 * (attempt + 1))
    raise SystemExit('网络持续失败，请检查网络或代理')


updates = {}
portal_products = []
existing_products = {p['metadata'].get('plan'): p for p in api('GET', '/products', {'limit': 100, 'active': 'true'})['data']
                     if p.get('metadata', {}).get('app') == 'glimmer' and p['metadata'].get('plan')}
for plan, name, desc, prices in PLANS:
    product = existing_products.get(plan)
    if product:
        print(f'复用产品 {name}', product['id'])
    else:
        product = api('POST', '/products', {'name': name, 'description': desc, 'metadata[app]': 'glimmer', 'metadata[plan]': plan})
        print(f'创建产品 {name}', product['id'])
    found = {p['lookup_key']: p for p in api('GET', '/prices', [('lookup_keys[]', lk) for lk, *_ in prices])['data']}
    ids = []
    for lookup, amount, interval, env_name in prices:
        if lookup in found:
            pid = found[lookup]['id']
            print(f'  复用价格 {interval}', pid)
        else:
            pid = api('POST', '/prices', {'product': product['id'], 'unit_amount': amount, 'currency': CURRENCY,
                                          'recurring[interval]': interval, 'lookup_key': lookup, 'nickname': f'{name} {interval}'})['id']
            print(f'  创建价格 {interval}', pid, f'${amount / 100:g}')
        updates[env_name] = pid
        ids.append(pid)
    portal_products.append((product['id'], ids))

# 客户门户：允许取消（到期后）、换卡、发票，以及在 Premium 与 Premium+ 之间切换
conf = next((c for c in api('GET', '/billing_portal/configurations', {'limit': 100})['data']
             if c.get('metadata', {}).get('app') == 'glimmer' and c.get('metadata', {}).get('version') == 'tiers' and c['active']), None)
if conf:
    print('复用客户门户配置', conf['id'])
else:
    data = [('business_profile[headline]', '微光翻译：管理你的会员订阅'),
            ('features[subscription_cancel][enabled]', 'true'),
            ('features[subscription_cancel][mode]', 'at_period_end'),
            ('features[payment_method_update][enabled]', 'true'),
            ('features[invoice_history][enabled]', 'true'),
            ('features[subscription_update][enabled]', 'true'),
            ('features[subscription_update][default_allowed_updates][]', 'price'),
            ('features[subscription_update][proration_behavior]', 'create_prorations'),
            ('metadata[app]', 'glimmer'), ('metadata[version]', 'tiers')]
    for i, (prod, ids) in enumerate(portal_products):
        data.append((f'features[subscription_update][products][{i}][product]', prod))
        data += [(f'features[subscription_update][products][{i}][prices][]', pid) for pid in ids]
    conf = api('POST', '/billing_portal/configurations', data)
    print('创建客户门户配置', conf['id'])
updates['STRIPE_PORTAL_CONFIGURATION'] = conf['id']

# 写入 .env：已有的行就地更新，缺少的追加到末尾
seen = set()
out = []
for l in env_lines:
    k = l.split('=', 1)[0]
    if k in updates:
        out.append(f'{k}={updates[k]}')
        seen.add(k)
    else:
        out.append(l)
out += [f'{k}={v}' for k, v in updates.items() if k not in seen]
open(ENV, 'w', encoding='utf-8').write('\n'.join(out) + '\n')
print('已写入 .env：', ', '.join(updates))
