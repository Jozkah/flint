# Flint website

The marketing site for Flint. It lives apart from the desktop app: its own `package.json` and lockfile, not part of the Yarn workspaces, and nothing in the app build depends on it.

Stack: Vite, React 19, TypeScript, Tailwind CSS 4. The production build is prerendered to static HTML and then hydrated.

## Commands

Run these from `website/` (use `npm`, not `yarn`).

```bash
npm install
npm run dev        # http://localhost:5173/flint/
npm run build      # typecheck, bundle, prerender into dist/
npm test           # checks the built site (run after build)
npm run preview    # serve dist/ at http://localhost:4173/flint/
```

`dev` and `build` first run `scripts/assets.mjs` and `scripts/release.mjs`.

## Pages

Each page is a React component registered in `src/pages/registry.tsx` (path, title, description). The build prerenders every entry to `dist/<path>/index.html`, plus `404.html`, `robots.txt` and a sitemap; the client hydrates only when the markup is for the current page.

- Home, `/docs/`, `/install/`, `/faq/`, `/changelog/` (built from the repository's `CHANGELOG.md`), `/brand/`.
- Legal and policy pages live in `src/pages/legal.tsx`: `/privacy/`, `/terms/`, `/license/`, `/security-policy/` (mirrors `SECURITY.md`) and `/accessibility/`. Their wording was drafted from what the repository's code, README and feature list say. Have the project owner review it, and update `UPDATED` in that file whenever it changes.
- `npm test` fails if a page lacks a unique title, description or canonical URL, if a legal page stops matching `LICENSE`, `NOTICE` or `SECURITY.md`, or if any page links to something missing.

## Where things come from

- **Product screenshots** are the real captures in [`docs/screenshots`](../docs/screenshots). `scripts/assets.mjs` derives AVIF and WebP widths from them into `public/shots` (git-ignored). The page only frames and crops them; no pixel is redrawn. Crops are CSS regions of the same image (`Shot` with `region`).
- **The Flint mark** is [`src-tauri/icons/icon.png`](../src-tauri/icons/icon.png), trimmed of transparent margin and resized into `public/brand` (also the favicon). `npm test` fails if the derivative is not a plain resize of the source.
- **Tokens and type**: colours are the dark tokens from `web-app/src/styles/tokens.css`; Inter is subset from `web-app/public/fonts/inter` by `scripts/make-fonts.py` (output is committed in `public/fonts`).
- **Downloads** are resolved at build time from the latest GitHub release (`scripts/release.mjs`), so no version or file name is hardcoded. If the lookup fails the buttons fall back to `/releases/latest`. The browser never calls GitHub. The visitor's OS is read from the browser's own platform string to pick the tab.
- **`public/og.png`** is rendered once from `scripts/og.html` with headless Chrome and committed:
  `chrome --headless=new --window-size=1200,630 --screenshot=public/og.png file:///…/website/scripts/og.html`

Refreshing screenshots: run the web app with `yarn dev:web` and open a page with `?preview` (invented "acme-weather" data), capture at 1600x1000 with a device scale factor of 2, and replace the files in `docs/screenshots`.

## Hosting

GitHub Pages at `https://jozkah.github.io/flint/`, deployed by `.github/workflows/website.yml` (push to `main` touching the site, its screenshots or the icon, plus published releases). For a custom domain set `SITE_BASE=/` and `SITE_URL=https://example.com/` in that workflow and add `website/public/CNAME`.
