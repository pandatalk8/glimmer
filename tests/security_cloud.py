"""安全检查（docs/test-cases.md 第十一节 H-01 ~ H-06）：对云端 Supabase（glimmer）直接调接口，确认普通用户无法越权。

- 用云端管理接口临时创建一个已验证的免费账号，用它的登录令牌模拟“普通用户自己发请求”，结束后删除
- H-06 检查插件会发布的文件（manifest 引用的目录与打包 zip）里没有任何服务端密钥：
  既按格式搜索（sk_test_ / sk_live_ / whsec_ / sb_secret_ / sk- / GOCSPX- 等），也逐个比对 supabase/functions/.env 中的真实密钥值（不打印）

前提：已登录 Supabase CLI（npx supabase login）。
用法：python3 tests/security_cloud.py
"""
import json, os, re, secrets, subprocess, sys, time, urllib.error, urllib.request, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def _linked_ref():
    """要测试的云端项目：环境变量 GLIMMER_SUPABASE_REF，否则用 `supabase link` 记下的项目（supabase/.temp/project-ref，已被 git 忽略）"""
    ref = os.environ.get('GLIMMER_SUPABASE_REF', '').strip()
    path = os.path.join(ROOT, 'supabase', '.temp', 'project-ref')
    if not ref and os.path.exists(path):
        ref = open(path, encoding='utf-8').read().strip()
    if not ref:
        sys.exit('不知道要测试哪个云端项目：先执行 npx supabase link，或设置环境变量 GLIMMER_SUPABASE_REF')
    return ref


REF = _linked_ref()
API = f'https://{REF}.supabase.co'
results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('  PASS  ' if ok else '  FAIL  ') + name + (f'  ({detail})' if detail != '' else ''))


def publishable_key():
    src = open(os.path.join(ROOT, 'src/shared/config.js'), encoding='utf-8').read()
    return re.search(r"BACKEND = \{\s*supabaseUrl: '[^']+',\s*supabaseAnonKey: '([^']+)'", src).group(1)


def cloud_secret():
    for extra in ([], ['--reveal']):
        out = subprocess.run(['npx', '-y', 'supabase@3.2.0', 'projects', 'api-keys', '--project-ref', REF, '-o', 'json', *extra],
                             cwd=ROOT, capture_output=True, text=True).stdout
        try:
            keys = json.loads(out)
        except Exception:
            continue
        for k in keys:
            v = k.get('api_key') or ''
            if k.get('type') == 'secret' and re.fullmatch(r'[A-Za-z0-9_.\-]{30,}', v):
                return v
    sys.exit('取不到云端服务端密钥：先执行 npx supabase login')


PUB, SECRET = publishable_key(), cloud_secret()


def req(method, path, body=None, headers=None):
    """返回 (状态码, 响应文本)，不因 4xx 抛错；网络不稳时重试"""
    data = json.dumps(body).encode() if body is not None else None
    for attempt in range(4):
        r = urllib.request.Request(API + path, data=data, method=method, headers={'Content-Type': 'application/json', **(headers or {})})
        try:
            with urllib.request.urlopen(r, timeout=30) as resp:
                return resp.status, resp.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()
        except Exception:
            time.sleep(2 * (attempt + 1))
    raise RuntimeError('网络持续失败')


admin = lambda m, p, b=None, extra=None: req(m, p, b, {'apikey': SECRET, **(extra or {})})


