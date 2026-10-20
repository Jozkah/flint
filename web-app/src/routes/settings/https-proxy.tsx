import { createFileRoute, redirect } from '@tanstack/react-router'
import { route } from '@/constants/routes'

/** The page moved; this keeps old links, bookmarks and saved routes working. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.https_proxy as any)({
  beforeLoad: ({ search }) => {
    throw redirect({ to: route.settings.network_proxy, search })
  },
})
