// The phone app: a separate entry (mobile.html + src/mobile) that the desktop's
// remote-access server (src-tauri/src/core/remote) serves under `/m/`.
//
// Build:  yarn build:mobile   -> src-tauri/resources/mobile (bundled as a
//         Tauri resource; the server reads `resource_dir/resources/mobile`)
// Dev:    yarn dev:mobile     -> http://localhost:1430/m/ , proxying
//         /remote/v1 (HTTP and WebSocket) to a running Flint with Remote
//         access on. Point it elsewhere with FLINT_REMOTE_URL, e.g.
//         FLINT_REMOTE_URL=https://100.64.0.2:1340 yarn dev:mobile
//
// Nothing here may pull in Tauri: the page runs in a phone's browser.
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'fs'
import packageJson from './package.json'

const OUT_DIR = path.resolve(__dirname, '../src-tauri/resources/mobile')
const PUBLIC = path.resolve(__dirname, 'public')

/** Files of the desktop's `public/` the phone uses by URL: the mark and the
 * brand logos. Copied rather than pointing Vite's publicDir at `public/`,
 * which also holds several MB the phone never loads. (The Inter weights are
 * imported by mobile.css and bundled.) */
const SHARED_ASSETS = ['images/flint-mark.png', 'images/logos', 'images/model-provider']

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ')

function sharedAssets(): Plugin {
  return {
    name: 'flint-mobile-shared-assets',
    // Dev: serve them from public/ under the base.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0]
        if (!url.startsWith('/m/')) return next()
        const rel = decodeURIComponent(url.slice(3))
        if (!SHARED_ASSETS.some((a) => rel === a || rel.startsWith(`${a}/`))) return next()
        const file = path.join(PUBLIC, rel)
        if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) return next()
        res.setHeader('Content-Type', rel.endsWith('.svg') ? 'image/svg+xml' : 'image/png')
        fs.createReadStream(file).pipe(res)
      })
    },
    // Build only (dev needs React Refresh's inline preamble): scripts only
    // from this origin. The device token lives in this page's storage, so no
    // inline or third-party script may run beside it.
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (ctx.server) return html
        return html.replace(
          '<meta charset="UTF-8" />',
          `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`
        )
      },
    },
    // Build: copy them next to the bundle, and name the page index.html,
    // which is what the server looks for.
    closeBundle() {
      if (!fs.existsSync(OUT_DIR)) return
      const page = path.join(OUT_DIR, 'mobile.html')
      if (fs.existsSync(page)) fs.renameSync(page, path.join(OUT_DIR, 'index.html'))
      for (const rel of SHARED_ASSETS) {
        fs.cpSync(path.join(PUBLIC, rel), path.join(OUT_DIR, rel), { recursive: true })
      }
    },
  }
}

/** The desktop refuses requests whose Origin is not its own listener; the dev
 * server is a different origin, so the proxy drops the header. */
const target = process.env.FLINT_REMOTE_URL ?? 'http://127.0.0.1:1340'

export default defineConfig({
  root: __dirname,
  base: '/m/',
  publicDir: path.resolve(__dirname, 'mobile-public'),
  plugins: [react(), tailwindcss(), sharedAssets()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  define: {
    VERSION: JSON.stringify(packageJson.version),
  },
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    target: ['es2020', 'safari15'],
    rollupOptions: {
      input: path.resolve(__dirname, 'mobile.html'),
    },
  },
  server: {
    port: 1430,
    strictPort: true,
    host: process.env.TAURI_DEV_HOST || false,
    proxy: {
      '/remote/v1': {
        target,
        changeOrigin: true,
        ws: true,
        secure: false,
        configure: (proxy) => {
          proxy.on('proxyReq', (req) => req.removeHeader('origin'))
          proxy.on('proxyReqWs', (req) => req.removeHeader('origin'))
        },
      },
    },
  },
})
