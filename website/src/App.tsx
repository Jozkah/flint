import { useEffect } from 'react'
import { Nav } from './components/Nav'
import { Hero } from './components/Hero'
import { Approvals, CoworkStory, Manifesto, Provenance, Trust, Ways, WhatChanged } from './components/Product'
import { Bento, Features, LocalFirst, Models, OpenSource, Rooms } from './components/Platform'
import { Gallery } from './components/Gallery'
import { Download, FinalCta, Footer } from './components/Finish'
import { startEffects } from './lib/effects'

export default function App() {
  useEffect(() => startEffects(), [])
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Nav />
      <main id="main">
        <Hero />
        <Trust />
        <Manifesto />
        <Ways />
        <CoworkStory />
        <Approvals />
        <WhatChanged />
        <Provenance />
        <Models />
        <Rooms />
        <Features />
        <Bento />
        <LocalFirst />
        <OpenSource />
        <Gallery />
        <Download />
        <FinalCta />
      </main>
      <Footer />
    </>
  )
}
