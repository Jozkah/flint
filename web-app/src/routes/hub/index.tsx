 
import { isServedByFlint } from '@/lib/platform/utils'
import { DesktopOnlyPage } from '@/containers/DesktopOnlyPage'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  FileCode2,
  Heart,
  LoaderCircle,
  LockKeyhole,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { Switch } from '@/components/ui/switch'
import { Chip } from '@/components/ui/chip'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { HuggingFaceAvatar } from '@/containers/HuggingFaceAvatar'
import { Segmented } from '@/components/ui/segmented'
import { HuggingFaceLogo } from '@/components/icons/HuggingFaceLogo'
import { HubVariantList } from '@/containers/HubVariantList'
import { HubTaskChips } from '@/containers/HubTaskChips'
import { matchesTask, type HubTaskId } from '@/lib/hubTasks'
import { formatShortDate } from '@/lib/localeDate'
import { useServiceHub } from '@/hooks/useServiceHub'
import { StudioDiscover } from '@/containers/studio/StudioDiscover'
import { cn } from '@/lib/utils'
import { useSpotlight } from '@/hooks/useSpotlight'
import { DialogDeleteAllModels } from '@/containers/dialogs/DeleteAllModels'
import { HuggingFaceDownloadAction } from '@/containers/HuggingFaceDownloadAction'
import { PausedDownloads } from '@/containers/PausedDownloads'
import { route } from '@/constants/routes'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useFitContext } from '@/hooks/useFitContext'
import { useModelProvider } from '@/hooks/useModelProvider'
import { modelIdKey } from '@/lib/modelIdPath'
import { pinQueryMatches } from '@/lib/huggingfaceSearch'
import {
  cleanHuggingFaceRepo,
  pinExactRepo,
  explainQuantization,
  formatModelBytes,
  getHuggingFaceFiles,
  groupHuggingFaceFiles,
  inferArchitecture,
  inferModalities,
  inferParameterCount,
  mlxWeightsBytes,
  repoLooksMlx,
  searchHuggingFaceModelsByWords,
  type HuggingFaceFile,
  type HuggingFaceFormat,
  type HuggingFaceModel,
} from '@/lib/huggingface'
import {
  bestGroup,
  fitBasis,
  fitOfGroup,
  loadRepoArchitecture,
  repoFit,
  repoFitsHardware,
  type FitContext,
  type GroupFit,
} from '@/lib/huggingfaceFit'
import {
  type FitVerdict,
  type KvArchitecture,
} from '@/lib/modelCompatibility'
import { Select } from '@/components/ui/select'

export const Route = createFileRoute(route.hub.index)({
  // Everything here is the desktop app's; a browser gets one line instead.
  component: () =>
    isServedByFlint() ? <DesktopOnlyTitle /> : <ModelDiscoverRoute />,
})

type SortMode = 'downloads' | 'likes' | 'updated' | 'newest'
type ParamFilter = 'all' | 'tiny' | 'small' | 'medium' | 'large'

// How many repos one Hugging Face search returns; the Hub caps a page at 1000.
const RESULT_LIMITS = [50, 100, 200, 500, 1000]
const RESULT_LIMIT_KEY = 'flint-hub-result-limit'

function readResultLimit(): number {
  try {
    const saved = Number(localStorage.getItem(RESULT_LIMIT_KEY))
    if (RESULT_LIMITS.includes(saved)) return saved
  } catch {
    // Storage unavailable; use the default.
  }
  return RESULT_LIMITS[0]
}

