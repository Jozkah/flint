/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Eye, Info, X } from 'lucide-react'
import { fs } from '@janhq/core'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { Segmented } from '@/components/ui/segmented'
import { Icon, type IconName } from '@/components/ui/icon'
import {
  EnginePage,
  KpiRow,
  KpiTile,
  PageHead,
  SearchField,
} from '@/containers/engine/EngineKit'
import { route } from '@/constants/routes'
import { ensureCoworkEnabled } from '@/lib/coworkGate'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useElementWidth } from '@/hooks/useElementWidth'
import {
  formatDuration,
  htmlLines,
  loadPreviewText,
  markdownLines,
  textLines,
  type PreviewLine,
} from '@/lib/artifactCardPreview'
import { getServiceHub, useServiceHub } from '@/hooks/useServiceHub'
import { sessionWorkspacePath } from '@janhq/tauri-plugin-agent-tools-api'
import { artifactsFromTurns, type CoworkArtifact } from '@/lib/coworkArtifacts'
import { extensionOf, previewKindFor, resolveInRoot } from '@/lib/coworkPreview'
import type { CoworkTurn } from '@/types/coworkSession'
import { cn, formatBytes } from '@/lib/utils'
import { useStudio } from '@/hooks/useStudio'
import { studioLibraryEntries } from '@/lib/studio/library'
import type { GalleryItem } from '@/lib/studio/studio'
import { ImageViewer } from '@/components/ImageViewer'
import { VideoDialog } from '@/containers/studio/StudioPage'

export const Route = createFileRoute(route.artifacts as any)({
  beforeLoad: () => ensureCoworkEnabled(),
  component: ArtifactsPage,
})

const PAGE = 24

/**
 * What the library files an artifact under: HTML is a page, SVG is code, the
 * rest follow their group. Video gets a filter tab only when there is some.
 */
type Kind = 'code' | 'page' | 'doc' | 'image' | 'audio' | 'video'
const KINDS: Kind[] = ['code', 'page', 'doc', 'image', 'audio', 'video']
const KIND_LABEL: Record<Kind, string> = {
  code: 'engine:library.kindCode',
  page: 'engine:library.kindPages',
  doc: 'engine:library.kindDocuments',
  image: 'engine:library.kindImages',
  audio: 'engine:library.kindAudio',
  video: 'engine:library.kindVideo',
}
const KIND_ICON: Record<Kind, IconName> = {
  code: 'x-code',
  page: 'x-globe',
  doc: 'sb-file',
  image: 'x-palette',
  audio: 'x-play',
  video: 'x-play',
}

function kindOf(artifact: CoworkArtifact): Kind {
  const ext = extensionOf(artifact.path)
  if (ext === 'html' || ext === 'htm') return 'page'
  switch (artifact.group) {
    case 'Image':
      return 'image'
    case 'Document':
      return 'doc'
    case 'Audio':
      return 'audio'
    case 'Video':
      return 'video'
    default:
      return 'code'
  }
}

type Row = CoworkArtifact & {
  kind: Kind
  /** File size from the write result, when it reported one. */
  bytes?: number
  sessionId: string
  sessionTitle: string
  /** The attached project folder, when the session has one. */
  folder: string | null
  updated: number
  root: string | null
  /** Set for a Studio result (source "Studio"), which opens in its viewer. */
  studio?: GalleryItem
}

const rowKey = (row: Pick<Row, 'sessionId' | 'path'>) =>
  `${row.sessionId}:${row.path}`

/**
 * Size and finish time per written path, read off the session's `write`
 * results ("Created <path> (<n> bytes)").
 */
function writesOf(turns: CoworkTurn[] | undefined) {
  const out = new Map<string, { bytes?: number; at?: number }>()
  for (const turn of turns ?? []) {
    if (turn.role !== 'tool' || turn.name !== 'write') continue
    const path =
      turn.args && typeof turn.args === 'object'
        ? (turn.args as Record<string, unknown>).path
        : undefined
    if (typeof path !== 'string') continue
    const m = /\((\d+) bytes\)/.exec(turn.result ?? '')
    out.set(path, {
      bytes: m ? Number(m[1]) : out.get(path)?.bytes,
      at: turn.endedAt ?? turn.startedAt ?? out.get(path)?.at,
    })
  }
  return out
}

