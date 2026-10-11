// Lays out the phone client as the iOS shell's frontend.
//
// The client is built for the desktop's listener, where it lives under `/m/`
// (`web-app/vite.mobile.config.ts`, output `src-tauri/resources/mobile`). The
// shell serves it from the app bundle instead: `index.html` at the root, and
// everything the page references under `/m/`, so asset URLs resolve unchanged.
// The page's CSP also has to allow the shell's loopback proxy.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'src-tauri', 'resources', 'mobile')
const out = join(root, 'web-app', 'dist-ios')

if (!existsSync(join(src, 'index.html'))) {
  console.error(`build-ios-shell: ${src} has no index.html; run \`yarn build:mobile\` first`)
  process.exit(1)
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
cpSync(src, join(out, 'm'), { recursive: true })

const CONNECT = "connect-src 'self' ws: wss:"
let html = readFileSync(join(src, 'index.html'), 'utf8')
if (!html.includes(CONNECT)) {
  console.error('build-ios-shell: the page CSP changed; update CONNECT in this script')
  process.exit(1)
}
html = html.replace(CONNECT, `${CONNECT} http://127.0.0.1:*`)
// Visible until React renders: a blank screen cannot tell "page did not load"
// from "script threw", this can.
html = html.replace(
  '<div id="root"></div>',
  '<div id="root"><p id="boot" style="font:16px -apple-system,sans-serif;text-align:center;margin-top:30vh;color:#888">Starting Flint…</p></div>'
)
writeFileSync(join(out, 'index.html'), html)
console.log(`build-ios-shell: wrote ${out}`)