def main():
    email, pw = f'glimmer-sec-{secrets.token_hex(4)}@example.com', secrets.token_urlsafe(12)
    code, txt = admin('POST', '/auth/v1/admin/users', {'email': email, 'password': pw, 'email_confirm': True})
    uid = json.loads(txt)['id']
    print(f'创建了临时免费账号 {email}')
    try:
        code, txt = req('POST', '/auth/v1/token?grant_type=password', {'email': email, 'password': pw}, {'apikey': PUB})
        token = json.loads(txt)['access_token']
        user = {'apikey': PUB, 'Authorization': 'Bearer ' + token}
        plan = lambda: json.loads(req('GET', f'/rest/v1/profiles?id=eq.{uid}&select=plan', None, user)[1])[0]['plan']

        print('[安全检查] 普通用户越权')
        c1, t1 = req('PATCH', f'/rest/v1/profiles?id=eq.{uid}', {'plan': 'premium_plus'}, {**user, 'Prefer': 'return=minimal'})
        p = plan()
        check('H-01 免费用户用自己的令牌把 plan 改成 premium_plus：读回仍是 free', p == 'free', f'PATCH 返回 {c1}，读回 {p}')

        now = int(time.time() * 1000)
        c2, t2 = req('POST', '/rest/v1/words', {'user_id': uid, 'key': 'hack', 'w': 'hack', 'ts': now, 'updated_at': now}, user)
        check('H-02 免费用户写云端生词：403，violates row-level security policy',
              c2 == 403 and 'row-level security' in t2, f'{c2} {t2[:70]}')

        c3, t3 = req('POST', '/rest/v1/usage_monthly', {'user_id': uid, 'month': time.strftime('%Y-%m', time.gmtime()), 'tokens': 0}, user)
        check('H-03 用户写自己的用量 usage_monthly：403', c3 == 403, f'{c3} {t3[:70]}')
        c3b, t3b = req('PATCH', f'/rest/v1/usage_monthly?user_id=eq.{uid}', {'tokens': 0}, {**user, 'Prefer': 'return=representation'})
        check('H-03 改用量（PATCH）也不生效：没有任何行被修改', c3b in (200, 204, 403) and t3b.strip() in ('', '[]') or c3b == 403, f'{c3b} {t3b[:40]}')

        c4, t4 = req('POST', '/functions/v1/translate', {'texts': ['hello'], 'to': 'zh-CN', 'engine': 'deepseek'})
        c4b, t4b = req('POST', '/functions/v1/translate', {'texts': ['hello'], 'to': 'zh-CN', 'engine': 'deepseek'}, {'apikey': PUB})
        check('H-04 不带登录令牌调用翻译代理：401（不带任何头 / 只带公开 key 都被拒）',
              c4 == 401 and c4b == 401, f'{c4} {t4[:40]} / {c4b} {t4b[:40]}')
        c4c, t4c = req('POST', '/functions/v1/translate', {'texts': ['hello'], 'to': 'zh-CN', 'engine': 'deepseek'}, user)
        check('H-04 补充：登录的免费用户调用 DeepSeek 被等级校验拒绝', c4c in (402, 403) and '需要 Premium+ 会员' in t4c, f'{c4c} {t4c[:50]}')

        fake = {'id': 'evt_fake', 'type': 'customer.subscription.created',
                'data': {'object': {'id': 'sub_fake', 'customer': 'cus_fake', 'status': 'active', 'metadata': {'user_id': uid},
                                    'items': {'data': [{'price': {'id': 'price_fake'}}]}}}}
        c5, t5 = req('POST', '/functions/v1/stripe-webhook', fake)
        c5b, t5b = req('POST', '/functions/v1/stripe-webhook', fake, {'Stripe-Signature': f't={int(time.time())},v1=' + '0' * 64})
        p = plan()
        check('H-05 伪造支付通知：缺签名 400“缺少 Stripe-Signature”，伪造签名 400“签名无效”，会员状态不变',
              c5 == 400 and '缺少 Stripe-Signature' in t5 and c5b == 400 and '签名无效' in t5b and p == 'free', f'{c5} / {c5b} / plan={p}')
    finally:
        admin('DELETE', f'/auth/v1/admin/users/{uid}')
        print('已删除临时账号')

    print('\n[安全检查] 插件发布内容中没有服务端密钥')
    manifest = json.load(open(os.path.join(ROOT, 'manifest.json'), encoding='utf-8'))
    dirs = ['src', 'panel', 'options', 'premium', 'welcome', 'styles', 'icons']
    files = ['manifest.json'] + [os.path.join(d, f) for d in dirs if os.path.isdir(os.path.join(ROOT, d))
                                 for d, _, fs in os.walk(os.path.join(ROOT, d)) for f in fs]
    files = [f if os.path.isabs(f) else os.path.join(ROOT, f) for f in files]
    blobs = {os.path.relpath(f, ROOT): open(f, 'rb').read().decode('utf-8', 'ignore') for f in files if not f.endswith('.png')}
    dist = sorted((os.path.join(ROOT, 'dist', f) for f in os.listdir(os.path.join(ROOT, 'dist')) if f.endswith('.zip')), key=os.path.getmtime) \
        if os.path.isdir(os.path.join(ROOT, 'dist')) else []
    if dist:
        with zipfile.ZipFile(dist[-1]) as z:
            for n in z.namelist():
                if not n.endswith('.png'):
                    blobs['zip:' + n] = z.read(n).decode('utf-8', 'ignore')
    patterns = [r'sk_(test|live)_[A-Za-z0-9]{10,}', r'rk_(test|live)_[A-Za-z0-9]{10,}', r'whsec_[A-Za-z0-9]{10,}', r'sb_secret_[A-Za-z0-9_\-]{10,}',
                r'\bsk-[A-Za-z0-9_\-]{20,}', r'GOCSPX-[A-Za-z0-9_\-]{10,}', r'\bAIza[0-9A-Za-z_\-]{30,}', r'service_role']
    hits = [(n, p) for n, b in blobs.items() for p in patterns if re.search(p, b)]
    env = dict(l.split('=', 1) for l in open(os.path.join(ROOT, 'supabase/functions/.env'), encoding='utf-8').read().splitlines()
               if '=' in l and not l.startswith('#'))
    values = [v.strip() for k, v in env.items() if len(v.strip()) >= 16 and not k.startswith(('STRIPE_PRICE', 'PUBLIC_', 'SUPABASE_URL'))] + [SECRET]
    leaks = [n for n, b in blobs.items() for v in values if v in b]
    # service_role 一词只允许出现在提醒“不要填写 service_role key”的注释里
    hits = [(n, p) for n, p in hits if not (p == 'service_role' and all('service_role' not in l or l.strip().startswith('//') for l in blobs[n].splitlines()))]
    check(f'H-06 插件代码{"与打包 zip " if dist else ""}中找不到服务端密钥（{len(blobs)} 个文件；按格式搜索 + 逐个比对 {len(values)} 个真实密钥值）',
          not hits and not leaks, '；'.join([f'{n}:{p}' for n, p in hits] + [f'{n}:密钥值' for n in leaks])[:200])

    failed = [n for n, ok in results if not ok]
    print(f'\n结果：{len(results) - len(failed)}/{len(results)} 通过')
    if failed:
        print('失败项：' + '；'.join(failed))
    sys.exit(1 if failed else 0)


main()
