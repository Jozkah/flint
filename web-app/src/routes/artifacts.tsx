/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  FolderOpen,
  Info,
  Search,
  SquareArrowOutUpRight,
  Workflow,
  X,
} from 'lucide-react'
import { fs } from '@janhq/core'
import HeaderPage from '@/containers/HeaderPage'
import { Button } from '@/components/ui/button'
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
import { cn } from '@/lib/utils'

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

const rowKey = (row: Pick<Row, 'sessionId' | 'path'>) =>
  `${row.sessionId}:${row.path}`

/** The last path segment, for naming a project folder on a row. */
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

/**
 * Whether the selected file is still on disk. `undefined` while unknown, or
 * when the check is unavailable: only a definite "no" shows the notice.
 */
function useFileExists(abs: string | null) {
  const [exists, setExists] = useState<boolean | undefined>(undefined)
  useEffect(() => {
    setExists(undefined)
    if (!abs) return
    let alive = true
    Promise.resolve(fs.existsSync(abs))
      .then((value) => {
        if (alive && typeof value === 'boolean') setExists(value)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [abs])
  return exists
}

function ArtifactsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const serviceHub = useServiceHub()
  const sessions = useCoworkSessions((s) => s.sessions)
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState<CoworkArtifact['group'] | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
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

  const selected = useMemo(
    () => rows.find((r) => rowKey(r) === selectedKey) ?? null,
    [rows, selectedKey]
  )

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

  const filters: Array<CoworkArtifact['group'] | null> = [
    null,
    ...ARTIFACT_GROUP_NAMES,
  ]

  return (
    <div className="flex h-full w-full min-w-0 flex-col">
      <HeaderPage>
        <div className="relative z-20 flex w-full min-w-0 items-center gap-2 sm:gap-3">
          <h1 className="hidden shrink-0 text-sm font-semibold text-foreground sm:block">
            {t('common:appRail.library')}
          </h1>
          <label className="ml-auto flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-sunken px-2.5 focus-within:outline-2 focus-within:outline-ring sm:max-w-xs pointer-coarse:h-11">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('common:artifactsSearch')}
              aria-label={t('common:artifactsSearch')}
              className="w-full min-w-0 bg-transparent text-base placeholder:text-muted-foreground focus:outline-none md:text-sm"
            />
          </label>
        </div>
      </HeaderPage>

      <div className="flex min-h-0 w-full min-w-0 flex-1">
        {/* The list. On phones it gives way to the details of a selection. */}
        <div
          className={cn(
            'min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-3 md:px-6 md:py-4',
            selected && 'max-md:hidden'
          )}
        >
          <div className="mx-auto w-full max-w-[1400px]">
            {rows.length > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                <div
                  role="group"
                  aria-label={t('common:artifactsFilterLabel')}
                  className="flex max-w-full items-center gap-0.5 overflow-x-auto rounded-md bg-sunken p-0.5"
                >
                  {filters.map((g) => {
                    const pressed = group === g
                    return (
                      <button
                        key={g ?? 'all'}
                        type="button"
                        aria-pressed={pressed}
                        onClick={() => setGroup(g)}
                        className={cn(
                          'h-7 shrink-0 cursor-pointer rounded-[5px] px-2.5 text-[13px] font-medium transition-colors pointer-coarse:h-10',
                          pressed
                            ? 'bg-card text-foreground shadow-[0_0_0_1px_var(--border)]'
                            : 'text-ink-2 hover:text-foreground'
                        )}
                      >
                        {g ?? t('common:artifactsAll')}
                      </button>
                    )
                  })}
                </div>
                <span
                  className="text-xs tabular-nums text-muted-foreground"
                  aria-live="polite"
                >
                  {t('common:artifactsCount', { count: shown.length })}
                </span>
              </div>
            )}

            {shown.length === 0 ? (
              rows.length === 0 ? (
                // Distinct: nothing made yet vs nothing matching the filter.
                <div
                  className="mx-auto mt-10 flex max-w-md flex-col items-start gap-2 rounded-lg border border-border bg-card p-5"
                  data-testid="artifacts-empty"
                >
                  <h2 className="text-[13px] font-semibold text-foreground">
                    {t('common:artifactsEmptyTitle')}
                  </h2>
                  <p className="text-sm leading-relaxed text-ink-2">
                    {t('common:artifactsEmpty')}
                  </p>
                  <Button
                    className="mt-1 pointer-coarse:h-11"
                    onClick={() => navigate({ to: route.cowork })}
                  >
                    {t('common:artifactsOpenCowork')}
                  </Button>
                </div>
              ) : (
                <p className="py-6 text-sm text-muted-foreground">
                  {t('common:artifactsNoMatch')}
                </p>
              )
            ) : (
              <ul
                className="border-t border-border"
                data-testid="artifacts-gallery"
              >
                {shown.slice(0, limit).map((row) => (
                  <LibraryRow
                    key={rowKey(row)}
                    row={row}
                    selected={rowKey(row) === selectedKey}
                    onSelect={() => setSelectedKey(rowKey(row))}
                    onOpen={() => open(row)}
                    onGoToSession={() => goToSession(row)}
                  />
                ))}
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
                  {t('common:artifactsShowMore', {
                    count: shown.length - limit,
                  })}
                </Button>
              </div>
            )}
          </div>
        </div>

        {selected && (
          <ArtifactInspector
            key={rowKey(selected)}
            row={selected}
            onClose={() => setSelectedKey(null)}
            onOpen={() => open(selected)}
            onGoToSession={() => goToSession(selected)}
            convertFileSrc={(p) => serviceHub.core().convertFileSrc(p)}
            openPath={(p) => void serviceHub.opener().openPath(p)}
            revealItemInDir={(p) => void serviceHub.opener().revealItemInDir(p)}
          />
        )}
      </div>
    </div>
  )
}