function inParameterBucket(value: number | null, bucket: ParamFilter): boolean {
  if (bucket === 'all') return true
  if (value == null) return false
  if (bucket === 'tiny') return value < 3
  if (bucket === 'small') return value >= 3 && value < 8
  if (bucket === 'medium') return value >= 8 && value < 34
  return value >= 34
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

function fitLabel(verdict: FitVerdict, t: (key: string) => string): string {
  if (verdict === 'fits') return t('sweep:hub.fitsInMemory')
  if (verdict === 'fits-partial-offload') return t('sweep:hub.partialOffload')
  if (verdict === 'tight') return t('sweep:hub.tightFit')
  if (verdict === 'exceeds') return t('sweep:hub.mayExceed')
  return t('sweep:hub.fitUnknown')
}

function fitTone(verdict: FitVerdict): 'ok' | 'warn' | 'err' | 'neutral' {
  if (verdict === 'fits') return 'ok'
  if (verdict === 'fits-partial-offload' || verdict === 'tight') return 'warn'
  if (verdict === 'exceeds') return 'err'
  return 'neutral'
}

const SELECT =
  'h-8 cursor-pointer rounded-lg border-[0.8px] border-border bg-card px-2 text-foreground transition-colors hover:border-border-strong'

function ModelDiscoverRoute() {
  const { t, i18n } = useTranslation()
  const spotlight = useSpotlight()
  const serviceHub = useServiceHub()
  const navigate = useNavigate()
  const token = useGeneralSetting((state) => state.huggingfaceToken)
  const { hardware, devices } = useFitContext()
  const providers = useModelProvider((state) => state.providers)
  const parentRef = useRef<HTMLDivElement>(null)

  const narrow = useMediaQuery('(max-width: 639px)')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [models, setModels] = useState<HuggingFaceModel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sort, setSort] = useState<SortMode>('downloads')
  const [resultLimit, setResultLimit] = useState(readResultLimit)
  const [params, setParams] = useState<ParamFilter>('all')
  const [architecture, setArchitecture] = useState('all')
  const [task, setTask] = useState<HubTaskId>('all')
  const [format, setFormat] = useState<HuggingFaceFormat>(
    IS_MACOS ? 'all' : 'gguf'
  )
  // What is being looked for: models that chat, or models that make pictures.
  const [source, setSource] = useState<'models' | 'studio'>('models')
  const [includeGated, setIncludeGated] = useState(true)
  const [downloadedOnly, setDownloadedOnly] = useState(false)
  // Hide repos whose best variant is larger than this machine's memory.
  const [fitsOnly, setFitsOnly] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [filesByRepo, setFilesByRepo] = useState<
    Record<string, HuggingFaceFile[]>
  >({})
  const [loadingFiles, setLoadingFiles] = useState<Record<string, boolean>>({})
  const [archByRepo, setArchByRepo] = useState<
    Record<string, KvArchitecture | null>
  >({})

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(cleanHuggingFaceRepo(query))
    }, 300)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    // Picture models have their own search (StudioDiscover).
    if (source === 'studio') {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)

    const run = async () => {
      try {
        let result: HuggingFaceModel[]
        if (format === 'all' && IS_MACOS) {
          const [gguf, mlx] = await Promise.all([
            searchHuggingFaceModelsByWords(debouncedQuery, token, 'gguf', resultLimit),
            searchHuggingFaceModelsByWords(debouncedQuery, token, 'mlx', resultLimit),
          ])
          const byId = new Map<string, HuggingFaceModel>()
          for (const model of [...gguf, ...mlx]) byId.set(model.id, model)
          result = [...byId.values()]
        } else {
          result = await searchHuggingFaceModelsByWords(
            debouncedQuery,
            token,
            format,
            resultLimit
          )
        }
        if (cancelled) return
        setModels(result)
        setFilesByRepo((current) => {
          const next = { ...current }
          for (const model of result) {
            if (model.files?.length) next[model.id] = model.files
          }
          return next
        })
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [debouncedQuery, token, format, source, resultLimit])

  const installedIds = useMemo(() => {
    const ids = new Set<string>()
    for (const provider of providers) {
      if (provider.provider !== 'llamacpp' && provider.provider !== 'mlx') continue
      for (const model of provider.models ?? []) {
        ids.add(`${provider.provider}:${modelIdKey(model.id)}`)
      }
    }
    return ids
  }, [providers])

  const repoInstalled = (model: HuggingFaceModel) => {
    if (repoLooksMlx(model)) return installedIds.has(`mlx:${model.id}`)
    for (const id of installedIds) {
      if (id.startsWith(`llamacpp:${model.id}/`)) return true
    }
    return false
  }

  // The downloaded models of one repo, as a provider slice the delete dialog
  // can act on. Null when nothing from it is on disk (or only imported files).
  const installedSlice = (model: HuggingFaceModel): ModelProvider | null => {
    const mlx = repoLooksMlx(model)
    const owner = providers.find((p) => p.provider === (mlx ? 'mlx' : 'llamacpp'))
    if (!owner) return null
    const models = (owner.models ?? []).filter(
      (m) =>
        !m.imported &&
        (mlx ? m.id === model.id : modelIdKey(m.id).startsWith(`${model.id}/`))
    )
    return models.length ? { ...owner, models } : null
  }

  const architectures = useMemo(
    () =>
      [
        ...new Set(
          models
            .map(inferArchitecture)
            .filter((value): value is string => Boolean(value))
        ),
      ].sort(),
    [models]
  )

  // Installed repos the search did not return (the default list is the top
  // downloads), so the Downloaded filter shows everything on disk.
  const installedStubs = useMemo(() => {
    if (!downloadedOnly) return [] as HuggingFaceModel[]
    const listed = new Set(models.map((model) => model.id))
    const stubs = new Map<string, HuggingFaceModel>()
    for (const id of installedIds) {
      const mlx = id.startsWith('mlx:')
      const parts = id.slice(id.indexOf(':') + 1).split('/')
      if (parts.length < (mlx ? 2 : 3)) continue
      const repo = `${parts[0]}/${parts[1]}`
      if (listed.has(repo) || stubs.has(repo)) continue
      stubs.set(repo, {
        id: repo,
        author: parts[0],
        downloads: 0,
        likes: 0,
        gated: false,
        tags: [mlx ? 'mlx' : 'gguf'],
        files: [],
      })
    }
    return [...stubs.values()]
  }, [downloadedOnly, installedIds, models])

  const visible = useMemo(() => {
    const filtered = [...models, ...installedStubs].filter((model) => {
      const parameterCount = inferParameterCount(model)
      const arch = inferArchitecture(model)
      const files = filesByRepo[model.id] ?? model.files ?? []
      return (
        inParameterBucket(parameterCount, params) &&
        (architecture === 'all' || arch === architecture) &&
        matchesTask(model, files, task) &&
        (includeGated || !model.gated) &&
        (!downloadedOnly || repoInstalled(model)) &&
        (!fitsOnly ||
          repoFitsHardware(
            repoFit(model, files, {
              hardware,
              devices,
              architecture: archByRepo[model.id],
              parameterBillions: parameterCount,
            })
          ))
      )
    })

    const sorted = filtered.sort((a, b) => {
      if (sort === 'likes') return b.likes - a.likes
      if (sort === 'updated') {
        return Date.parse(b.lastModified ?? '') - Date.parse(a.lastModified ?? '')
      }
      if (sort === 'newest') {
        return Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? '')
      }
      return b.downloads - a.downloads
    })
    // A pasted exact repo id comes first, whatever the sort says.
    return pinExactRepo(pinQueryMatches(sorted, debouncedQuery), debouncedQuery)
  }, [
    debouncedQuery,
    models,
    params,
    architecture,
    task,
    includeGated,
    downloadedOnly,
    fitsOnly,
    hardware,
    devices,
    archByRepo,
    sort,
    filesByRepo,
    installedIds,
    installedStubs,
  ])

  const loadFiles = async (repo: string) => {
    if (filesByRepo[repo]?.length || loadingFiles[repo]) {
      return filesByRepo[repo] ?? []
    }
    setLoadingFiles((state) => ({ ...state, [repo]: true }))
    try {
      const files = await getHuggingFaceFiles(repo, token)
      setFilesByRepo((state) => ({ ...state, [repo]: files }))
      return files
    } finally {
      setLoadingFiles((state) => ({ ...state, [repo]: false }))
    }
  }

  const toggleExpanded = async (repo: string) => {
    const opening = !expanded[repo]
    // One card open at a time, so long variant lists never stack.
    setExpanded(opening ? { [repo]: true } : {})
    if (!opening) return
    const index = visible.findIndex((m) => m.id === repo)
    if (index >= 0) {
      window.setTimeout(
        () => rowVirtualizer.scrollToIndex(index, { align: 'auto' }),
        60
      )
    }
    const files = await loadFiles(repo).catch(() => [] as HuggingFaceFile[])
    // The model's own header gives its context memory exactly; until it
    // arrives (or if it cannot be read) the estimate stands.
    const architecture = await loadRepoArchitecture(
      repo,
      groupHuggingFaceFiles(files),
      token
    )
    setArchByRepo((state) => ({ ...state, [repo]: architecture }))
  }

  const rowVirtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => parentRef.current,
    // Rows are keyed by repo id; an index key lets a reordered list stop
    // observing a card, so its expanded variants never push the next one down.
    getItemKey: (index) => visible[index]?.id ?? index,
    estimateSize: (index) => {
      const model = visible[index]
      const files = filesByRepo[model?.id] ?? model?.files ?? []
      const groupCount = groupHuggingFaceFiles(files).filter(
        (group) => group.kind === 'model'
      ).length
      return expanded[model?.id] ? 150 + Math.min(groupCount, 20) * 64 : 150
    },
    overscan: 6,
    measureElement: (element) => element.getBoundingClientRect().height,
  })

  const openModel = (model: HuggingFaceModel) => {
    const repo = cleanHuggingFaceRepo(model.id)
    navigate({
      to: route.hub.model,
      params: { modelId: repo.split('/').pop() || repo },
      search: { repo },
    })
  }

  const filtersActive =
    params !== 'all' ||
    architecture !== 'all' ||
    task !== 'all' ||
    downloadedOnly ||
    fitsOnly ||
    !includeGated
  const clearFilters = () => {
    setParams('all')
    setArchitecture('all')
    setTask('all')
    setDownloadedOnly(false)
    setFitsOnly(false)
    setIncludeGated(true)
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border bg-[radial-gradient(120%_140%_at_0%_0%,var(--accent)_0%,transparent_55%)] px-5 pt-5 pb-4">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3.5">
              <HuggingFaceLogo size={42} className="shrink-0 self-center" />
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[length:calc(var(--ui-font-base)*0.6875)] font-medium tracking-[0.14em] text-muted-foreground uppercase">
                  Hugging Face
                  <Chip tone="ok" dot className="tracking-normal normal-case">
                    <ShieldCheck /> {t('sweep:hub.privateUntilUsed')}
                  </Chip>
                </div>
                <h1 className="mt-1 text-2xl leading-tight font-medium tracking-[-0.01em]">
                  {source === 'studio' ? t('sweep:hub.discoverImage') : t('sweep:hub.discoverLocal')}
                </h1>
                <p className="mt-1 hidden max-w-2xl text-[length:calc(var(--ui-font-base)*0.8125)] text-secondary-foreground [@media(min-height:700px)]:block">
                  {t('sweep:hub.intro')}
                </p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={() =>
                void serviceHub.opener().openUrl('https://huggingface.co/models')
              }
            >
              {t('sweep:hub.openHuggingFace')} <ExternalLink className="size-3.5" />
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Segmented<'models' | 'studio'>
              aria-label={t('sweep:hub.whatToLookFor')}
              className="min-w-[260px]"
              options={[
                { value: 'models', label: t('sweep:hub.chatModels') },
                { value: 'studio', label: t('sweep:hub.images') },
              ]}
              value={source}
              onValueChange={setSource}
            />
          <div className="relative min-w-[240px] flex-1">
            {loading ? (
              <LoaderCircle className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
            ) : (
              <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            )}
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t(
                narrow ? 'sweep:hub.searchPlaceholderShort' : 'sweep:hub.searchPlaceholder'
              )}
              className="h-12 rounded-xl pr-10 pl-11 text-[length:calc(var(--ui-font-base)*0.875)] text-ellipsis shadow-lift"
              data-testid="hub-search"
            />
            {query && (
              <button
                type="button"
                aria-label={t('sweep:hub.clearSearch')}
                onClick={() => setQuery('')}
                className="absolute top-1/2 right-3 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded-md text-muted-foreground before:absolute before:-inset-2 hover:bg-accent hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>

          </div>

          {source === 'models' && (
          // Phones: one row that scrolls sideways, not four rows of chips.
          <div className="-mx-4 flex flex-nowrap items-center gap-2 overflow-x-auto px-4 pb-0.5 text-xs [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&>*]:shrink-0">
            <HubTaskChips value={task} onChange={setTask} />
            <span aria-hidden className="mx-1 h-5 w-px bg-border" />
            {IS_MACOS && (
              <Select
                value={format}
                onChange={(event) =>
                  setFormat(event.target.value as HuggingFaceFormat)
                }
                className={SELECT}
                aria-label={t('sweep:hub.format')}
              >
                <option value="all">GGUF + MLX</option>
                <option value="gguf">GGUF</option>
                <option value="mlx">MLX</option>
              </Select>
            )}
            <Select
              value={params}
              onChange={(event) => setParams(event.target.value as ParamFilter)}
              className={SELECT}
              aria-label={t('sweep:hub.parameterSize')}
            >
              <option value="all">{t('sweep:hub.anyParameterSize')}</option>
              <option value="tiny">{t('sweep:hub.under3b')}</option>
              <option value="small">3B–8B</option>
              <option value="medium">8B–34B</option>
              <option value="large">34B+</option>
            </Select>
            <Select
              value={architecture}
              onChange={(event) => setArchitecture(event.target.value)}
              className={SELECT}
              aria-label={t('sweep:hub.architecture')}
            >
              <option value="all">{t('sweep:hub.anyArchitecture')}</option>
              {architectures.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </div>
          )}
        </div>
      </header>

      {source === 'studio' ? (
        <StudioDiscover query={debouncedQuery} token={token} />
      ) : (
      <main ref={parentRef} className="-mr-3 min-h-0 flex-1 overflow-y-auto py-4 pr-8 pl-5">
        <div className="mx-auto w-full max-w-6xl">
          <PausedDownloads />
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span aria-live="polite">
              {loading
                ? t('sweep:hub.searching')
                : t('sweep:hub.modelCount', { count: visible.length })}
              {filtersActive && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="ml-2 cursor-pointer underline underline-offset-2 hover:text-foreground"
                >
                  {t('sweep:hub.clearFilters')}
                </button>
              )}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-lg border-[0.8px] border-border bg-card px-2.5 text-secondary-foreground">
                <Switch
                  checked={downloadedOnly}
                  onCheckedChange={setDownloadedOnly}
                />
                {t('sweep:hub.downloaded')}
              </label>
              <label
                className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-lg border-[0.8px] border-border bg-card px-2.5 text-secondary-foreground"
                title={t('sweep:hub.fitsTitle')}
              >
                <Switch
                  checked={fitsOnly}
                  onCheckedChange={setFitsOnly}
                  aria-label={t('sweep:hub.onlyFit')}
                />
                {t('sweep:hub.fitsMyHardware')}
              </label>
              <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-lg border-[0.8px] border-border bg-card px-2.5 text-secondary-foreground">
                <Switch checked={includeGated} onCheckedChange={setIncludeGated} />
                <LockKeyhole className="size-3.5" /> {t('sweep:hub.gated')}
              </label>
            <label className="inline-flex items-center gap-2">
              {t('sweep:hub.sortBy')}
              <Select
                value={sort}
                onChange={(event) => setSort(event.target.value as SortMode)}
                className={SELECT}
                aria-label={t('sweep:hub.sort')}
              >
                <option value="downloads">{t('sweep:hub.mostDownloaded')}</option>
                <option value="likes">{t('sweep:hub.mostLiked')}</option>
                <option value="updated">{t('sweep:hub.recentlyUpdated')}</option>
                <option value="newest">{t('sweep:hub.newest')}</option>
              </Select>
            </label>
            <label className="inline-flex items-center gap-2">
              {t('sweep:hub.resultLimit')}
              <Select
                value={String(resultLimit)}
                onChange={(event) => {
                  const next = Number(event.target.value)
                  setResultLimit(next)
                  try {
                    localStorage.setItem(RESULT_LIMIT_KEY, String(next))
                  } catch {
                    // Not saved; the choice still applies until restart.
                  }
                }}
                className={SELECT}
                aria-label={t('sweep:hub.resultLimit')}
              >
                {RESULT_LIMITS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </label>
            </div>
          </div>

          {error && (
            <div className="mb-4 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {loading && models.length === 0 && (
            <div className="space-y-3" aria-hidden>
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="flex gap-3.5 rounded-2xl border-[0.8px] border-border bg-card p-4"
                >
                  <Skeleton className="size-11 rounded-xl" />
                  <div className="flex-1 space-y-2.5">
                    <Skeleton className="h-4 w-1/3" />
                    <Skeleton className="h-3 w-2/3" />
                    <Skeleton className="h-8 w-full rounded-lg" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loading && !error && visible.length === 0 && (
            <EmptyState
              icon={<Search />}
              title={t('sweep:hub.noMatching')}
              description={t('sweep:hub.noMatchingHint')}
              action={
                filtersActive ? (
                  <Button variant="outline" size="sm" onClick={clearFilters}>
                    {t('sweep:hub.clearFilters')}
                  </Button>
                ) : undefined
              }
              className="min-h-72 rounded-2xl border border-dashed border-border"
            />
          )}

          {visible.length > 0 && (
            <div
              className="relative w-full"
              style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualItem) => {
                const model = visible[virtualItem.index]
                const files = filesByRepo[model.id] ?? model.files ?? []
                const groups = groupHuggingFaceFiles(files)
                const variants = groups.filter((group) => group.kind === 'model')
                const parameterCount = inferParameterCount(model)
                const fitContext: FitContext = {
                  hardware,
                  devices,
                  architecture: archByRepo[model.id],
                  parameterBillions: parameterCount,
                }
                const recommended = bestGroup(groups, fitContext)
                const isMlx = repoLooksMlx(model)
                const mlxBytes = isMlx ? mlxWeightsBytes(files) : null
                const recommendedFit: GroupFit | null = repoFit(
                  model,
                  files,
                  fitContext
                )
                const modalities = inferModalities(model, files)
                const opened = Boolean(expanded[model.id])
                const installed = repoInstalled(model)
                const hasTools = model.tags.some((tag) =>
                  /tool|function-call/i.test(tag)
                )
                const hasVision = modalities.some(
                  (value) => value === 'vision' || value === 'multimodal'
                )
                const [author, ...rest] = model.id.split('/')
                const name = rest.join('/') || author
                const updated = formatShortDate(model.lastModified, i18n.language)

                return (
                  <article
                    key={model.id}
                    ref={rowVirtualizer.measureElement}
                    data-index={virtualItem.index}
                    className="absolute left-0 top-0 w-full pb-3"
                    style={{ transform: `translateY(${virtualItem.start}px)` }}
                  >
                    <div
                      onPointerMove={spotlight.onPointerMove}
                      className={cn(
                        'overflow-hidden rounded-2xl border-[0.8px] border-border bg-card shadow-sm transition-[border-color,box-shadow] duration-150 hover:border-border-strong hover:shadow-lift',
                        spotlight.className
                      )}
                    >
                      <div className="flex flex-col gap-4 p-4 md:flex-row md:items-start md:justify-between">
                        <button
                          type="button"
                          onClick={() => openModel(model)}
                          className="flex min-w-0 flex-1 gap-3.5 rounded-lg text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
                        >
                          <HuggingFaceAvatar author={author} modelId={model.id} />
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="truncate text-[length:calc(var(--ui-font-base)*0.9375)] font-semibold">
                                <span className="font-normal text-muted-foreground">
                                  {rest.length ? `${author} / ` : ''}
                                </span>
                                {name}
                              </span>
                              <Chip mono>{isMlx ? 'MLX' : 'GGUF'}</Chip>
                              {installed && (
                                <Chip tone="ok" dot>
                                  <Check /> Installed
                                </Chip>
                              )}
                              {model.gated && (
                                <Chip tone="warn">
                                  <LockKeyhole /> Gated
                                </Chip>
                              )}
                            </span>
                            <span className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
                              <span className="inline-flex items-center gap-1">
                                <Download className="size-3.5" />
                                {formatCount(model.downloads)}
                              </span>
                              <span className="inline-flex items-center gap-1">
                                <Heart className="size-3.5" />
                                {formatCount(model.likes)}
                              </span>
                              {parameterCount != null && (
                                <span className="tabular-nums">{parameterCount}B</span>
                              )}
                              {(hasVision || hasTools) && (
                                <span>
                                  {[hasVision && 'Vision', hasTools && 'Tools']
                                    .filter(Boolean)
                                    .join(' · ')}
                                </span>
                              )}
                              {/* The date only matters when the list is ordered by it. */}
                              {updated && (sort === 'updated' || sort === 'newest') && (
                                <span className="tabular-nums">{updated}</span>
                              )}
                            </span>
                          </span>
                        </button>

                        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                          {installedSlice(model) && (
                            <DialogDeleteAllModels
                              provider={installedSlice(model)!}
                              iconOnly
                            />
                          )}
                          {isMlx ? (
                            <HuggingFaceDownloadAction
                              repo={model.id}
                              revision={model.sha}
                              files={files}
                              format="mlx"
                              compact
                            />
                          ) : recommended ? (
                            <HuggingFaceDownloadAction
                              repo={model.id}
                              revision={model.sha}
                              group={recommended}
                              groups={groups}
                              compact
                            />
                          ) : null}
                          {!isMlx && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void toggleExpanded(model.id)}
                              aria-expanded={opened}
                              title={opened ? t('sweep:hub.hideVariants') : t('sweep:hub.showVariants')}
                            >
                              <FileCode2 className="size-3.5" />
                              {opened ? t('sweep:hub.hideVariants') : t('sweep:hub.showVariants')}
                              {opened ? (
                                <ChevronUp className="size-3.5" />
                              ) : (
                                <ChevronDown className="size-3.5" />
                              )}
                            </Button>
                          )}
                        </div>
                      </div>

                      {recommendedFit && !opened && (isMlx || recommended) && (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border bg-muted/40 px-4 py-2 text-xs text-secondary-foreground">
                          <span className="inline-flex items-center gap-1.5 font-medium text-acc-text">
                            <Sparkles className="size-3.5" />{' '}
                            {isMlx ? t('sweep:hub.onThisMac') : t('sweep:hub.bestForDevice')}
                          </span>
                          <span className="font-mono">
                            {isMlx
                              ? 'MLX'
                              : recommended?.quantization ||
                                recommended?.primary.name}
                          </span>
                          <span className="text-muted-foreground">
                            {formatModelBytes(
                              isMlx ? mlxBytes : recommended?.totalSize
                            )}
                          </span>
                          <Chip
                            tone={fitTone(recommendedFit.verdict)}
                            dot
                            title={fitBasis(recommendedFit)}
                          >
                            {fitLabel(recommendedFit.verdict, t)}
                          </Chip>
                        </div>
                      )}

                      {opened && !isMlx && (
                        <div className="border-t border-border bg-muted/30 px-4 py-3">
                          {loadingFiles[model.id] && variants.length === 0 ? (
                            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                              <LoaderCircle className="size-4 animate-spin" />
                              {t('sweep:hub.loadingVariants')}
                            </div>
                          ) : variants.length === 0 ? (
                            <p className="py-3 text-sm text-muted-foreground">
                              {t('sweep:hub.noVariants')}
                            </p>
                          ) : (
                            <HubVariantList
                              variants={variants}
                              recommendedId={recommended?.id}
                              renderRow={(group) => {
                                const fit = fitOfGroup(group, groups, fitContext)
                                const isRecommended = recommended?.id === group.id
                                return (
                                  <div
                                    key={group.id}
                                    className={cn(
                                      'flex flex-col gap-2 rounded-xl px-3 py-2.5 sm:flex-row sm:items-center',
                                      isRecommended
                                        ? 'bg-card shadow-[inset_0_0_0_0.8px_var(--border-strong)]'
                                        : 'hover:bg-card'
                                    )}
                                  >
                                    <div className="min-w-0 flex-1">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span className="font-mono text-[length:calc(var(--ui-font-base)*0.8125)] font-semibold">
                                          {group.quantization || group.primary.name}
                                        </span>
                                        {isRecommended && (
                                          <Chip tone="info">
                                            <Sparkles /> Recommended for this computer
                                          </Chip>
                                        )}
                                        <span className="text-xs text-muted-foreground tabular-nums">
                                          {fit.sizeEstimated ? '≈ ' : ''}
                                          {formatModelBytes(
                                            group.totalSize ??
                                              fit.required.weights
                                          )}
                                        </span>
                                        {group.multipart && (
                                          <Chip>{group.files.length} shards</Chip>
                                        )}
                                        <Chip
                                          tone={fitTone(fit.verdict)}
                                          dot
                                          title={fitBasis(fit)}
                                        >
                                          {fitLabel(fit.verdict, t)}
                                        </Chip>
                                      </div>
                                      <div className="mt-1 text-[length:calc(var(--ui-font-base)*0.71875)] text-muted-foreground">
                                        {explainQuantization(group.quantization)}
                                      </div>
                                    </div>
                                    <div className="shrink-0">
                                      <HuggingFaceDownloadAction
                                        repo={model.id}
                                        revision={model.sha}
                                        group={group}
                                        groups={groups}
                                        compact
                                      />
                                    </div>
                                  </div>
                                )
                              }}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </div>
      </main>
      )}
    </div>
  )
}

function DesktopOnlyTitle() {
  const { t } = useTranslation()
  return <DesktopOnlyPage title={t('common:shell.discover')} />
}
