import { createFileRoute, redirect } from '@tanstack/react-router'
import { route } from '@/constants/routes'

/** Extensions is a tab of Integrations now; this keeps old links, bookmarks
 * and saved routes working. */
 
export const Route = createFileRoute(route.settings.extensions)({
  beforeLoad: () => {
    throw redirect({
      to: route.settings.integrations,
      search: { tab: 'extensions' },
    })
  },
})
