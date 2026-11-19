"""一键准备 Stripe：创建微光翻译 Pro 的产品、月付 / 年付价格、客户门户配置，并写入 .env。

用法：python3 scripts/setup_stripe.py [supabase/functions/.env]
  - 读取 .env 中的 STRIPE_SECRET_KEY（只允许 sk_test_ 测试密钥）
  - 写入 STRIPE_PRICE_MONTHLY、STRIPE_PRICE_YEARLY、STRIPE_PORTAL_CONFIGURATION
  - 可重复执行：用价格的 lookup_key 和门户配置的 metadata 复用已有对象；创建请求带幂等键，网络重试不会重复创建
  - 不打印任何密钥
价格：月付 5 美元、年付 48 美元，金额在下方创建价格的循环中修改（已创建的价格不会被修改，需在 Stripe 后台归档旧价格并修改 lookup_key 后重建）。
"""
import base64, json, sys, urllib.parse, urllib.request

ENV = sys.argv[1] if len(sys.argv) > 1 else 'supabase/functions/.env'
env = dict(l.split('=', 1) for l in open(ENV, encoding='utf-8').read().splitlines() if '=' in l and not l.startswith('#'))
KEY = env['STRIPE_SECRET_KEY'].strip()
assert KEY.startswith('sk_test_'), '只允许测试密钥'
AUTH = 'Basic ' + base64.b64encode((KEY + ':').encode()).decode()


import hashlib, time


def api(method, path, data=None):
    body = urllib.parse.urlencode(data or [], doseq=True).encode() if method == 'POST' else None
    url = 'https://api.stripe.com/v1' + path
    if method == 'GET' and data:
        url += '?' + urllib.parse.urlencode(data, doseq=True)
    headers = {'Authorization': AUTH}
    if method == 'POST':
        # 幂等键：同样的创建请求重试时，Stripe 返回第一次的结果，不会重复创建
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


# ---- 价格（按 lookup_key 复用）----
existing = {p['lookup_key']: p for p in api('GET', '/prices', [('lookup_keys[]', 'glimmer_pro_monthly'), ('lookup_keys[]', 'glimmer_pro_yearly'), ('expand[]', 'data.product')])['data']}
if existing:
    product_id = next(iter(existing.values()))['product']['id']
    print('复用产品', product_id)
else:
    product = api('POST', '/products', {'name': '微光翻译 Pro', 'description': '微光翻译 Pro 会员', 'metadata[app]': 'glimmer'})
    product_id = product['id']
    print('创建产品', product_id)

prices = {}
for key, amount, interval in [('glimmer_pro_monthly', 500, 'month'), ('glimmer_pro_yearly', 4800, 'year')]:
    if key in existing:
        prices[interval] = existing[key]['id']
        print(f'复用价格 {interval}', prices[interval])
    else:
        p = api('POST', '/prices', {'product': product_id, 'unit_amount': amount, 'currency': 'usd',
                                    'recurring[interval]': interval, 'lookup_key': key, 'nickname': f'Pro {interval}'})
        prices[interval] = p['id']
        print(f'创建价格 {interval}', p['id'], f'${amount / 100:g}')

# ---- 客户门户配置（按 metadata 复用）----
conf = next((c for c in api('GET', '/billing_portal/configurations', {'limit': 100})['data']
             if c.get('metadata', {}).get('app') == 'glimmer' and c['active']), None)
if conf:
    print('复用客户门户配置', conf['id'])
else:
    conf = api('POST', '/billing_portal/configurations', [
        ('business_profile[headline]', '微光翻译 Pro：管理你的订阅'),
        ('features[subscription_cancel][enabled]', 'true'),
        ('features[subscription_cancel][mode]', 'at_period_end'),
        ('features[payment_method_update][enabled]', 'true'),
        ('features[invoice_history][enabled]', 'true'),
        ('features[subscription_update][enabled]', 'true'),
        ('features[subscription_update][default_allowed_updates][]', 'price'),
        ('features[subscription_update][products][0][product]', product_id),
        ('features[subscription_update][products][0][prices][]', prices['month']),
        ('features[subscription_update][products][0][prices][]', prices['year']),
        ('metadata[app]', 'glimmer'),
    ])
    print('创建客户门户配置', conf['id'])

# ---- 写入 .env ----
updates = {'STRIPE_PRICE_MONTHLY': prices['month'], 'STRIPE_PRICE_YEARLY': prices['year'], 'STRIPE_PORTAL_CONFIGURATION': conf['id']}
lines = open(ENV, encoding='utf-8').read().splitlines()
lines = [f'{l.split("=", 1)[0]}={updates[l.split("=", 1)[0]]}' if l.split('=', 1)[0] in updates else l for l in lines]
open(ENV, 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
print('已写入 .env：', ', '.join(updates))
