import { createRootRoute } from '@tanstack/react-router'
import { lazy, Suspense } from 'react'
import GlobalError from '@/containers/GlobalError'
import { isChatWindow } from '@/lib/soloFlag'

// Each window loads only its own root. The main window's shell (sidebar,
// header, search, dialogs, shortcuts) is a chunk of its own, so a "New window"
// never downloads or parses it; it loads components/solo instead.
const MainRoot = lazy(() => import('@/shell/MainRoot'))
const SoloRoot = lazy(() => import('@/components/solo/SoloRoot'))

function RootLayout() {
  return (
    <Suspense fallback={null}>
      {isChatWindow() ? <SoloRoot /> : <MainRoot />}
    </Suspense>
  )
}

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: ({ error }) => <GlobalError error={error} />,
})
