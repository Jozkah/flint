import { createFileRoute, redirect } from '@tanstack/react-router'
import { route } from '@/constants/routes'

/** Extensions is a tab of Integrations now; this keeps old links, bookmarks
 * and saved routes working. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.extensions as any)({
  beforeLoad: () => {
    throw redirect({
      to: route.settings.integrations,
      search: { tab: 'extensions' },
    })
  },
})
