
import { createFileRoute } from '@tanstack/react-router'
import { desktopOnlyRoute } from '@/lib/desktopOnlyRoute'
import { route } from '@/constants/routes'
import { StudioPage } from '@/containers/studio/StudioPage'

export const Route = createFileRoute(route.studio)({
  component: desktopOnlyRoute(StudioPage, 'common:shell.studio'),
})
