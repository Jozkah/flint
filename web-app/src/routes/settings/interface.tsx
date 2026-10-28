import { createFileRoute, redirect } from '@tanstack/react-router'
import { route } from '@/constants/routes'

/** The page moved; this keeps old links, bookmarks and saved routes working. */

export const Route = createFileRoute(route.settings.interface)({
  beforeLoad: ({ search }) => {
    throw redirect({ to: route.settings.appearance, search })
  },
})