/** A readable type, e.g. "Markdown · 2 KB" or "HTML page". */
function typeLabel(row: Row, htmlPage: string): string {
  if (row.kind === 'page') return htmlPage
  const name = row.label === 'MD' ? 'Markdown' : row.label
  return row.bytes ? `${name} · ${formatBytes(row.bytes)}` : name
}

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

/** A short time for a card: the time today, the weekday this week, else the date. */
function formatShort(updated: number): string {
  if (!updated) return ''
  try {
    const d = new Date(updated)
    const now = new Date()
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      })
    }
    if (now.getTime() - d.getTime() < 6 * 24 * 60 * 60 * 1000) {
      return d.toLocaleDateString(undefined, { weekday: 'short' })
    }
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
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
/** Page width that fits two card columns plus the details column. */
const SIDE_COLUMN_MIN = 860

function ArtifactsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const serviceHub = useServiceHub()
  const sessions = useCoworkSessions((s) => s.sessions)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<Kind | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  // The details sit beside the grid when the page itself (not the window:
  // the app sidebar takes its share) has room for both; otherwise they open
  // as a drawer over the grid.
  const layoutRef = useRef<HTMLDivElement | null>(null)
  const sideColumn = useElementWidth(layoutRef) >= SIDE_COLUMN_MIN
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

  // Studio's results join the list; the gallery is read once on the way in.
  const studioImages = useStudio((s) => s.gallery.image)
  const studioVideos = useStudio((s) => s.gallery.video)
  useEffect(() => {
    void useStudio.getState().refreshGallery('image').catch(() => {})
    void useStudio.getState().refreshGallery('video').catch(() => {})
  }, [])
  const [viewing, setViewing] = useState<GalleryItem | null>(null)

  const rows = useMemo<Row[]>(
    () => [
      ...sessions.flatMap((session) => {
        const root = workspaces[session.id] ?? null
        const writes = writesOf(session.turns)
        return artifactsFromTurns(session.turns, root).map((artifact) => ({
          ...artifact,
          kind: kindOf(artifact),
          bytes: writes.get(artifact.path)?.bytes,
          sessionId: session.id,
          sessionTitle: session.title,
          folder: session.folder ?? null,
          updated: writes.get(artifact.path)?.at ?? session.updated,
          root,
        }))
      }),
      ...studioLibraryEntries([...studioImages, ...studioVideos]).map(
        (e): Row => ({
          path: e.path,
          title: e.title,
          group: e.group,
          label: e.label,
          kind: e.group === 'Video' ? 'video' : 'image',
          sessionId: `studio:${e.item.kind}`,
          sessionTitle: 'Studio',
          folder: null,
          updated: e.updated,
          root: e.root,
          studio: e.item,
        })
      ),
    ].sort((a, b) => (b.updated || 0) - (a.updated || 0)),
    [sessions, workspaces, studioImages, studioVideos]
  )

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(
      (r) =>
        (!kind || r.kind === kind) &&
        (!q ||
          r.title.toLowerCase().includes(q) ||
          r.path.toLowerCase().includes(q))
    )
  }, [rows, query, kind])

  // Narrowing the set should start from the top again.
  useEffect(() => setLimit(PAGE), [query, kind])

  // The highlight follows the click at once; the details panel renders from
  // a deferred copy, so building it never holds the selection back.
  const selected = useMemo(
    () => rows.find((r) => rowKey(r) === selectedKey) ?? null,
    [rows, selectedKey]
  )
  const inspected = useDeferredValue(selected)
  const kindsPresent = KINDS.filter(
    (k) => k !== 'video' || rows.some((r) => r.kind === k)
  )

  const open = useCallback(
    (row: Row) => {
      if (row.studio) return setViewing(row.studio)
      useCoworkSessions.getState().selectSession(row.sessionId)
      useCoworkRun.getState().requestPreview(row.sessionId, row.path)
      navigate({ to: route.cowork })
    },
    [navigate]
  )

  /** The session that made the artifact, without opening a preview. */
  const goToSession = useCallback(
    (row: Row) => {
      if (row.studio) return void navigate({ to: route.studio as never })
      useCoworkSessions.getState().selectSession(row.sessionId)
      navigate({ to: route.cowork })
    },
    [navigate]
  )

  const sessionCount = new Set(rows.map((r) => r.sessionId)).size
  const now = Date.now()
  const thisWeek = rows.filter((r) => r.updated && now - r.updated < WEEK_MS)
  const sized = rows.filter((r) => r.bytes)
  const diskBytes = sized.reduce((sum, r) => sum + (r.bytes ?? 0), 0)
  const convertFileSrc = useCallback(
    (p: string) => serviceHub.core().convertFileSrc(p),
    [serviceHub]
  )
  const htmlPage = t('engine:library.htmlPage')

  return (
    <div className="flex h-full w-full min-w-0 flex-col">
      <EnginePage testId="library-page">
        <PageHead
          title={t('common:appRail.library')}
          description={t('engine:library.description')}
          actions={
            <SearchField
              className="w-full sm:w-[240px]"
              value={query}
              onChange={setQuery}
              placeholder={t('common:artifactsSearch')}
            />
          }
        />

        <KpiRow columns={3}>
          <KpiTile
            title={t('engine:library.kpiArtifacts')}
            icon={<Icon name="x-library" />}
            value={rows.length}
            sub={t('engine:library.kpiArtifactsSub', {
              count: thisWeek.length,
            })}
            delay={40}
          />
          <KpiTile
            title={t('engine:library.kpiSessions')}
            icon={<Icon name="x-cowork" />}
            value={rows.length}
            sub={t('engine:library.kpiSessionsSub', { count: sessionCount })}
            delay={90}
          />
          <KpiTile
            title={t('engine:library.kpiDisk')}
            icon={<Icon name="x-disk" />}
            value={sized.length ? formatBytes(diskBytes) : '—'}
            sub={t('engine:library.kpiDiskSub')}
            delay={140}
          />
        </KpiRow>

        {rows.length === 0 ? (
          // Distinct: nothing made yet vs nothing matching the filter.
          <Frame data-testid="artifacts-empty">
            <FrameBody>
              <EmptyState
                icon={<Icon name="x-library" size={20} />}
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
            <div className="flex min-w-0 flex-wrap items-center gap-3 motion-safe:animate-rise-in [animation-delay:160ms]">
              <div className="-mx-1 max-w-full overflow-x-auto px-1 [scrollbar-width:none]">
                <Segmented<string>
                  className="w-[560px] min-w-[440px] max-w-none sm:max-w-full"
                  aria-label={t('common:artifactsFilterLabel')}
                  value={kind ?? 'all'}
                  onValueChange={(v) =>
                    setKind(v === 'all' ? null : (v as Kind))
                  }
                  options={[
                    { value: 'all', label: t('common:artifactsAll') },
                    ...kindsPresent.map((k) => ({
                      value: k,
                      label: t(KIND_LABEL[k]),
                    })),
                  ]}
                />
              </div>
              <span
                className="text-xs text-muted-foreground tabular-nums"
                aria-live="polite"
              >
                {t('common:artifactsCount', { count: shown.length })}
              </span>
            </div>

            <div
              ref={layoutRef}
              data-testid="library-layout"
              data-side-column={sideColumn || undefined}
              className={cn(
                'grid min-w-0 items-start gap-4',
                selected &&
                  sideColumn &&
                  'grid-cols-[minmax(0,1fr)_minmax(280px,330px)]'
              )}
            >
              <div className="min-w-0">
                {shown.length === 0 ? (
                  <EmptyState
                    icon={
                      <Icon
                        name={kind ? KIND_ICON[kind] : 'x-library'}
                        size={20}
                      />
                    }
                    title={t('common:artifactsNoMatch')}
                  />
                ) : (
                  <ul
                    className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,230px),1fr))] gap-4"
                    data-testid="artifacts-gallery"
                  >
                    {shown.slice(0, limit).map((row, i) => (
                      <LibraryCard
                        key={rowKey(row)}
                        row={row}
                        index={i}
                        selected={rowKey(row) === selectedKey}
                        onSelect={setSelectedKey}
                        onOpen={open}
                        onGoToSession={goToSession}
                        convertFileSrc={convertFileSrc}
                        typeText={typeLabel(row, htmlPage)}
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

              {selected && inspected && (
                <div
                  data-testid="artifact-inspector-slot"
                  className={cn(
                    'min-w-0',
                    sideColumn
                      ? 'sticky top-0'
                      : 'fixed inset-y-0 right-0 z-40 w-[min(360px,100%)] overflow-y-auto bg-background p-3 shadow-lift'
                  )}
                >
                  <ArtifactInspector
                    key={rowKey(inspected)}
                    row={inspected}
                    typeText={typeLabel(inspected, htmlPage)}
                    onClose={() => setSelectedKey(null)}
                    onOpen={() => open(inspected)}
                    onGoToSession={() => goToSession(inspected)}
                    convertFileSrc={convertFileSrc}
                    openPath={(p) =>
                      void serviceHub
                        .opener()
                        .openPath(p, inspected.root ? [inspected.root] : [])
                    }
                    revealItemInDir={(p) =>
                      void serviceHub
                        .opener()
                        .revealItemInDir(p, inspected.root ? [inspected.root] : [])
                    }
                  />
                </div>
              )}
            </div>
          </>
        )}
      </EnginePage>
      {viewing?.kind === 'image' && (
        <ImageViewer
          images={[{ url: convertFileSrc(viewing.path), name: `studio-${viewing.recipe.seed}` }]}
          index={0}
          onIndexChange={() => {}}
          onClose={() => setViewing(null)}
        />
      )}
      <VideoDialog
        item={viewing?.kind === 'video' ? viewing : null}
        onClose={() => setViewing(null)}
      />
    </div>
  )
}

