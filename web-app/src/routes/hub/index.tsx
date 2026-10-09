/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  AudioLines,
  Boxes,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Cpu,
  Download,
  ExternalLink,
  Eye,
  FileCode2,
  Heart,
  Layers,
  LoaderCircle,
  LockKeyhole,
  Search,
  ShieldCheck,
  Sparkles,
  Type,
  Wrench,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Chip } from '@/components/ui/chip'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { HuggingFaceAvatar } from '@/containers/HuggingFaceAvatar'
import { Segmented } from '@/components/ui/segmented'
import { StudioDiscover } from '@/containers/studio/StudioDiscover'
import { cn } from '@/lib/utils'
import { useSpotlight } from '@/hooks/useSpotlight'
import { DialogDeleteAllModels } from '@/containers/dialogs/DeleteAllModels'
import { HuggingFaceDownloadAction } from '@/containers/HuggingFaceDownloadAction'
import { route } from '@/constants/routes'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useFitContext } from '@/hooks/useFitContext'
import { useModelProvider } from '@/hooks/useModelProvider'
import {
  cleanHuggingFaceRepo,
  explainQuantization,
  formatModelBytes,
  getHuggingFaceFiles,
  groupHuggingFaceFiles,
  inferArchitecture,
  inferModalities,
  inferParameterCount,
  mlxWeightsBytes,
  repoLooksMlx,
  searchHuggingFaceModels,
  type HuggingFaceFile,
  type HuggingFaceFormat,
  type HuggingFaceModel,
} from '@/lib/huggingface'
import {
  bestGroup,
  fitBasis,
  fitOfGroup,
  loadRepoArchitecture,
  type FitContext,
  type GroupFit,
} from '@/lib/huggingfaceFit'
import {
  assessModelFit,
  DEFAULT_CTX_LENGTH,
  type FitVerdict,
  type KvArchitecture,
} from '@/lib/modelCompatibility'

export const Route = createFileRoute(route.hub.index as any)({
  component: ModelDiscoverRoute,
})

type SortMode = 'downloads' | 'likes' | 'updated' | 'newest'
type ParamFilter = 'all' | 'tiny' | 'small' | 'medium' | 'large'
type ModalityFilter = 'all' | 'text' | 'vision' | 'audio' | 'embedding'

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

function fitLabel(verdict: FitVerdict): string {
  if (verdict === 'fits') return 'Fits in memory'
  if (verdict === 'fits-partial-offload') return 'Partial GPU offload'
  if (verdict === 'tight') return 'Tight fit'
  if (verdict === 'exceeds') return 'May exceed memory'
  return 'Fit unknown'
}

function fitTone(verdict: FitVerdict): 'ok' | 'warn' | 'err' | 'neutral' {
  if (verdict === 'fits') return 'ok'
  if (verdict === 'fits-partial-offload' || verdict === 'tight') return 'warn'
  if (verdict === 'exceeds') return 'err'
  return 'neutral'
}

