import { AppWindow } from '../components/AppWindow'
import { Pillars } from '../components/Pillars'
import { Gallery } from '../components/Gallery'
import { Download } from '../components/Finish'

export function Home() {
  return (
    <>
      <AppWindow />
      <Pillars />
      <Gallery />
      <Download />
    </>
  )
}
