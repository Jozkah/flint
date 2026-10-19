/**
 * Development-only answers for the shared-folder commands, so the bar, the
 * strip item, the sidebar mark and the hover card can be looked at in a plain
 * browser (`?preview`, see previewSeed.ts). The seed's sessions `dash` and
 * `review` share one folder; `?shared=hold|branch|waiting|alone` picks which
 * state the bar shows (default: a calm "others are working here"). Writes stay
 * in memory.
 */
import type {
  SharedAllowScope,
  SharedFolderGroup,
  SharedFolderView,
  SharedPeer,
} from '@/lib/sharedFolder'

const MIN = 60_000
const FOLDER = 'c:/projects/acme-weather'

const state = { allow: new Map<string, { scope: SharedAllowScope; until: number }>() }

const mode = () =>
  new URLSearchParams(window.location.search).get('shared') ?? 'calm'

const peer = (
  sessionId: string,
  displayName: string,
  extra: Partial<SharedPeer> = {}
): SharedPeer => ({
  sessionId,
  displayName,
  status: 'idle',
  waitingApproval: false,
  access: 'direct',
  isolated: false,
  branch: 'feat/tooltip',
  startBranch: 'feat/tooltip',
  startHead: 'a1b2c3d',
  lastActivity: Date.now() - 2 * MIN,
  recentFiles: [],
  claims: [],
  ...extra,
})

function peers(): Record<string, SharedPeer> {
  const m = mode()
  return {
    dash: peer('dash', 'Hourly chart tooltip', {
      status: 'running',
      recentFiles: [
        'web/src/charts/tooltip.ts',
        'web/src/charts/legend.ts',
        'web/src/charts/axis.ts',
        'web/src/units.ts',
        'web/src/format.ts',
        'docs/units.md',
        'web/src/charts/index.ts',
      ].map((path, i) => ({ path, at: Date.now() - (i + 1) * MIN })),
      claims: m === 'hold' ? ['web/src/charts/tooltip.ts'] : [],
    }),
    review: peer('review', 'Feels-like temperature in the tooltip', {
      status: 'running',
      waitingApproval: m === 'waiting',
            recentFiles: [
        { path: 'web/src/charts/tooltip.ts', at: Date.now() - MIN },
      ],
    }),
  }
}

function viewFor(sessionId: string): SharedFolderView | null {
  const all = peers()
  const you = all[sessionId]
  if (!you || mode() === 'alone') return null
  const others = Object.values(all).filter((p) => p.sessionId !== sessionId)
  const m = mode()
  if (m === 'branch') you.startBranch = 'main'
  const now = Date.now()
  const allowance = state.allow.get(sessionId)
  return {
    folderKey: FOLDER,
    folder: 'C:\\Projects\\acme-weather',
    git: true,
    branch: 'feat/tooltip',
    you,
    others: others.concat(
      m === 'calm'
        ? [
            peer('docs', 'Write the units guide', {
              isolated: true,
              branch: null,
              status: 'idle',
              recentFiles: [],
            }),
          ]
        : []
    ),
    holds:
      m === 'hold' && !(allowance && allowance.until > now)
        ? [
            {
              kind: 'edit',
              target: 'web/src/charts/tooltip.ts',
              ownerId: others[0].sessionId,
              ownerName: others[0].displayName,
              at: now - MIN,
            },
          ]
        : [],
    allowances:
      allowance && allowance.until > now
        ? [{ scope: allowance.scope, until: allowance.until }]
        : [],
  }
}

/** The shared-folder command answers; `undefined` passes the command through. */
export function sharedFolderPreview(
  command: string,
  args?: Record<string, unknown>
): Promise<unknown> | undefined {
  const name = command.replace('plugin:agent-tools|', '')
  switch (name) {
    case 'shared_folder_peers':
      return Promise.resolve(viewFor(String(args?.sessionId)))
    case 'shared_folder_overview': {
      if (mode() === 'alone') return Promise.resolve([])
      const group: SharedFolderGroup = {
        folderKey: FOLDER,
        folder: 'C:\\Projects\\acme-weather',
        git: true,
        sessions: Object.values(peers()),
      }
      return Promise.resolve([group])
    }
    case 'shared_folder_allow': {
      const sessionId = String(args?.sessionId)
      const minutes = Number(args?.minutes ?? 30)
      if (minutes === 0) {
        state.allow.delete(sessionId)
        return Promise.resolve(null)
      }
      const until = Date.now() + minutes * MIN
      state.allow.set(sessionId, { scope: args?.scope as SharedAllowScope, until })
      return Promise.resolve(until)
    }
    case 'shared_folder_recent_edits':
      return Promise.resolve([])
    case 'shared_folder_default_isolation':
      return Promise.resolve({
        isolate: false,
        reason: args?.userChoseShared ? 'userChoseShared' : 'alone',
      })
    default:
      return undefined
  }
}
