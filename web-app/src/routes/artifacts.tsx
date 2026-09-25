/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import {
  ChevronRight,
  Clock,
  Eye,
  FolderOpen,
  Info,
  Library,
  SquareArrowOutUpRight,
  Workflow,
  X,
} from 'lucide-react'
import { fs } from '@janhq/core'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { Segmented } from '@/components/ui/segmented'
import {
  EnginePage,
  KpiRow,
  KpiTile,
  PageHead,
  SearchField,
} from '@/containers/engine/EngineKit'
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

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

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

  const sessionCount = new Set(rows.map((r) => r.sessionId)).size
  const now = Date.now()
  const thisWeek = rows.filter((r) => r.updated && now - r.updated < WEEK_MS)
  const latest = rows.reduce((m, r) => Math.max(m, r.updated || 0), 0)
  const convertFileSrc = (p: string) => serviceHub.core().convertFileSrc(p)

  return (
    <div className="flex h-full w-full min-w-0 flex-col">
      <EnginePage testId="library-page">
        <PageHead
          title={t('common:appRail.library')}
          description={t('engine:library.description')}
          actions={
            <SearchField
              className="w-[240px] max-w-full"
              value={query}
              onChange={setQuery}
              placeholder={t('common:artifactsSearch')}
            />
          }
        />

        <KpiRow columns={3}>
          <KpiTile
            title={t('engine:library.kpiArtifacts')}
            icon={<Library />}
            value={rows.length}
            sub={t('engine:library.kpiArtifactsSub', { count: thisWeek.length })}
            delay={40}
          />
          <KpiTile
            title={t('engine:library.kpiSessions')}
            icon={<Workflow />}
            value={sessionCount}
            sub={t('engine:library.kpiSessionsSub', { count: sessions.length })}
            delay={90}
          />
          <KpiTile
            title={t('engine:library.kpiLatest')}
            icon={<Clock />}
            value={latest ? formatDay(latest) : '—'}
            sub={latest ? formatUpdated(latest) : t('engine:library.kpiLatestNone')}
            delay={140}
          />
        </KpiRow>

        {rows.length === 0 ? (
          // Distinct: nothing made yet vs nothing matching the filter.
          <Frame data-testid="artifacts-empty">
            <FrameBody>
              <EmptyState
                icon={<Library />}
                title={t('common:artifactsEmptyTitle')}
                description={t('common:artifactsEmpty')}
                action={
                  <Button
                    className="pointer-coarse:h-11"
                    onClick={() => navigate({ to: route.cowork })}
                  >
                    {t('common:artifactsOpenCowork')}
                  </Button>
                }
              />
            </FrameBody>
          </Frame>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 motion-safe:animate-rise-in [animation-delay:160ms]">
              <Segmented<string>
                className="w-[560px] max-w-full"
                aria-label={t('common:artifactsFilterLabel')}
                value={group ?? 'all'}
                onValueChange={(v) =>
                  setGroup(v === 'all' ? null : (v as CoworkArtifact['group']))
                }
                options={[
                  { value: 'all', label: t('common:artifactsAll') },
                  ...ARTIFACT_GROUP_NAMES.map((g) => ({ value: g, label: g })),
                ]}
              />
              <span
                className="text-xs text-muted-foreground tabular-nums"
                aria-live="polite"
              >
                {t('common:artifactsCount', { count: shown.length })}
              </span>
            </div>

            <div
              className={cn(
                'grid items-start gap-4',
                selected && 'lg:grid-cols-[minmax(0,1fr)_330px]'
              )}
            >
              <div className={cn('min-w-0', selected && 'max-lg:hidden')}>
                {shown.length === 0 ? (
                  <p className="py-10 text-center text-[13px] text-muted-foreground">
                    {t('common:artifactsNoMatch')}
                  </p>
                ) : (
                  <ul
                    className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-4"
                    data-testid="artifacts-gallery"
                  >
                    {shown.slice(0, limit).map((row, i) => (
                      <LibraryCard
                        key={rowKey(row)}
                        row={row}
                        index={i}
                        selected={rowKey(row) === selectedKey}
                        onSelect={() => setSelectedKey(rowKey(row))}
                        onOpen={() => open(row)}
                        onGoToSession={() => goToSession(row)}
                        convertFileSrc={convertFileSrc}
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

              {selected && (
                <ArtifactInspector
                  key={rowKey(selected)}
                  row={selected}
                  onClose={() => setSelectedKey(null)}
                  onOpen={() => open(selected)}
                  onGoToSession={() => goToSession(selected)}
                  convertFileSrc={convertFileSrc}
                  openPath={(p) => void serviceHub.opener().openPath(p)}
                  revealItemInDir={(p) =>
                    void serviceHub.opener().revealItemInDir(p)
                  }
                />
              )}
            </div>
          </>
        )}
      </EnginePage>
    </div>
  )
}

/** A day label for the "latest" tile: today, yesterday, or the date. */
function formatDay(updated: number): string {
  try {
    return new Date(updated).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return ''
  }
}

/**
 * A preview-shaped placeholder per kind (the design's `.thumb`): code lines,
 * a document, a chart for pages, a waveform for audio. A real image is shown
 * when the file is one the browser renders on its own.
 */
function ArtifactThumb({
  row,
  src,
  big = false,
}: {
  row: Row
  src?: string | null
  big?: boolean
}) {
  const [broken, setBroken] = useState(false)
  const base = cn(
    'relative flex flex-col gap-1.5 overflow-hidden rounded-lg p-3 shadow-[inset_0_0_0_0.8px_var(--border)]',
    big ? 'h-[170px]' : 'h-[118px]'
  )
  const line = 'block h-1.5 rounded-full'
  const sheen = (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-0 bg-[linear-gradient(105deg,transparent_35%,rgba(255,255,255,.18)_50%,transparent_65%)] motion-safe:animate-sheen"
    />
  )
  if (src && !broken) {
    return (
      <div className={cn(base, 'bg-muted p-0')}>
        <img
          src={src}
          alt=""
          loading="lazy"
          onError={() => setBroken(true)}
          className="size-full object-contain"
        />
      </div>
    )
  }
  if (row.group === 'Code' && previewKindFor(row.path) !== 'html') {
    return (
      <div className={cn(base, 'bg-term-bg')}>
        {[
          ['w-[30%]', 'bg-[#6366f1]/70'],
          ['w-[70%]', 'bg-white/15'],
          ['w-1/2', 'bg-[#10b981]/60'],
          ['w-[82%]', 'bg-white/15'],
          ['w-[22%]', 'bg-[#6366f1]/70'],
          ['w-[60%]', 'bg-white/15'],
        ].map(([w, c], i) => (
          <i key={i} className={cn(line, w, c)} />
        ))}
        {sheen}
      </div>
    )
  }
  if (row.group === 'Code') {
    // A page: a heading, a line, and a small bar chart.
    return (
      <div className={cn(base, 'bg-card')}>
        <i className={cn(line, 'h-2 w-[55%] bg-sk-2')} />
        <i className={cn(line, 'w-[60%] bg-sk')} />
        <div className="mt-auto flex h-[60px] items-end gap-[5px]">
          {[40, 70, 55, 90, 65, 80].map((h, j) => (
            <span
              key={j}
              style={{ height: `${h}%`, animationDelay: `${j * 50}ms` }}
              className={cn(
                'flex-1 origin-bottom rounded-t-[4px] rounded-b-[2px] motion-safe:animate-grow-y',
                j === 3 ? 'bg-grad' : 'bg-sk-2'
              )}
            />
          ))}
        </div>
        {sheen}
      </div>
    )
  }
  if (row.group === 'Audio' || row.group === 'Video') {
    return (
      <div className={cn(base, 'flex-row items-center gap-[3px] bg-card px-4')}>
        {Array.from({ length: 36 }, (_, i) => (
          <span
            key={i}
            style={{ height: `${20 + Math.abs(Math.sin(i * 1.7)) * 70}%` }}
            className={cn(
              'flex-1 rounded-[2px]',
              i >= 9 && i < 14 ? 'bg-grad' : 'bg-sk-2'
            )}
          />
        ))}
      </div>
    )
  }
  if (row.group === 'Image') {
    return (
      <div className={cn(base, 'bg-card p-0')}>
        <svg viewBox="0 0 120 60" preserveAspectRatio="none" className="size-full" aria-hidden>
          <path d="M0 50 20 38 40 42 60 20 80 28 100 12 120 16V60H0Z" fill="var(--sk-2)" />
          <path
            d="M0 50 20 38 40 42 60 20 80 28 100 12 120 16"
            fill="none"
            stroke="var(--success)"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
    )
  }
  return (
    <div className={cn(base, 'bg-card')}>
      <i className={cn(line, 'h-2 w-[55%] bg-sk-2')} />
      {['w-[92%]', 'w-[84%]', 'w-[88%]', 'w-[60%]', 'w-[76%]'].map((w, i) => (
        <i key={i} className={cn(line, w, 'bg-sk')} />
      ))}
      {sheen}
    </div>
  )
}

/** A thumbnail source for files the browser draws itself, else nothing. */
function thumbSrc(
  row: Row,
  convertFileSrc: (path: string) => string
): string | null {
  const kind = previewKindFor(row.path)
  if (!row.root || (kind !== 'image' && kind !== 'svg')) return null
  try {
    const abs = resolveInRoot(row.root, row.path)
    return abs ? convertFileSrc(abs) : null
  } catch {
    return null
  }
}

/**
 * One artifact as a card. The card itself selects (details open beside the
 * grid); the eye opens the preview and the session line goes back to the
 * run, straight from the grid. Double-click opens the preview too.
 */
function LibraryCard({
  row,
  index,
  selected,
  onSelect,
  onOpen,
  onGoToSession,
  convertFileSrc,
}: {
  row: Row
  index: number
  selected: boolean
  onSelect: () => void
  onOpen: () => void
  onGoToSession: () => void
  convertFileSrc: (path: string) => string
}) {
  const { t } = useTranslation()
  const Icon = ARTIFACT_ICON[row.group]
  const project = row.folder ? folderName(row.folder) : t('common:artifactSandbox')
  const updated = formatUpdated(row.updated)
  return (
    <li data-testid="artifact-card" className="min-w-0">
      <Frame
        style={{ animationDelay: `${40 + index * 35}ms` }}
        className={cn(
          'group h-full cursor-pointer motion-safe:animate-rise-in',
          selected &&
            '[&>[data-slot=frame-body]]:shadow-[0_0_0_1.5px_var(--primary),0_4px_14px_rgba(0,0,0,.08)]'
        )}
      >
        <FrameHeader
          icon={<Icon />}
          title={<span title={row.title}>{row.title}</span>}
          actions={
            <Button
              variant="ghost"
              size="icon-sm"
              className="relative z-10 pointer-coarse:size-11"
              onClick={onOpen}
              title={t('common:artifactOpenPreview')}
              aria-label={`${t('common:artifactOpenPreview')}: ${row.title}`}
              data-testid="artifact-open"
            >
              <Eye />
            </Button>
          }
        />
        <FrameBody className="gap-2 p-3">
          <button
            type="button"
            onClick={onSelect}
            onDoubleClick={onOpen}
            aria-current={selected || undefined}
            aria-label={t('common:artifactShowDetails', { name: row.title })}
            data-testid="artifact-row"
            className="absolute inset-0 z-0 cursor-pointer rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
          />
          <div className="pointer-events-none">
            <ArtifactThumb row={row} src={thumbSrc(row, convertFileSrc)} />
          </div>
          <div className="pointer-events-none flex items-center justify-between gap-2 text-xs text-subtle-foreground">
            <span className="truncate">
              {row.group} · {row.label}
            </span>
            <span className="shrink-0 tabular-nums">{updated}</span>
          </div>
          <div className="flex min-w-0 items-center justify-between gap-2 text-xs text-subtle-foreground">
            <button
              type="button"
              onClick={onGoToSession}
              title={t('common:artifactGoToSession')}
              aria-label={`${t('common:artifactGoToSession')}: ${row.sessionTitle}`}
              data-testid="artifact-go-to-session"
              className="relative z-10 flex min-w-0 items-center gap-1.5 rounded-md text-left hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Workflow className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{row.sessionTitle}</span>
            </button>
            <span
              className="pointer-events-none min-w-0 shrink truncate"
              title={row.folder ?? project}
            >
              {project}
            </span>
          </div>
        </FrameBody>
      </Frame>
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
    <Frame
      aria-label={t('common:artifactDetails')}
      data-testid="artifact-inspector"
      className="motion-safe:animate-rise-in lg:sticky lg:top-0"
    >
      <FrameHeader
        icon={<Icon />}
        title={<span title={row.title}>{row.title}</span>}
        actions={
          <Button
            variant="ghost"
            size="icon-sm"
            className="pointer-coarse:size-11"
            onClick={onClose}
            aria-label={t('common:artifactClose')}
          >
            <X />
          </Button>
        }
      />
      <FrameBody className="gap-3 p-3">
        <ArtifactThumb row={row} src={thumb} big />
        {missing && (
          <div
            role="status"
            data-testid="artifact-missing"
            className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-tint px-3 py-2.5"
          >
            <Info className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-foreground">
                {t('common:artifactFileMissingTitle')}
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-fg-2">
                {t('common:artifactFileMissing')}
              </p>
            </div>
          </div>
        )}
        {!thumb && !missing && (
          <p className="m-0 text-xs leading-relaxed text-muted-foreground">
            {t('common:artifactNoPreview')}
          </p>
        )}

        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3.5 gap-y-1.5 text-[12.5px]">
          <dt className="text-muted-foreground">{t('common:artifactType')}</dt>
          <dd className="min-w-0 truncate text-foreground">
            {row.group} · {row.label}
          </dd>
          <dt className="text-muted-foreground">{t('common:artifactProject')}</dt>
          <dd className="min-w-0 truncate text-foreground" title={row.folder ?? project}>
            {project}
          </dd>
          <dt className="text-muted-foreground">{t('common:artifactPath')}</dt>
          <dd className="min-w-0 font-mono text-xs break-all text-fg-2" title={row.path}>
            {row.path}
          </dd>
          {updated && (
            <>
              <dt className="text-muted-foreground">{t('common:artifactUpdated')}</dt>
              <dd className="min-w-0 truncate text-foreground tabular-nums">
                {updated}
              </dd>
            </>
          )}
        </dl>

        {/* Where it came from, and the way back there. */}
        <section className="flex flex-col gap-1.5 border-y border-dashed border-border py-2.5">
          <h3 className="text-[11px] font-medium text-subtle-foreground uppercase">
            {t('common:artifactSource')}
          </h3>
          <b className="truncate text-[13px] font-medium text-foreground" title={row.sessionTitle}>
            {row.sessionTitle}
          </b>
          <small className="text-xs text-muted-foreground">
            {t('common:artifactCoworkSession')}
            {updated ? ` · ${updated}` : ''}
          </small>
          <Button
            variant="outline"
            size="sm"
            className="self-start pointer-coarse:h-11"
            onClick={onGoToSession}
            data-testid="artifact-inspector-go-to-session"
          >
            <ChevronRight />
            {t('common:artifactGoToSession')}
          </Button>
        </section>

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            className="pointer-coarse:h-11"
            onClick={onOpen}
            disabled={missing}
            data-testid="artifact-inspector-open"
          >
            <Eye />
            {t('common:artifactOpenPreview')}
          </Button>
          {abs && !missing && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="pointer-coarse:h-11"
                onClick={() => openPath(abs)}
              >
                <SquareArrowOutUpRight />
                {t('common:artifactOpenExternal')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="pointer-coarse:h-11"
                onClick={() => revealItemInDir(abs)}
              >
                <FolderOpen />
                {t('common:artifactShowInFolder')}
              </Button>
            </>
          )}
        </div>
      </FrameBody>
    </Frame>
  )
}