/** The design's `.thumb` surface: a hairline box on the code background. */
const THUMB =
  'relative flex flex-col gap-1.5 overflow-hidden rounded-lg bg-code-bg p-3 shadow-[inset_0_0_0_0.8px_var(--border)] motion-safe:after:absolute motion-safe:after:inset-0 motion-safe:after:[animation:sheen_1.4s_var(--expo)_.4s_both] motion-safe:after:bg-[linear-gradient(105deg,transparent_35%,rgba(255,255,255,.35)_50%,transparent_65%)] dark:motion-safe:after:bg-[linear-gradient(105deg,transparent_35%,rgba(255,255,255,.07)_50%,transparent_65%)] motion-safe:after:content-[""]'

/**
 * A preview-shaped placeholder per kind (the design's `.thumb`): code lines,
 * a document, a chart for pages, a waveform for audio. A real image is shown
 * when the file is one the browser renders on its own.
 */
/** True once the element has come near the viewport (and stays true). */
function useSeen<T extends Element>(enabled: boolean) {
  const ref = useRef<T | null>(null)
  const [seen, setSeen] = useState(
    () => !enabled || typeof IntersectionObserver === 'undefined'
  )
  useEffect(() => {
    if (seen || !ref.current) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true)
          observer.disconnect()
        }
      },
      { rootMargin: '200px' }
    )
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [seen])
  return [ref, seen] as const
}

