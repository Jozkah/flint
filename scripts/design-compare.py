"""Capture the app and the design mockup side by side for visual comparison.

Usage:
  python compare.py --port 5391 --out C:/tmp/cmp/chat --theme dark \
      --pair "/threads/release" "chat-release" [--pair APP MOCKHASH ...] \
      [--app-click "css selector"] [--mock-click "css selector"] [--width 1600 --height 900]

The dev server must serve web-app with public/_mock.html (a copy of
C:/tmp/kravio/site/index.html). App pages are opened with ?preview so the
dev-only seed (web-app/src/dev/previewSeed.ts) fills them with the same
example content as the mockup. Writes <out>/<n>-app.png, <n>-mock.png and a
side-by-side <n>-both.png.
"""
import argparse
import os
import time

from PIL import Image
from playwright.sync_api import sync_playwright

p = argparse.ArgumentParser()
p.add_argument('--port', type=int, default=5391)
p.add_argument('--out', required=True)
p.add_argument('--theme', default='dark', choices=['dark', 'light'])
p.add_argument('--pair', nargs=2, action='append', metavar=('APP', 'MOCK'), required=True)
p.add_argument('--app-click', action='append', default=[])
p.add_argument('--mock-click', action='append', default=[])
p.add_argument('--width', type=int, default=1600)
p.add_argument('--height', type=int, default=900)
p.add_argument('--wait', type=float, default=1.2)
a = p.parse_args()
os.makedirs(a.out, exist_ok=True)
base = f'http://localhost:{a.port}'

MOUNT_JS = """async (theme) => {
  const root = () => document.getElementById('root');
  for (let i = 0; i < 20 && !root().innerHTML.length; i++) await new Promise(r => setTimeout(r, 500));
  if (!root().innerHTML.length) { await import('/src/main.tsx?t=' + Date.now()); }
  for (let i = 0; i < 40 && !root().innerHTML.length; i++) await new Promise(r => setTimeout(r, 250));
  await new Promise(r => setTimeout(r, 4500));
  document.getElementById('initial-loader')?.remove();
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.classList.remove('preload');
  return root().innerHTML.length;
}"""

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={'width': a.width, 'height': a.height})
    for i, (app, mock) in enumerate(a.pair, 1):
        page = ctx.new_page()
        app = '/' + app.lstrip('/')
        sep = '&' if '?' in app else '?'
        page.goto(f'{base}{app}{sep}preview', wait_until='domcontentloaded')
        n = page.evaluate(MOUNT_JS, a.theme)
        for sel in a.app_click:
            try:
                page.click(sel, timeout=3000)
            except Exception as e:  # noqa: BLE001
                print('app click failed', sel, e)
        time.sleep(a.wait)
        page.screenshot(path=f'{a.out}/{i}-app.png')
        page.close()

        page = ctx.new_page()
        page.goto(f'{base}/_mock.html', wait_until='domcontentloaded')
        page.evaluate(f"""() => {{ localStorage.setItem('flint-theme', '{a.theme}'); }}""")
        page.goto(f'{base}/_mock.html#{mock}', wait_until='load')
        page.reload(wait_until='load')
        time.sleep(1.5)
        for sel in a.mock_click:
            try:
                page.click(sel, timeout=3000)
            except Exception as e:  # noqa: BLE001
                print('mock click failed', sel, e)
        time.sleep(a.wait)
        page.screenshot(path=f'{a.out}/{i}-mock.png')
        page.close()

        l = Image.open(f'{a.out}/{i}-app.png')
        r = Image.open(f'{a.out}/{i}-mock.png')
        both = Image.new('RGB', (l.width + r.width + 12, max(l.height, r.height)), (255, 0, 255))
        both.paste(l, (0, 0))
        both.paste(r, (l.width + 12, 0))
        both.save(f'{a.out}/{i}-both.png')
        print(f'{i}: app mounted={n} -> {a.out}/{i}-both.png (left app, right mockup)')
    browser.close()