function formatUpdated(value?: string | null): string | null {
  const time = Date.parse(value ?? '')
  if (Number.isNaN(time)) return null
  return new Date(time).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

const SELECT =
  'h-8 cursor-pointer rounded-lg border-[0.8px] border-border bg-card px-2 text-foreground transition-colors hover:border-border-strong'

const MODALITY_PILLS: Array<{
  value: ModalityFilter
  label: string
  Icon: typeof Type
}> = [
  { value: 'all', label: 'All', Icon: Boxes },
  { value: 'text', label: 'Text', Icon: Type },
  { value: 'vision', label: 'Vision', Icon: Eye },
  { value: 'audio', label: 'Audio', Icon: AudioLines },
  { value: 'embedding', label: 'Embedding', Icon: Layers },
]

function ModelDiscoverRoute() {
  const spotlight = useSpotlight()
  const navigate = useNavigate()
  const token = useGeneralSetting((state) => state.huggingfaceToken)
  const { hardware, devices } = useFitContext()
  const providers = useModelProvider((state) => state.providers)
  const parentRef = useRef<HTMLDivElement>(null)

  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [models, setModels] = useState<HuggingFaceModel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sort, setSort] = useState<SortMode>('downloads')
  const [params, setParams] = useState<ParamFilter>('all')
  const [architecture, setArchitecture] = useState('all')
  const [modality, setModality] = useState<ModalityFilter>('all')
  const [format, setFormat] = useState<HuggingFaceFormat>(
    IS_MACOS ? 'all' : 'gguf'
  )
  // What is being looked for: models that chat, or models that make pictures.
  const [source, setSource] = useState<'models' | 'studio'>('models')
  const [includeGated, setIncludeGated] = useState(true)
  const [downloadedOnly, setDownloadedOnly] = useState(false)
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
            searchHuggingFaceModels(debouncedQuery, token, 'gguf'),
            searchHuggingFaceModels(debouncedQuery, token, 'mlx'),
          ])
          const byId = new Map<string, HuggingFaceModel>()
          for (const model of [...gguf, ...mlx]) byId.set(model.id, model)
          result = [...byId.values()]
        } else {
          result = await searchHuggingFaceModels(
            debouncedQuery,
            token,
            format
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
  }, [debouncedQuery, token, format, source])

  const installedIds = useMemo(() => {
    const ids = new Set<string>()
    for (const provider of providers) {
      if (provider.provider !== 'llamacpp' && provider.provider !== 'mlx') continue
      for (const model of provider.models ?? []) {
        ids.add(`${provider.provider}:${model.id}`)
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
      (m) => !m.imported && (mlx ? m.id === model.id : m.id.startsWith(`${model.id}/`))
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
      const modalities = inferModalities(model, files)
      return (
        inParameterBucket(parameterCount, params) &&
        (architecture === 'all' || arch === architecture) &&
        (modality === 'all' || modalities.includes(modality)) &&
        (includeGated || !model.gated) &&
        (!downloadedOnly || repoInstalled(model))
      )
    })

    return filtered.sort((a, b) => {
      if (sort === 'likes') return b.likes - a.likes
      if (sort === 'updated') {
        return Date.parse(b.lastModified ?? '') - Date.parse(a.lastModified ?? '')
      }
      if (sort === 'newest') {
        return Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? '')
      }
      return b.downloads - a.downloads
    })
  }, [
    models,
    params,
    architecture,
    modality,
    includeGated,
    downloadedOnly,
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
    setExpanded((state) => ({ ...state, [repo]: opening }))
    if (!opening) return
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
    modality !== 'all' ||
    downloadedOnly ||
    !includeGated
  const clearFilters = () => {
    setParams('all')
    setArchitecture('all')
    setModality('all')
    setDownloadedOnly(false)
    setIncludeGated(true)
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border bg-[radial-gradient(120%_140%_at_0%_0%,var(--accent)_0%,transparent_55%)] px-5 pt-5 pb-4">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3.5">
              <span
                aria-hidden
                className="grid size-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-amber-300 to-orange-500 text-white shadow-lift"
              >
                <Boxes className="size-5" />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[11px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
                  Hugging Face
                  <Chip tone="ok" dot className="tracking-normal normal-case">
                    <ShieldCheck /> Private until you use it
                  </Chip>
                </div>
                <h1 className="mt-1 text-2xl leading-tight font-medium tracking-[-0.01em]">
                  {source === 'studio' ? 'Discover image models' : 'Discover local models'}
                </h1>
                <p className="mt-1 hidden max-w-2xl text-[13px] text-secondary-foreground [@media(min-height:700px)]:block">
                  Search, compare and download models that run on this device.
                  Hugging Face is contacted only while you use Discover or start
                  a download.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
            <Segmented<'models' | 'studio'>
              aria-label="What to look for"
              className="min-w-[260px]"
              options={[
                { value: 'models', label: 'Chat models' },
                { value: 'studio', label: 'Images' },
              ]}
              value={source}
              onValueChange={setSource}
            />
            <Button variant="outline" size="sm" asChild>
              <a
                href="https://huggingface.co/models"
                target="_blank"
                rel="noreferrer"
              >
                Open Hugging Face <ExternalLink className="size-3.5" />
              </a>
            </Button>
            </div>
          </div>

          <div className="relative">
            {loading ? (
              <LoaderCircle className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
            ) : (
              <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            )}
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search models, authors, or paste a Hugging Face URL…"
              className="h-12 rounded-xl pr-10 pl-11 text-[14px] shadow-lift"
              data-testid="hub-search"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery('')}
                className="absolute top-1/2 right-3 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>

          {source === 'models' && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {MODALITY_PILLS.map(({ value, label, Icon: PillIcon }) => (
              <button
                key={value}
                type="button"
                aria-pressed={modality === value}
                onClick={() => setModality(value)}
                className={cn(
                  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border-[0.8px] px-3 font-medium transition-colors',
                  modality === value
                    ? 'border-transparent bg-foreground text-background'
                    : 'border-border bg-card text-secondary-foreground hover:border-border-strong hover:text-foreground'
                )}
              >
                <PillIcon className="size-3.5" />
                {label}
              </button>
            ))}
            <span aria-hidden className="mx-1 h-5 w-px bg-border" />
            {IS_MACOS && (
              <select
                value={format}
                onChange={(event) =>
                  setFormat(event.target.value as HuggingFaceFormat)
                }
                className={SELECT}
                aria-label="Format"
              >
                <option value="all">GGUF + MLX</option>
                <option value="gguf">GGUF</option>
                <option value="mlx">MLX</option>
              </select>
            )}
            <select
              value={params}
              onChange={(event) => setParams(event.target.value as ParamFilter)}
              className={SELECT}
              aria-label="Parameter size"
            >
              <option value="all">Any parameter size</option>
              <option value="tiny">Under 3B</option>
              <option value="small">3B–8B</option>
              <option value="medium">8B–34B</option>
              <option value="large">34B+</option>
            </select>
            <select
              value={architecture}
              onChange={(event) => setArchitecture(event.target.value)}
              className={SELECT}
              aria-label="Architecture"
            >
              <option value="all">Any architecture</option>
              {architectures.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
          )}
        </div>
      </header>

      {source === 'studio' ? (
        <StudioDiscover query={debouncedQuery} token={token} />
      ) : (
      <main ref={parentRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mx-auto w-full max-w-6xl">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span aria-live="polite">
              {loading
                ? 'Searching Hugging Face…'
                : `${visible.length} ${visible.length === 1 ? 'model' : 'models'}`}
              {filtersActive && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="ml-2 cursor-pointer underline underline-offset-2 hover:text-foreground"
                >
                  Clear filters
                </button>
              )}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-lg border-[0.8px] border-border bg-card px-2.5 text-secondary-foreground">
                <Switch
                  checked={downloadedOnly}
                  onCheckedChange={setDownloadedOnly}
                />
                Downloaded
              </label>
              <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-lg border-[0.8px] border-border bg-card px-2.5 text-secondary-foreground">
                <Switch checked={includeGated} onCheckedChange={setIncludeGated} />
                <LockKeyhole className="size-3.5" /> Gated
              </label>
            <label className="inline-flex items-center gap-2">
              Sort by
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as SortMode)}
                className={SELECT}
                aria-label="Sort"
              >
                <option value="downloads">Most downloaded</option>
                <option value="likes">Most liked</option>
                <option value="updated">Recently updated</option>
                <option value="newest">Newest</option>
              </select>
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
              title="No matching models"
              description="Try a broader search or remove one of the filters."
              action={
                filtersActive ? (
                  <Button variant="outline" size="sm" onClick={clearFilters}>
                    Clear filters
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
                const recommendedFit: GroupFit | null = isMlx
                  ? mlxBytes
                    ? {
                        ...assessModelFit({
                          weightsBytes: mlxBytes,
                          ctxLength: DEFAULT_CTX_LENGTH,
                          hardware,
                          devices,
                        }),
                        sizeEstimated: false,
                      }
                    : null
                  : recommended
                    ? fitOfGroup(recommended, groups, fitContext)
                    : null
                const modalities = inferModalities(model, files)
                const arch = inferArchitecture(model)
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
                const updated = formatUpdated(model.lastModified)

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
                              <span className="truncate text-[15px] font-semibold">
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
                                <span className="inline-flex items-center gap-1">
                                  <Cpu className="size-3.5" />
                                  {parameterCount}B
                                </span>
                              )}
                              {arch && (
                                <span className="inline-flex items-center gap-1 capitalize">
                                  <Layers className="size-3.5" />
                                  {arch}
                                </span>
                              )}
                              {hasVision && (
                                <span className="inline-flex items-center gap-1 text-info">
                                  <Eye className="size-3.5" /> Vision
                                </span>
                              )}
                              {hasTools && (
                                <span className="inline-flex items-center gap-1 text-info">
                                  <Wrench className="size-3.5" /> Tools
                                </span>
                              )}
                              {updated && (
                                <span className="inline-flex items-center gap-1">
                                  <Clock className="size-3.5" />
                                  {updated}
                                </span>
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
                              title={opened ? 'Hide variants' : 'Show variants'}
                            >
                              <FileCode2 className="size-3.5" />
                              {opened ? 'Hide variants' : 'Show variants'}
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
                            {isMlx ? 'On this Mac' : 'Best for this device'}
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
                            {fitLabel(recommendedFit.verdict)}
                          </Chip>
                        </div>
                      )}

                      {opened && !isMlx && (
                        <div className="border-t border-border bg-muted/30 px-4 py-3">
                          {loadingFiles[model.id] && variants.length === 0 ? (
                            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                              <LoaderCircle className="size-4 animate-spin" />
                              Loading variants…
                            </div>
                          ) : variants.length === 0 ? (
                            <p className="py-3 text-sm text-muted-foreground">
                              No downloadable GGUF variants were found in this repository.
                            </p>
                          ) : (
                            <div className="space-y-1">
                              {variants.map((group) => {
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
                                        <span className="font-mono text-[13px] font-semibold">
                                          {group.quantization || group.primary.name}
                                        </span>
                                        {isRecommended && (
                                          <Chip tone="info">
                                            <Sparkles /> Recommended
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
                                          {fitLabel(fit.verdict)}
                                        </Chip>
                                      </div>
                                      <div className="mt-1 text-[11.5px] text-muted-foreground">
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
                              })}
                            </div>
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