/**
 * The first lines of a text, Markdown, code or HTML file, read (a few KB at
 * most, cached) once the card is on screen.
 */
function usePreviewLines(
  url: string | null | undefined,
  path: string,
  active: boolean
) {
  const [lines, setLines] = useState<PreviewLine[] | null>(null)
  const kind = previewKindFor(path)
  useEffect(() => {
    if (!url || !active) return
    if (kind !== 'markdown' && kind !== 'text' && kind !== 'html') return
    let alive = true
    void loadPreviewText(url).then((text) => {
      if (!alive || text == null) return
      setLines(
        kind === 'markdown'
          ? markdownLines(text)
          : kind === 'html'
            ? htmlLines(text)
            : textLines(text)
      )
    })
    return () => {
      alive = false
    }
  }, [url, active, kind])
  return lines
}

/** An audio or video file's length, read from its metadata once on screen. */
function useMediaDuration(url: string | null | undefined, active: boolean) {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    if (!url || !active || typeof Audio === 'undefined') return
    const media = new Audio()
    media.preload = 'metadata'
    const done = () => setSeconds(media.duration)
    media.addEventListener('loadedmetadata', done)
    media.src = url
    return () => {
      media.removeEventListener('loadedmetadata', done)
      media.src = ''
    }
  }, [url, active])
  return seconds
}

function ArtifactThumb(props: {
  row: Row
  src?: string | null
  url?: string | null
  lazy?: boolean
  big?: boolean
}) {
  const [ref, seen] = useSeen<HTMLDivElement>(Boolean(props.lazy))
  return (
    <div ref={ref}>
      <ThumbBody {...props} seen={seen} />
    </div>
  )
}

