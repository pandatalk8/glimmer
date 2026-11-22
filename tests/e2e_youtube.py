"""YouTube 真实字幕测试（有界面运行，需联网）。

用法：python3 tests/e2e_youtube.py [视频地址]
会打开一个浏览器窗口播放视频并开启字幕，检查双语字幕是否出现。
"""
import asyncio, os, sys, tempfile
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT = os.path.join(ROOT, 'tests', 'output')
URL = next((a for a in sys.argv[1:] if a.startswith('http')), 'https://www.youtube.com/watch?v=arj7oStGLkU')


async def main():
    os.makedirs(OUTPUT, exist_ok=True)
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            tempfile.mkdtemp(prefix='glimmer-yt-'), channel='chromium', headless=False,
            args=[f'--disable-extensions-except={ROOT}', f'--load-extension={ROOT}', '--autoplay-policy=no-user-gesture-required'],
            viewport={'width': 1280, 'height': 800}, locale='en-US')
        await asyncio.sleep(1.5)
        for pg in ctx.pages[1:]:
            await pg.close()
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        captured = []
        page.on('response', lambda r: captured.append((r.status, r.headers.get('content-length'), 'lang=' in r.url))
                if '/api/timedtext' in r.url else None)
        await page.goto(URL, wait_until='domcontentloaded', timeout=60000)
        await page.wait_for_timeout(5000)
        for sel in ['button[aria-label*="Accept all"]', 'button[aria-label*="Reject all"]']:
            if await page.locator(sel).count():
                await page.locator(sel).first.click()
                await page.wait_for_timeout(3000)
                break
        await page.evaluate("document.querySelector('video')?.play()")
        await page.wait_for_timeout(3000)
        btn = page.locator('.ytp-subtitles-button')
        if await btn.count():
            await page.locator('#movie_player').hover()
            if await btn.first.get_attribute('aria-pressed') != 'true':
                await btn.first.click()
            else:  # 关闭再打开，强制播放器重新请求字幕
                await btn.first.click()
                await page.wait_for_timeout(800)
                await btn.first.click()

        sub = None
        for _ in range(40):
            sub = await page.evaluate("""()=>document.querySelector('#movie_player glimmer-ui')?.shadowRoot?.querySelector('.yt-sub')?.innerText""")
            if sub and '\n' in sub and '…' not in sub:
                break
            await page.wait_for_timeout(500)
        native_hidden = await page.evaluate("!!document.getElementById('glimmer-yt-style')")
        await page.locator('#movie_player').hover()
        await page.screenshot(path=f'{OUTPUT}/youtube.png')

        print('字幕请求（状态, 长度, 是否带语言参数）：', captured)
        ok = bool(sub) and '\n' in sub
        print(('PASS' if ok else 'FAIL') + '  出现双语字幕：', repr(sub))
        print(('PASS' if native_hidden else 'FAIL') + '  原生字幕已隐藏')

        # 在面板中关闭“双语字幕”再打开：字幕要能恢复（YouTube 不会重新请求同一条字幕）
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        SET_YT = """async(on)=>{const {settings}=await chrome.storage.local.get('settings');
          await chrome.storage.local.set({settings:{...(settings||{}),youtube:{...(settings?.youtube||{}),enabled:on}}})}"""
        await sw.evaluate(SET_YT, False)
        await page.wait_for_timeout(1500)
        off = await page.evaluate("""()=>document.querySelector('#movie_player glimmer-ui')?.shadowRoot?.querySelector('.yt-sub')?.innerText||''""")
        native_back = not await page.evaluate("!!document.getElementById('glimmer-yt-style')")
        await sw.evaluate(SET_YT, True)
        again = ''
        for _ in range(30):
            again = await page.evaluate("""()=>document.querySelector('#movie_player glimmer-ui')?.shadowRoot?.querySelector('.yt-sub')?.innerText||''""")
            if again and '\n' in again and '…' not in again:
                break
            await page.wait_for_timeout(500)
        ok2 = off == '' and native_back
        ok3 = bool(again) and '\n' in again
        print(('PASS' if ok2 else 'FAIL') + '  关闭双语字幕：我们的字幕消失、原生字幕恢复', repr(off))
        print(('PASS' if ok3 else 'FAIL') + '  再次开启：双语字幕恢复', repr(again))
        await ctx.close()
        sys.exit(0 if ok and native_hidden and ok2 and ok3 else 1)


asyncio.run(main())
