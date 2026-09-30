import { StrictMode } from 'react'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import './styles.css'
import App from './App'
import { FLAT, pathFromLocation } from './lib/site'
import { findPage, NOT_FOUND } from './pages/registry'

const el = document.getElementById('root')!
const path = forcedOrLocation()
const view = (p: string) => (
  <StrictMode>
    <App path={p} />
  </StrictMode>
)
function forcedOrLocation() {
  const forced = (window as unknown as { __FLINT_PAGE__?: string }).__FLINT_PAGE__
  return forced ?? pathFromLocation(window.location.pathname)
}
// The build is prerendered: hydrate only when the markup is for this very page (a static host's fallback may serve another page's HTML).
// `vite dev` has an empty root and renders from scratch.
const page = (findPage(path) ?? NOT_FOUND).path
const root: Root = el.hasChildNodes() && el.dataset.page === page ? hydrateRoot(el, view(path)) : (() => {
  const r = createRoot(el)
  r.render(view(path))
  return r
})()

if (FLAT) {
  ;(window as unknown as { __flintNavigate: (p: string, hash?: string) => boolean }).__flintNavigate = (p, hash) => {
    if (!findPage(p)) return false
    root.render(view(p))
    window.scrollTo(0, 0)
    if (hash) window.setTimeout(() => document.getElementById(hash)?.scrollIntoView(), 120)
    return true
  }
}
