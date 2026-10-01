import { useEffect } from 'react'
import { Nav } from './components/Nav'
import { Footer } from './components/Finish'
import { startEffects } from './lib/effects'
import { findPage, NOT_FOUND } from './pages/registry'

export default function App({ path }: { path: string }) {
  const page = findPage(path) ?? NOT_FOUND
  const home = page.path === ''
  useEffect(() => startEffects(), [path])
  const Page = page.Component
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Nav home={home} current={page.path} />
      <main id="main">
        <Page />
      </main>
      <Footer home={home} />
    </>
  )
}
