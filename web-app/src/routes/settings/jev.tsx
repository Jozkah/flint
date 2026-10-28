import { createFileRoute, redirect } from '@tanstack/react-router'
import { route } from '@/constants/routes'

/** Jev is a tab of Integrations now; this keeps old links, bookmarks and
 * saved routes working. */
 
export const Route = createFileRoute(route.settings.jev)({
  beforeLoad: () => {
    throw redirect({ to: route.settings.integrations, search: { tab: 'jev' } })
  },
})
