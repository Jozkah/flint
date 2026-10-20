import { createFileRoute, redirect } from '@tanstack/react-router'
import { route } from '@/constants/routes'

/** The page moved; this keeps old links, bookmarks and saved routes working. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.interface as any)({
  beforeLoad: ({ search }) => {
    throw redirect({ to: route.settings.appearance, search })
  },
})
