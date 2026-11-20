"""在本地 Supabase 中预置 review 用的测试账号（已验证邮箱，可直接登录）。

用法（本地 Supabase 已启动）：python3 scripts/seed_review_accounts.py
只操作本机后端（127.0.0.1），可重复执行：已存在的账号会重置密码、等级与示例数据。
"""
import json, subprocess, sys, time, urllib.request

st = json.loads(subprocess.run(['npx', '-y', 'supabase@3.2.0', 'status', '-o', 'json'], capture_output=True, text=True,
                               stdin=subprocess.DEVNULL).stdout or '{}')
API = st.get('API_URL', '')
KEY = st.get('SECRET_KEY') or st.get('SERVICE_ROLE_KEY')
if not API.startswith('http://127.0.0.1') or not KEY:
    sys.exit('本地 Supabase 没有运行：先执行 npx supabase start')

PASSWORD = 'review123'
ACCOUNTS = [
    ('free@review.local', 'free', None),
    ('premium@review.local', 'premium', None),
    ('plus@review.local', 'premium_plus', 1_234_567),  # 本月已用 Token，用于查看用量卡片
]
WORDS = [('serendipity', '意外发现'), ('ubiquitous', '无处不在的'), ('resilient', '有韧性的')]


def call(method, path, body=None, prefer=None):
    h = {'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'}
    if prefer:
        h['Prefer'] = prefer
    req = urllib.request.Request(API + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read() or b'null')
    except urllib.error.HTTPError as e:
        sys.exit(f'{method} {path} 失败：{e.code} {e.read().decode()[:200]}')


users = {u['email']: u['id'] for u in call('GET', '/auth/v1/admin/users?per_page=1000')['users']}
month = time.strftime('%Y-%m', time.gmtime())
now = int(time.time() * 1000)
print(f'本地后端：{API}\n')
for email, plan, tokens in ACCOUNTS:
    if email in users:
        uid = users[email]
        call('PUT', f'/auth/v1/admin/users/{uid}', {'password': PASSWORD, 'email_confirm': True})
    else:
        uid = call('POST', '/auth/v1/admin/users', {'email': email, 'password': PASSWORD, 'email_confirm': True})['id']
    member = plan != 'free'
    call('PATCH', f'/rest/v1/profiles?id=eq.{uid}', {
        'plan': plan,
        'subscription_status': 'active' if member else None,
        'current_period_end': time.strftime('%Y-%m-%dT00:00:00Z', time.gmtime(time.time() + 365 * 86400)) if member else None,
        'cancel_at_period_end': False,
    })
    call('DELETE', f'/rest/v1/usage_monthly?user_id=eq.{uid}')
    if tokens:
        call('POST', '/rest/v1/usage_monthly', {'user_id': uid, 'month': month, 'tokens': tokens, 'chars': 0, 'requests': 42})
    call('DELETE', f'/rest/v1/words?user_id=eq.{uid}')
    if member:  # 会员的云端生词本：登录后会同步到插件
        call('POST', '/rest/v1/words', [{'user_id': uid, 'key': w, 'w': w, 't': t, 'url': 'https://example.com',
                                         'ts': now, 'm': False, 'deleted': False, 'updated_at': now} for w, t in WORDS])
    print(f'  {email:24} 密码 {PASSWORD}  {plan}' + (f'，本月已用 {tokens:,} Token' if tokens else '') + ('，云端生词 3 个' if member else ''))
print('\n注意：这些会员是直接写入数据库的，没有 Stripe 订阅，“管理订阅”会提示找不到订阅；要测试真实付款，请用 free 账号在方案页用测试卡开通。')