function ThumbBody({
  row,
  src,
  url,
  seen,
  big = false,
}: {
  seen: boolean
  row: Row
  src?: string | null
  /** The file itself, for reading a text preview or media length. */
  url?: string | null
  /** Wait until the card is on screen before reading anything. */
  lazy?: boolean
  big?: boolean
}) {
  const [broken, setBroken] = useState(false)
  const lines = usePreviewLines(url, row.path, seen && !src)
  const media = row.kind === 'audio' || row.kind === 'video'
  const duration = useMediaDuration(media ? url : null, seen)
  const base = cn(THUMB, big ? 'h-[170px]' : 'h-[118px]')
  const line = 'block h-1.5 shrink-0 rounded-[9px]'
  if (lines && lines.length > 0 && !(src && !broken)) {
    const mono = row.kind === 'code'
    return (
      <div
        data-testid="artifact-thumb-text"
        className={cn(
          base,
          'gap-0.5 [mask-image:linear-gradient(to_bottom,#000_65%,transparent)] motion-safe:after:hidden'
        )}
      >
        {lines.map((l, i) => (
          <p
            key={i}
            className={cn(
              'shrink-0 truncate text-[10.5px] leading-[15px] text-fg-2',
              mono && 'font-mono text-[10px]',
              l.heading && 'text-[11.5px] font-semibold text-foreground'
            )}
          >
            {l.text}
          </p>
        ))}
      </div>
    )
  }
  if (media && url) {
    return (
      <div
        data-testid="artifact-thumb-media"
        className={cn(base, 'items-center justify-center gap-2')}
      >
        <span className="flex size-9 items-center justify-center rounded-full bg-muted text-foreground">
          <Icon name="x-play" size={16} />
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatDuration(duration) || ' '}
        </span>
      </div>
    )
  }
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
  if (row.kind === 'code') {
    return (
      <div className={cn(base, 'bg-[#1f2937]')}>
        {[
          ['w-[30%]', 'bg-[#6366f1] opacity-70'],
          ['w-[70%]', 'bg-[#374151]'],
          ['w-1/2', 'bg-[#10b981] opacity-60'],
          ['w-[82%]', 'bg-[#374151]'],
          ['w-[22%]', 'bg-[#6366f1] opacity-70'],
          ['w-[60%]', 'bg-[#374151]'],
        ].map(([w, c], i) => (
          <i key={i} className={cn(line, w, c)} />
        ))}
      </div>
    )
  }
  if (row.kind === 'page') {
    // A page: a heading, a line, and a small bar chart.
    return (
      <div className={base}>
        <i className={cn(line, 'h-[9px] w-[55%] bg-sk-2')} />
        <i className={cn(line, 'w-[60%] bg-sk')} />
        <div className="mt-auto flex h-[60px] items-end gap-[5px]">
          {[40, 70, 55, 90, 65, 80].map((h, j) => (
            <span
              key={j}
              style={{ height: `${h}%`, animationDelay: `${j * 50}ms` }}
              className={cn(
                'flex-1 origin-bottom rounded-t-[4px] rounded-b-[2px] motion-safe:animate-grow-y',
                j === 3
                  ? 'bg-grad'
                  : 'bg-[linear-gradient(var(--bar),var(--bar-2))] shadow-[inset_0_0_0_0.5px_var(--bar-border)]'
              )}
            />
          ))}
        </div>
      </div>
    )
  }
  if (row.kind === 'audio' || row.kind === 'video') {
    return (
      <div className={cn(base, 'flex-row items-center gap-[3px] p-4')}>
        {Array.from({ length: 36 }, (_, i) => (
          <span
            key={i}
            style={{
              height: `${20 + Math.abs(Math.sin(i * 1.7)) * 70}%`,
              animationDelay: `${(i % 3) * 0.2}s`,
            }}
            className={cn(
              'flex-1 rounded-[2px] motion-safe:animate-wave-bar',
              i >= 9 && i < 14
                ? 'bg-grad'
                : 'bg-[linear-gradient(var(--sk2),var(--sk))]'
            )}
          />
        ))}
      </div>
    )
  }
  if (row.kind === 'image') {
    return (
      <div className={cn(base, 'block p-0')}>
        <svg
          viewBox="0 0 120 60"
          preserveAspectRatio="none"
          className="size-full"
          aria-hidden
        >
          <path
            d="M0 50 20 38 40 42 60 20 80 28 100 12 120 16V60H0Z"
            fill="var(--sk2)"
          />
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
    <div className={base}>
      <i className={cn(line, 'h-[9px] w-[55%] bg-sk-2')} />
      {['w-[92%]', 'w-[84%]', 'w-[88%]', 'w-[60%]', 'w-[76%]'].map((w, i) => (
        <i key={i} className={cn(line, w, 'bg-sk')} />
      ))}
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
/**
 * The card's outline states, on the frame body: a hairline ring on hover and
 * on keyboard focus of the card's select button, a primary ring when selected.
 * Transitions are colour/shadow only, so a click paints on the next frame.
 */
const CARD_RING = [
  '[&>[data-slot=frame-body]]:transition-shadow [&>[data-slot=frame-body]]:duration-150',
  'hover:[&>[data-slot=frame-body]]:shadow-[0_0_0_1px_var(--ring),var(--lift)]',
  'has-[[data-testid=artifact-row]:focus-visible]:[&>[data-slot=frame-body]]:shadow-[0_0_0_2px_var(--ring)]',
].join(' ')
const CARD_SELECTED =
  '[&>[data-slot=frame-body]]:shadow-[0_0_0_1.5px_var(--primary),var(--lift)] hover:[&>[data-slot=frame-body]]:shadow-[0_0_0_1.5px_var(--primary),var(--lift)]'

const LibraryCard = memo(function LibraryCard({
  row,
  index,
  selected,
  onSelect,
  onOpen,
  onGoToSession,
  convertFileSrc,
  typeText,
}: {
  row: Row
  index: number
  selected: boolean
  onSelect: (key: string) => void
  onOpen: (row: Row) => void
  onGoToSession: (row: Row) => void
  convertFileSrc: (path: string) => string
  typeText: string
}) {
  const { t } = useTranslation()
  // #183: a row whose path never resolved inside its session root has nothing
  // to preview; the double-click and Open button are gated the same way as
  // the inspector's Open Preview.
  const abs = row.root ? resolveInRoot(row.root, row.path) : null
  const canOpen = Boolean(abs)
  const url = useMemo(
    () => (abs ? convertFileSrc(abs) : null),
    [abs, convertFileSrc]
  )
  return (
    <li data-testid="artifact-card" className="min-w-0">
      <Frame
        style={{ animationDelay: `${40 + index * 35}ms` }}
        data-selected={selected || undefined}
        className={cn(
          'group h-full cursor-pointer motion-safe:animate-rise-in',
          CARD_RING,
          selected && CARD_SELECTED
        )}
      >
        <FrameHeader
          icon={<Icon name={KIND_ICON[row.kind]} />}
          title={<span title={row.title}>{row.title}</span>}
          actions={
            <Button
              variant="ghost"
              size="icon-sm"
              className="relative z-10 pointer-coarse:size-11"
              onClick={() => onOpen(row)}
              disabled={!canOpen}
              title={t('common:artifactOpenPreview')}
              aria-label={`${t('common:artifactOpenPreview')}: ${row.title}`}
              data-testid="artifact-open"
            >
              <Eye />
            </Button>
          }
        />
        <FrameBody className="gap-3 p-3.5">
          <button
            type="button"
            onClick={() => onSelect(rowKey(row))}
            onDoubleClick={canOpen ? () => onOpen(row) : undefined}
            aria-current={selected || undefined}
            aria-label={t('common:artifactShowDetails', { name: row.title })}
            data-testid="artifact-row"
            className="absolute inset-0 z-0 cursor-pointer rounded-xl outline-none"
          />
          <div className="pointer-events-none">
            <ArtifactThumb
              row={row}
              src={thumbSrc(row, convertFileSrc)}
              url={url}
              lazy
            />
          </div>
          <div className="pointer-events-none flex items-center justify-between gap-2 text-xs text-subtle-foreground">
            <span className="truncate">{typeText}</span>
            <span className="shrink-0 tabular-nums">
              {formatShort(row.updated)}
            </span>
          </div>
          <div className="flex min-w-0 items-center text-xs text-subtle-foreground">
            <button
              type="button"
              onClick={() => onGoToSession(row)}
              title={t('common:artifactGoToSession')}
              aria-label={`${t('common:artifactGoToSession')}: ${row.sessionTitle}`}
              data-testid="artifact-go-to-session"
              className="relative z-10 flex min-w-0 items-center gap-[5px] rounded-md text-left hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:min-h-11"
            >
              <Icon name="flow" size={12} />
              <span className="truncate">{row.sessionTitle}</span>
            </button>
          </div>
        </FrameBody>
      </Frame>
    </li>
  )
})

function ArtifactInspector({
  row,
  typeText,
  onClose,
  onOpen,
  onGoToSession,
  convertFileSrc,
  openPath,
  revealItemInDir,
}: {
  row: Row
  typeText: string
  onClose: () => void
  onOpen: () => void
  onGoToSession: () => void
  convertFileSrc: (path: string) => string
  openPath: (path: string) => void
  revealItemInDir: (path: string) => void
}) {
  const { t } = useTranslation()
  const kind = previewKindFor(row.path)
  const abs = row.root ? resolveInRoot(row.root, row.path) : null
  const missing = useFileExists(abs) === false
  // A real thumbnail only where the browser renders the file on its own; HTML
  // would need executing the page.
  const thumb =
    abs && !missing && (kind === 'image' || kind === 'svg')
      ? convertFileSrc(abs)
      : null
  const project = row.folder
    ? folderName(row.folder)
    : t('common:artifactSandbox')
  const updated = formatUpdated(row.updated)

  return (
    <Frame
      aria-label={t('common:artifactDetails')}
      data-testid="artifact-inspector"
    >
      <FrameHeader
        icon={<Icon name={KIND_ICON[row.kind]} />}
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
      <FrameBody className="gap-3 p-3.5">
        <ArtifactThumb
          row={row}
          src={thumb}
          url={abs && !missing ? convertFileSrc(abs) : null}
          big
        />
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

        <dl className="grid grid-cols-[140px_minmax(0,1fr)] items-baseline gap-x-3.5 gap-y-1.5 text-[12.5px] lg:grid-cols-[96px_minmax(0,1fr)]">
          <dt className="text-muted-foreground">{t('common:artifactType')}</dt>
          <dd className="min-w-0 truncate text-foreground">{typeText}</dd>
          <dt className="text-muted-foreground">
            {t('common:artifactProject')}
          </dt>
          <dd
            className="min-w-0 truncate text-foreground"
            title={row.folder ?? project}
          >
            {project}
          </dd>
          <dt className="text-muted-foreground">{t('common:artifactPath')}</dt>
          <dd
            className="min-w-0 font-mono text-xs break-all text-fg-2"
            title={row.path}
          >
            {row.path}
          </dd>
          {updated && (
            <>
              <dt className="text-muted-foreground">
                {t('common:artifactUpdated')}
              </dt>
              <dd className="min-w-0 truncate text-foreground tabular-nums">
                {formatShort(row.updated)}
              </dd>
            </>
          )}
        </dl>

        {/* Where it came from, and the way back there. */}
        <section
          aria-label={t('common:artifactSource')}
          className="flex flex-col gap-1.5 border-b border-dashed border-border py-2.5"
        >
          <div className="flex min-w-0 flex-col gap-0.5">
            <b
              className="truncate text-[13px] font-medium text-foreground"
              title={row.sessionTitle}
            >
              {row.sessionTitle}
            </b>
            <small className="text-xs text-muted-foreground">
              {row.studio ? 'Studio' : t('common:artifactCoworkSession')}
              {updated ? ` · ${updated}` : ''}
            </small>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="w-full pointer-coarse:h-11"
            onClick={onGoToSession}
            data-testid="artifact-inspector-go-to-session"
          >
            {t('common:artifactGoToSession')}
          </Button>
        </section>

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            className="pointer-coarse:h-11"
            onClick={onOpen}
            // Same precondition as the external/folder actions: a path that
            // never resolved inside the session root cannot be previewed.
            disabled={!abs || missing}
            data-testid="artifact-inspector-open"
          >
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
                {t('common:artifactOpenExternal')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="pointer-coarse:h-11"
                onClick={() => revealItemInDir(abs)}
              >
                {t('common:artifactShowInFolder')}
              </Button>
            </>
          )}
        </div>
      </FrameBody>
    </Frame>
  )
}