/**
 * One artifact. The row itself selects (details open beside the list); the
 * two icon buttons act straight from the list, as the old card did, and the
 * row opens the preview on double-click.
 */
function LibraryRow({
  row,
  selected,
  onSelect,
  onOpen,
  onGoToSession,
}: {
  row: Row
  selected: boolean
  onSelect: () => void
  onOpen: () => void
  onGoToSession: () => void
}) {
  const { t } = useTranslation()
  const Icon = ARTIFACT_ICON[row.group]
  const project = row.folder ? folderName(row.folder) : t('common:artifactSandbox')
  const updated = formatUpdated(row.updated)
  // #183: a row whose path never resolved inside its session root has nothing
  // to preview; the double-click and Open button are gated the same way as
  // the inspector's Open Preview.
  const canOpen = Boolean(row.root && resolveInRoot(row.root, row.path))
  return (
    <li
      data-testid="artifact-card"
      className={cn(
        'group relative flex min-w-0 items-center border-b border-border transition-colors hover:bg-accent',
        selected &&
          'bg-accent before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-brand-rail'
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={canOpen ? onOpen : undefined}
        aria-current={selected || undefined}
        aria-label={t('common:artifactShowDetails', { name: row.title })}
        data-testid="artifact-row"
        className="grid min-w-0 flex-1 cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 py-2 pl-2 text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-14 md:grid-cols-[auto_minmax(0,2fr)_minmax(0,1.2fr)_10.5rem] lg:grid-cols-[auto_minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,0.8fr)_10.5rem]"
      >
        <span className="row-span-2 flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-sunken md:row-span-1">
          <Icon className="size-4 text-muted-foreground" aria-hidden />
        </span>
        {/* min-w-0 on a grid child: `truncate` is inert otherwise. */}
        <span className="min-w-0">
          <span
            className="block truncate text-sm font-medium text-foreground"
            title={row.title}
          >
            {row.title}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {row.group} · {row.label}
            <span className="font-mono"> · {row.path}</span>
          </span>
        </span>
        <span
          className="hidden min-w-0 items-center gap-1.5 text-[13px] text-ink-2 md:flex"
          title={row.sessionTitle}
        >
          <Workflow className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{row.sessionTitle}</span>
        </span>
        <span
          className="hidden min-w-0 truncate text-[13px] text-muted-foreground lg:block"
          title={row.folder ?? project}
        >
          {project}
        </span>
        <span className="hidden whitespace-nowrap text-xs tabular-nums text-muted-foreground md:block">
          {updated}
        </span>
        {/* Phones: the source under the name, since its column is hidden. */}
        <span className="col-start-2 truncate text-xs text-ink-2 md:hidden">
          {row.sessionTitle}
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-0.5 pl-2 pr-1.5">
        <Button
          variant="ghost"
          size="icon-sm"
          className="pointer-coarse:size-11"
          onClick={onOpen}
          disabled={!canOpen}
          title={t('common:artifactOpenPreview')}
          aria-label={`${t('common:artifactOpenPreview')}: ${row.title}`}
          data-testid="artifact-open"
        >
          <Eye />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="pointer-coarse:size-11"
          onClick={onGoToSession}
          title={t('common:artifactGoToSession')}
          aria-label={`${t('common:artifactGoToSession')}: ${row.sessionTitle}`}
          data-testid="artifact-go-to-session"
        >
          <ChevronRight />
        </Button>
      </div>
    </li>
  )
}

function ArtifactInspector({
  row,
  onClose,
  onOpen,
  onGoToSession,
  convertFileSrc,
  openPath,
  revealItemInDir,
}: {
  row: Row
  onClose: () => void
  onOpen: () => void
  onGoToSession: () => void
  convertFileSrc: (path: string) => string
  openPath: (path: string) => void
  revealItemInDir: (path: string) => void
}) {
  const { t } = useTranslation()
  const Icon = ARTIFACT_ICON[row.group]
  const kind = previewKindFor(row.path)
  const abs = row.root ? resolveInRoot(row.root, row.path) : null
  const missing = useFileExists(abs) === false
  // A real thumbnail only where the browser renders the file on its own; HTML
  // would need executing the page.
  const thumb =
    abs && !missing && (kind === 'image' || kind === 'svg')
      ? convertFileSrc(abs)
      : null
  const project = row.folder ? folderName(row.folder) : t('common:artifactSandbox')
  const updated = formatUpdated(row.updated)

  return (
    <aside
      aria-label={t('common:artifactDetails')}
      data-testid="artifact-inspector"
      className="flex min-h-0 w-full shrink-0 flex-col border-border bg-sunken md:w-(--inspector-w) md:border-l"
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border pl-1 pr-1.5 md:pl-4">
        <Button
          variant="ghost"
          size="icon-sm"
          className="md:hidden pointer-coarse:size-11"
          onClick={onClose}
          aria-label={t('common:artifactBack')}
        >
          <ChevronLeft />
        </Button>
        <h2
          className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground"
          title={row.title}
        >
          {row.title}
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          className="hidden md:inline-flex"
          onClick={onClose}
          aria-label={t('common:artifactClose')}
        >
          <X />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
        {/* Preview. The file itself keeps its own look; only the frame is ours. */}
        <section className="border-b border-border p-4">
          {thumb ? (
            <img
              src={thumb}
              alt=""
              className="max-h-56 w-full rounded-md border border-border bg-card object-contain"
            />
          ) : (
            <div className="flex items-center gap-3 rounded-md border border-border bg-card p-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-sunken">
                <Icon className="size-5 text-muted-foreground" aria-hidden />
              </span>
              <p className="min-w-0 text-xs leading-relaxed text-ink-2">
                {t('common:artifactNoPreview')}
              </p>
            </div>
          )}
          {missing && (
            <div
              role="status"
              data-testid="artifact-missing"
              className="mt-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning-tint px-3 py-2.5"
            >
              <Info className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-foreground">
                  {t('common:artifactFileMissingTitle')}
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-2">
                  {t('common:artifactFileMissing')}
                </p>
              </div>
            </div>
          )}
        </section>

        {/* Where it came from, and the way back there. */}
        <section className="border-b border-border p-4">
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">
            {t('common:artifactSource')}
          </h3>
          <div className="flex min-w-0 items-start gap-2">
            <Workflow className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0">
              <p className="truncate text-sm text-foreground" title={row.sessionTitle}>
                {row.sessionTitle}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {t('common:artifactCoworkSession')}
                {updated ? ` · ${updated}` : ''}
              </p>
            </div>
          </div>
          <Button
            className="mt-3 pointer-coarse:h-11"
            onClick={onGoToSession}
            data-testid="artifact-inspector-go-to-session"
          >
            <ChevronRight />
            {t('common:artifactGoToSession')}
          </Button>
        </section>

        <section className="p-4">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px]">
            <dt className="text-muted-foreground">{t('common:artifactType')}</dt>
            <dd className="min-w-0 truncate text-right text-foreground">
              {row.group} · {row.label}
            </dd>
            <dt className="text-muted-foreground">{t('common:artifactProject')}</dt>
            <dd
              className="min-w-0 truncate text-right text-foreground"
              title={row.folder ?? project}
            >
              {project}
            </dd>
            <dt className="text-muted-foreground">{t('common:artifactPath')}</dt>
            <dd
              className="min-w-0 truncate text-right font-mono text-xs leading-5 text-ink-2"
              title={row.path}
            >
              {row.path}
            </dd>
            {updated && (
              <>
                <dt className="text-muted-foreground">
                  {t('common:artifactUpdated')}
                </dt>
                <dd className="min-w-0 truncate text-right tabular-nums text-foreground">
                  {updated}
                </dd>
              </>
            )}
          </dl>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="outline"
              className="pointer-coarse:h-11"
              onClick={onOpen}
              // Same precondition as the external/folder actions: a path that
              // never resolved inside the session root cannot be previewed.
              disabled={!abs || missing}
              data-testid="artifact-inspector-open"
            >
              <Eye />
              {t('common:artifactOpenPreview')}
            </Button>
            {abs && !missing && (
              <>
                <Button
                  variant="outline"
                  className="pointer-coarse:h-11"
                  onClick={() => openPath(abs)}
                >
                  <SquareArrowOutUpRight />
                  {t('common:artifactOpenExternal')}
                </Button>
                <Button
                  variant="ghost"
                  className="pointer-coarse:h-11"
                  onClick={() => revealItemInDir(abs)}
                >
                  <FolderOpen />
                  {t('common:artifactShowInFolder')}
                </Button>
              </>
            )}
          </div>
        </section>
      </div>
    </aside>
  )
}
