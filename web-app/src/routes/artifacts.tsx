/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import {
  ChevronDown,
  Eye,
  FolderOpen,
  MessagesSquare,
  MoreHorizontal,
  Search,
  SquareArrowOutUpRight,
} from 'lucide-react'
import HeaderPage from '@/containers/HeaderPage'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { getServiceHub, useServiceHub } from '@/hooks/useServiceHub'
import { sessionWorkspacePath } from '@janhq/tauri-plugin-agent-tools-api'
import {
  ARTIFACT_GROUP_NAMES,
  ARTIFACT_ICON,
  artifactsFromTurns,
  type CoworkArtifact,
} from '@/lib/coworkArtifacts'
import { previewKindFor, resolveInRoot } from '@/lib/coworkPreview'

export const Route = createFileRoute(route.artifacts as any)({
  component: ArtifactsPage,
})

const PAGE = 24

type Row = CoworkArtifact & {
  sessionId: string
  sessionTitle: string
  /** The attached project folder, when the session has one. */
  folder: string | null
  updated: number
  root: string | null
}

/** The last path segment, for naming a project folder on a card. */
function folderName(folder: string): string {
  const parts = folder.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? folder
}

function formatUpdated(updated: number): string {
  if (!updated) return ''
  try {
    return new Date(updated).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
  } catch {
    return ''
  }
}

/**
 * Each session's sandbox, keyed by id.
 *
 * Artifacts only ever live there: an attached folder is mounted read-only, so
 * every write the agent lands is inside the sandbox. Resolving against
 * `session.folder` pointed at a path that does not exist -- and at nothing at
 * all for a session with no folder attached, which hid Open and the thumbnails
 * entirely.
 */
function useSessionWorkspaces(sessionIds: string[]): Record<string, string> {
  const [paths, setPaths] = useState<Record<string, string>>({})
  const key = sessionIds.join(',')

  useEffect(() => {
    let alive = true
    void (async () => {
      const dataFolder = await getServiceHub().app().getJanDataFolder()
      if (!dataFolder) return
      const found = await Promise.all(
        key
          .split(',')
          .filter(Boolean)
          .map(async (id) => {
            try {
              return [id, await sessionWorkspacePath(dataFolder, id)] as const
            } catch {
              return [id, ''] as const
            }
          })
      )
      if (alive) {
        setPaths(Object.fromEntries(found.filter(([, path]) => path)))
      }
    })()
    return () => {
      alive = false
    }
  }, [key])

  return paths
}

function ArtifactsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const serviceHub = useServiceHub()
  const sessions = useCoworkSessions((s) => s.sessions)
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState<CoworkArtifact['group'] | null>(null)
  // ponytail: a render cap with "show more" rather than paging or a virtual
  // list. Search and the kind filter already narrow the set, and DOM size was
  // the only real cost. Swap for virtualization if this hits thousands.
  const [limit, setLimit] = useState(PAGE)

  // ponytail: derived from the sessions already on disk rather than a durable
  // artifact store (#299). No registration path, no migration — the trade-off
  // is that an artifact disappears if its session is deleted. See #310 for why
  // that store needs splitting before it can carry artifact records.
  const workspaces = useSessionWorkspaces(
    useMemo(() => sessions.map((s) => s.id), [sessions])
  )

  const rows = useMemo<Row[]>(
    () =>
      sessions.flatMap((session) => {
        const root = workspaces[session.id] ?? null
        return artifactsFromTurns(session.turns, root).map((artifact) => ({
          ...artifact,
          sessionId: session.id,
          sessionTitle: session.title,
          folder: session.folder ?? null,
          updated: session.updated,
          root,
        }))
      }),
    [sessions, workspaces]
  )

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(
      (r) =>
        (!group || r.group === group) &&
        (!q ||
          r.title.toLowerCase().includes(q) ||
          r.path.toLowerCase().includes(q))
    )
  }, [rows, query, group])

  // Narrowing the set should start from the top again.
  useEffect(() => setLimit(PAGE), [query, group])

  const open = (row: Row) => {
    useCoworkSessions.getState().selectSession(row.sessionId)
    useCoworkRun.getState().requestPreview(row.sessionId, row.path)
    navigate({ to: route.cowork })
  }

  /** The session that made the artifact, without opening a preview. */
  const goToSession = (row: Row) => {
    useCoworkSessions.getState().selectSession(row.sessionId)
    navigate({ to: route.cowork })
  }

  return (
    <div className="flex h-full w-full flex-col">
      <HeaderPage>
        <div className="relative z-20 flex w-full min-w-0 items-center gap-2 sm:gap-3">
          <h1 className="font-semibold hidden shrink-0 text-lg leading-none text-foreground sm:block">
            {t('common:appRail.library')}
          </h1>
          <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-sunken px-2.5 focus-within:outline-2 focus-within:outline-ring sm:max-w-sm pointer-coarse:h-11">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('common:artifactsSearch')}
              aria-label={t('common:artifactsSearch')}
              className="w-full min-w-0 bg-transparent text-base placeholder:text-muted-foreground focus:outline-none md:text-sm"
            />
          </label>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 pointer-coarse:h-11"
              >
                {group ?? t('common:artifactsAll')}
                <ChevronDown className="size-3.5 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="end">
              <DropdownMenuItem onClick={() => setGroup(null)}>
                {t('common:artifactsAll')}
              </DropdownMenuItem>
              {ARTIFACT_GROUP_NAMES.map((g) => (
                <DropdownMenuItem key={g} onClick={() => setGroup(g)}>
                  {g}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </HeaderPage>

      <div className="min-h-0 w-full flex-1 overflow-y-auto overflow-x-hidden p-4 md:p-6">
        <div className="mx-auto w-full max-w-6xl">
          {shown.length === 0 ? (
            rows.length === 0 ? (
              // Distinct: nothing made yet vs nothing matching the filter.
              <div
                className="mx-auto mt-10 flex max-w-md flex-col items-start gap-3 rounded-lg border border-border bg-card p-6"
                data-testid="artifacts-empty"
              >
                <h2 className="font-semibold  text-lg leading-tight text-foreground">
                  {t('common:artifactsEmptyTitle')}
                </h2>
                <p className="text-sm leading-relaxed text-ink-2">
                  {t('common:artifactsEmpty')}
                </p>
                <Button
                  className="pointer-coarse:h-11"
                  onClick={() => navigate({ to: route.cowork })}
                >
                  {t('common:artifactsOpenCowork')}
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t('common:artifactsNoMatch')}
              </p>
            )
          ) : (
            <ul
              className="grid auto-rows-min grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
              data-testid="artifacts-gallery"
            >
              {shown.slice(0, limit).map((row) => {
                const Icon = ARTIFACT_ICON[row.group]
                const kind = previewKindFor(row.path)
                const abs = row.root ? resolveInRoot(row.root, row.path) : null
                // A real thumbnail only where the browser renders the file on
                // its own; HTML would need executing the page.
                const thumb =
                  abs && (kind === 'image' || kind === 'svg')
                    ? serviceHub.core().convertFileSrc(abs)
                    : null
                const project = row.folder
                  ? folderName(row.folder)
                  : t('common:artifactSandbox')
                const updated = formatUpdated(row.updated)
                return (
                  <li
                    key={`${row.sessionId}:${row.path}`}
                    data-testid="artifact-card"
                    className="flex min-w-0 flex-col rounded-lg border border-border bg-card transition-colors hover:border-line-strong"
                  >
                    <div className="flex min-w-0 items-start gap-3 p-3.5">
                      {thumb ? (
                        <img
                          src={thumb}
                          alt=""
                          className="size-12 shrink-0 rounded-md border border-border bg-sunken object-contain"
                        />
                      ) : (
                        <div className="flex size-12 shrink-0 items-center justify-center rounded-md border border-border bg-sunken">
                          <Icon className="size-5 text-muted-foreground" />
                        </div>
                      )}
                      {/* min-w-0 on a block box: `truncate` is inert otherwise. */}
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                          {row.group} · {row.label}
                        </p>
                        <h2
                          className="mt-0.5 truncate text-sm font-semibold text-foreground"
                          title={row.title}
                        >
                          {row.title}
                        </h2>
                        <p
                          className="mt-0.5 truncate font-mono text-xs text-muted-foreground"
                          title={row.path}
                        >
                          {row.path}
                        </p>
                      </div>
                    </div>
                    <dl className="mx-3.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-border py-2.5 text-xs">
                      <dt className="text-muted-foreground">
                        {t('common:artifactSession')}
                      </dt>
                      <dd
                        className="min-w-0 truncate text-ink-2"
                        title={row.sessionTitle}
                      >
                        {row.sessionTitle}
                      </dd>
                      <dt className="text-muted-foreground">
                        {t('common:artifactProject')}
                      </dt>
                      <dd
                        className="min-w-0 truncate text-ink-2"
                        title={row.folder ?? project}
                      >
                        {project}
                      </dd>
                      {updated && (
                        <>
                          <dt className="text-muted-foreground">
                            {t('common:artifactUpdated')}
                          </dt>
                          <dd className="min-w-0 truncate tabular-nums text-ink-2">
                            {updated}
                          </dd>
                        </>
                      )}
                    </dl>
                    <div className="mt-auto flex flex-wrap items-center gap-1.5 border-t border-border p-2.5">
                      <Button
                        variant="outline"
                        size="sm"
                        className="pointer-coarse:h-11"
                        onClick={() => open(row)}
                        data-testid="artifact-open"
                      >
                        <Eye />
                        {t('common:artifactOpenPreview')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="pointer-coarse:h-11"
                        onClick={() => goToSession(row)}
                        data-testid="artifact-go-to-session"
                      >
                        <MessagesSquare />
                        {t('common:artifactGoToSession')}
                      </Button>
                      {abs && (
                        <div className="ml-auto flex items-center">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="pointer-coarse:size-11"
                            onClick={() =>
                              void serviceHub.opener().openPath(abs)
                            }
                            title={t('common:artifactOpenExternal')}
                            aria-label={t('common:artifactOpenExternal')}
                          >
                            <SquareArrowOutUpRight className="text-muted-foreground" />
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="pointer-coarse:size-11"
                                aria-label={t('common:artifactMoreActions')}
                              >
                                <MoreHorizontal className="text-muted-foreground" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() =>
                                  void serviceHub.opener().openPath(abs)
                                }
                              >
                                <SquareArrowOutUpRight />
                                {t('common:artifactOpenExternal')}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() =>
                                  void serviceHub.opener().revealItemInDir(abs)
                                }
                              >
                                <FolderOpen />
                                {t('common:artifactShowInFolder')}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
          {shown.length > limit && (
            <div className="mt-4 flex justify-center">
              <Button
                variant="outline"
                size="sm"
                className="pointer-coarse:h-11"
                onClick={() => setLimit((n) => n + PAGE)}
              >
                {t('common:artifactsShowMore', { count: shown.length - limit })}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
