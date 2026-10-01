import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// GitHub Pages serves this repo at /flint/. A custom domain only needs SITE_BASE=/ and SITE_URL=https://example.com/.
const base = process.env.SITE_BASE ?? '/flint/'
const siteUrl = (process.env.SITE_URL ?? 'https://jozkah.github.io/flint/').replace(/\/?$/, '/')

const htmlVars = (): Plugin => ({
  name: 'flint-html-vars',
  transformIndexHtml: (html) => html.replaceAll('%SITE_URL%', siteUrl),
})

export default defineConfig({
  base,
  plugins: [react(), tailwindcss(), htmlVars()],
  define: { __SITE_URL__: JSON.stringify(siteUrl) },
  build: { target: 'es2022', cssCodeSplit: false, assetsInlineLimit: 0 },
})
