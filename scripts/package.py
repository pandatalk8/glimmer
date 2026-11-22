"""打包发布用的扩展 zip，并在打包后自检。

用法：python3 scripts/package.py [--skip-tests]
输出：dist/glimmer-v<manifest 版本>.zip

自检三步，任何一步失败都不会留下 zip：
1. 引用完整：manifest、各页面（html）、样式（css）、脚本（js）引用的文件都在包里
   （曾经漏掉 premium/、welcome/，方案页和欢迎页会直接打不开）
2. 没有密钥：包里不能有 .env 文件、服务端密钥（sk_ / whsec_ / sb_secret_ / service_role 等）
3. 能用：从解压出的目录加载插件，跑一遍核心回归 tests/e2e.py（--skip-tests 跳过）
"""
import fnmatch, json, os, re, shutil, subprocess, sys, tempfile, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 插件运行需要的全部文件；新增运行目录时加在这里
INCLUDE = ['manifest.json', 'build.json', 'src', 'panel', 'options', 'premium', 'welcome', 'styles', 'icons']
SKIP_NAMES = {'.DS_Store'}
SECRET = re.compile(r'sk_(live|test)_[A-Za-z0-9]{8}|whsec_[A-Za-z0-9]{8}|sb_secret_[A-Za-z0-9]|GOCSPX-|service_role"?\s*[:=]\s*["\']ey')


def fail(msg):
    sys.exit('打包失败：' + msg)


def collect():
    files = []
    for item in INCLUDE:
        p = os.path.join(ROOT, item)
        if not os.path.exists(p):
            fail(f'缺少 {item}' + ('（先运行 sh scripts/write_build_info.sh）' if item == 'build.json' else ''))
        if os.path.isfile(p):
            files.append(item)
            continue
        for d, _, names in os.walk(p):
            for n in names:
                if n in SKIP_NAMES:
                    continue
                files.append(os.path.relpath(os.path.join(d, n), ROOT))
    return sorted(files)


def check_refs(base, files):
    """检查包内所有引用都指向包里存在的文件"""
    have = set(files)
    missing = []

    def need(path, src):
        path = path.split('?')[0].split('#')[0]
        if not path or re.match(r'^(https?:|data:|chrome:|mailto:|about:|javascript:|//)', path):
            return
        if path not in have and not any(f.startswith(path.rstrip('/') + '/') for f in have):
            missing.append(f'{src} → {path}')

    m = json.load(open(os.path.join(base, 'manifest.json')))
    need(m['background']['service_worker'], 'manifest background')
    need(m['options_page'], 'manifest options_page')
    for cs in m.get('content_scripts', []):
        for f in cs.get('js', []) + cs.get('css', []):
            need(f, 'manifest content_scripts')
    for f in list(m.get('icons', {}).values()) + list(m.get('action', {}).get('default_icon', {}).values()):
        need(f, 'manifest icons')
    for w in m.get('web_accessible_resources', []):
        for pat in w['resources']:
            if not any(fnmatch.fnmatch(f, pat) for f in have):
                missing.append(f'manifest web_accessible_resources → {pat}（没有匹配的文件）')

    for f in files:
        full = os.path.join(base, f)
        d = os.path.dirname(f)
        rel = lambda r: os.path.normpath(os.path.join(d, r)) if not r.startswith('/') else r.lstrip('/')
        if f.endswith('.html'):
            text = open(full, encoding='utf-8').read()
            for r in re.findall(r'(?:src|href)="([^"]+)"', text):
                if not re.match(r'^(https?:|#|mailto:|data:)', r):
                    need(rel(r), f)
        elif f.endswith('.css'):
            for r in re.findall(r'url\(\s*["\']?([^"\')]+)', open(full, encoding='utf-8').read()):
                if not r.startswith('data:'):
                    need(rel(r), f)
        elif f.endswith('.js'):
            text = open(full, encoding='utf-8').read()
            for r in re.findall(r'(?:import\s[^\'"]*?from\s*|import\s*\(\s*|^import\s*)[\'"](\.{1,2}/[^\'"]+)[\'"]', text, re.M):
                need(rel(r), f)
            for r in re.findall(r'getURL\(\s*[\'"]([^\'"]+)[\'"]', text):
                need(r.lstrip('/'), f)
    if missing:
        fail('包里缺少被引用的文件：\n  ' + '\n  '.join(sorted(set(missing))))


def check_secrets(base, files):
    bad = [f for f in files if os.path.basename(f).startswith('.env')]
    for f in files:
        if f.endswith(('.js', '.json', '.html', '.css')) and SECRET.search(open(os.path.join(base, f), encoding='utf-8', errors='ignore').read()):
            bad.append(f)
    if bad:
        fail('包里疑似含有密钥：' + ', '.join(bad))


def main():
    version = json.load(open(os.path.join(ROOT, 'manifest.json')))['version']
    files = collect()
    os.makedirs(os.path.join(ROOT, 'dist'), exist_ok=True)
    out = os.path.join(ROOT, 'dist', f'glimmer-v{version}.zip')
    tmp_zip = out + '.tmp'
    with zipfile.ZipFile(tmp_zip, 'w', zipfile.ZIP_DEFLATED) as z:
        for f in files:
            z.write(os.path.join(ROOT, f), f)

    unpacked = tempfile.mkdtemp(prefix='glimmer-pkg-')
    try:
        with zipfile.ZipFile(tmp_zip) as z:
            z.extractall(unpacked)
        check_refs(unpacked, files)
        print(f'引用检查通过：{len(files)} 个文件')
        check_secrets(unpacked, files)
        print('密钥检查通过')
        if '--skip-tests' not in sys.argv:
            print('用打包后的插件运行核心回归……')
            r = subprocess.run([sys.executable, os.path.join(ROOT, 'tests', 'e2e.py')], env={**os.environ, 'GLIMMER_EXT_DIR': unpacked},
                               capture_output=True, text=True)
            tail = [l for l in r.stdout.splitlines() if 'FAIL' in l or '结果' in l]
            print('  ' + '\n  '.join(tail[-6:]))
            if r.returncode != 0:
                fail('打包后的插件没有通过核心回归')
    except SystemExit:
        os.remove(tmp_zip)
        raise
    finally:
        shutil.rmtree(unpacked, ignore_errors=True)
    os.replace(tmp_zip, out)
    print(f'\n已生成 {os.path.relpath(out, ROOT)}（{os.path.getsize(out) // 1024} KB），可上传到 Chrome 应用商店')


if __name__ == '__main__':
    main()
