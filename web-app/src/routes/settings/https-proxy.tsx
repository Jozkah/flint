import { createFileRoute, redirect } from '@tanstack/react-router'
import { route } from '@/constants/routes'

/** The page moved; this keeps old links, bookmarks and saved routes working. */

export const Route = createFileRoute(route.settings.https_proxy)({
  beforeLoad: ({ search }) => {
    throw redirect({ to: route.settings.network_proxy, search })
  },
})
