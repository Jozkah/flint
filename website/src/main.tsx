import { StrictMode } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import './styles.css'
import App from './App'
import { pathFromLocation } from './lib/site'
import { findPage, NOT_FOUND } from './pages/registry'

const root = document.getElementById('root')!
const forced = (window as unknown as { __FLINT_PAGE__?: string }).__FLINT_PAGE__
const path = forced ?? pathFromLocation(window.location.pathname)
const app = (
  <StrictMode>
    <App path={path} />
  </StrictMode>
)
// The build is prerendered: hydrate only when the markup is for this very page (a static host's fallback may serve another page's HTML).
// `vite dev` has an empty root and renders from scratch.
const page = (findPage(path) ?? NOT_FOUND).path
if (root.hasChildNodes() && root.dataset.page === page) hydrateRoot(root, app)
else createRoot(root).render(app)
