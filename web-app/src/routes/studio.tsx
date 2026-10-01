/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { StudioPage } from '@/containers/studio/StudioPage'

export const Route = createFileRoute(route.studio as any)({
  component: StudioPage,
})
