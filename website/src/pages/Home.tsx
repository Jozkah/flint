import { Hero } from '../components/Hero'
import { Approvals, CoworkStory, Manifesto, Provenance, Trust, Ways, WhatChanged } from '../components/Product'
import { Bento, Features, LocalFirst, Models, OpenSource, Rooms } from '../components/Platform'
import { Gallery } from '../components/Gallery'
import { Download, FinalCta } from '../components/Finish'

export function Home() {
  return (
    <>
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
    </>
  )
}
