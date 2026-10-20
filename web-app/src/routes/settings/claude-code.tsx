import { createFileRoute, redirect } from '@tanstack/react-router'
import { route } from '@/constants/routes'

/** Claude Code is a tab of Integrations now; this keeps old links, bookmarks
 * and saved routes working. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.claude_code as any)({
  beforeLoad: () => {
    throw redirect({
      to: route.settings.integrations,
      search: { tab: 'claude-code' },
    })
  },
})
