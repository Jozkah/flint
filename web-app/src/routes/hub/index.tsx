/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  Eye,
  FileCode2,
  Heart,
  LoaderCircle,
  LockKeyhole,
  Search,
  SlidersHorizontal,
  Sparkles,
  Wrench,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { HuggingFaceDownloadAction } from '@/containers/HuggingFaceDownloadAction'
import { route } from '@/constants/routes'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useHardware } from '@/hooks/useHardware'
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
  quantPreference,
  repoLooksMlx,
  searchHuggingFaceModels,
  type HuggingFaceFile,
  type HuggingFaceFileGroup,
  type HuggingFaceFormat,
  type HuggingFaceModel,
} from '@/lib/huggingface'
import {
  assessModelFit,
  DEFAULT_CTX_LENGTH,
  type FitVerdict,
} from '@/lib/modelCompatibility'
import { cn } from '@/lib/utils'

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

function fitRank(verdict: FitVerdict): number {
  if (verdict === 'fits') return 500
  if (verdict === 'fits-partial-offload') return 400
  if (verdict === 'tight') return 300
  if (verdict === 'unknown') return 200
  return 0
}

function bestGroup(
  groups: HuggingFaceFileGroup[],
  hardware: ReturnType<typeof useHardware.getState>['hardwareData']
): HuggingFaceFileGroup | undefined {
  const models = groups.filter((group) => group.kind === 'model')
  if (!models.length) return undefined
  return [...models].sort((a, b) => {
    const aFit = assessModelFit({
      weightsBytes: a.totalSize,
      ctxLength: DEFAULT_CTX_LENGTH,
      hardware,
    })
    const bFit = assessModelFit({
      weightsBytes: b.totalSize,
      ctxLength: DEFAULT_CTX_LENGTH,
      hardware,
    })
    const aScore = fitRank(aFit.verdict) + quantPreference(a.quantization)
    const bScore = fitRank(bFit.verdict) + quantPreference(b.quantization)
    if (aScore !== bScore) return bScore - aScore
    return (a.totalSize ?? Number.MAX_SAFE_INTEGER) - (b.totalSize ?? Number.MAX_SAFE_INTEGER)
  })[0]
}

function fitLabel(verdict: FitVerdict): string {
  if (verdict === 'fits') return 'Fits in memory'
  if (verdict === 'fits-partial-offload') return 'Partial GPU offload'
  if (verdict === 'tight') return 'Tight fit'
  if (verdict === 'exceeds') return 'May exceed memory'
  return 'Fit unknown'
}

function ModelDiscoverRoute() {
  const navigate = useNavigate()
  const token = useGeneralSetting((state) => state.huggingfaceToken)
  const hardware = useHardware((state) => state.hardwareData)
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
  const [format, setFormat] = useState<HuggingFaceFormat>(IS_MACOS ? 'all' : 'gguf')
  const [includeGated, setIncludeGated] = useState(true)
  const [downloadedOnly, setDownloadedOnly] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [filesByRepo, setFilesByRepo] = useState<Record<string, HuggingFaceFile[]>>({})
  const [loadingFiles, setLoadingFiles] = useState<Record<string, boolean>>({})

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(cleanHuggingFaceRepo(query))
    }, 300)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
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
          result = await searchHuggingFaceModels(debouncedQuery, token, format)
        }
        if (!cancelled) {
          setModels(result)
          setFilesByRepo((current) => {
            const next = { ...current }
            for (const model of result) {
              if (model.files?.length) next[model.id] = model.files
            }
            return next
          })
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [debouncedQuery, token, format])

  const installedIds = useMemo(() => {
    const ids = new Set<string>()
    for (const provider of providers) {
      if (provider.provider !== 'llamacpp' && provider.provider !== 'mlx') continue
      for (const model of provider.models ?? []) ids.add(`${provider.provider}:${model.id}`)
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

  const architectures = useMemo(
    () => [...new Set(models.map(inferArchitecture).filter((value): value is string => Boolean(value)))].sort(),
    [models]
  )

  const visible = useMemo(() => {
    const filtered = models.filter((model) => {
      const p = inferParameterCount(model)
      const arch = inferArchitecture(model)
      const files = filesByRepo[model.id] ?? model.files ?? []
      const modalities = inferModalities(model, files)
      return (
        inParameterBucket(p, params) &&
        (architecture === 'all' || arch === architecture) &&
        (modality === 'all' || modalities.includes(modality)) &&
        (includeGated || !model.gated) &&
        (!downloadedOnly || repoInstalled(model))
      )
    })
    return filtered.sort((a, b) => {
      if (sort === 'likes') return b.likes - a.likes
      if (sort === 'updated') return Date.parse(b.lastModified ?? '') - Date.parse(a.lastModified ?? '')
      if (sort === 'newest') return Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? '')
      return b.downloads - a.downloads
    })
  }, [models, params, architecture, modality, includeGated, downloadedOnly, sort, filesByRepo, installedIds])

  const loadFiles = async (repo: string) => {
    if (filesByRepo[repo]?.length || loadingFiles[repo]) return filesByRepo[repo] ?? []
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
    if (opening) await loadFiles(repo).catch(() => {})
  }

  const rowVirtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      const model = visible[index]
      const files = filesByRepo[model?.id] ?? model?.files ?? []
      const groupCount = groupHuggingFaceFiles(files).filter((group) => group.kind === 'model').length
      return expanded[model?.id] ? 170 + Math.min(groupCount, 20) * 52 : 170
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

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border bg-background/95 px-5 py-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                <span className="inline-block size-1.5 rounded-full bg-foreground" />
                Hugging Face
              </div>
              <h1 className="text-2xl font-semibold tracking-tight">Discover local models</h1>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                Search, compare, download, and update local models. Hugging Face is contacted only while you use Discover or start a download.
              </p>
            </div>
            <Button variant="outline" size="sm" asChild>
              <a href="https://huggingface.co/models" target="_blank" rel="noreferrer">
                Hugging Face <ExternalLink className="size-3.5" />
              </a>
            </Button>
          </div>

          <div className="relative">
            {loading ? (
              <LoaderCircle className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
            ) : (
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            )}
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search models, authors, or paste a Hugging Face URL…"
              className="h-11 pl-10"
              data-testid="hub-search"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="mr-1 inline-flex items-center gap-1.5 text-muted-foreground">
              <SlidersHorizontal className="size-3.5" /> Filters
            </span>
            <select value={sort} onChange={(event) => setSort(event.target.value as SortMode)} className="h-8 rounded-md border border-border bg-card px-2 text-foreground">
              <option value="downloads">Most downloaded</option>
              <option value="likes">Most liked</option>
              <option value="updated">Recently updated</option>
              <option value="newest">Newest</option>
            </select>
            {IS_MACOS && (
              <select value={format} onChange={(event) => setFormat(event.target.value as HuggingFaceFormat)} className="h-8 rounded-md border border-border bg-card px-2 text-foreground">
                <option value="all">GGUF + MLX</option>
                <option value="gguf">GGUF</option>
                <option value="mlx">MLX</option>
              </select>
            )}
            <select value={params} onChange={(event) => setParams(event.target.value as ParamFilter)} className="h-8 rounded-md border border-border bg-card px-2 text-foreground">
              <option value="all">Any parameter size</option>
              <option value="tiny">Under 3B</option>
              <option value="small">3B–8B</option>
              <option value="medium">8B–34B</option>
              <option value="large">34B+</option>
            </select>
            <select value={architecture} onChange={(event) => setArchitecture(event.target.value)} className="h-8 rounded-md border border-border bg-card px-2 text-foreground">
              <option value="all">Any architecture</option>
              {architectures.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <select value={modality} onChange={(event) => setModality(event.target.value as ModalityFilter)} className="h-8 rounded-md border border-border bg-card px-2 text-foreground">
              <option value="all">Any modality</option>
              <option value="text">Text</option>
              <option value="vision">Vision</option>
              <option value="audio">Audio</option>
              <option value="embedding">Embedding</option>
            </select>
            <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-2">
              <Switch checked={downloadedOnly} onCheckedChange={setDownloadedOnly} /> Downloaded
            </label>
            <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-2">
              <Switch checked={includeGated} onCheckedChange={setIncludeGated} /> Gated
            </label>
          </div>
        </div>
      </header>

      <main ref={parentRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto w-full max-w-6xl">
          {error ? (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
              <p className="font-medium text-destructive">Could not load Hugging Face</p>
              <p className="mt-1 text-muted-foreground">{error}</p>
            </div>
          ) : loading && models.length === 0 ? (
            <div className="space-y-3 animate-pulse">
              {[0, 1, 2, 3, 4].map((key) => (
                <div key={key} className="h-36 rounded-xl border border-border bg-card" />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <div className="grid min-h-64 place-items-center text-center">
              <div>
                <p className="font-medium">No models match these filters</p>
                <p className="mt-1 text-sm text-muted-foreground">Try another search or loosen one of the filters.</p>
              </div>
            </div>
          ) : (
            <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const model = visible[virtualRow.index]
                const files = filesByRepo[model.id] ?? model.files ?? []
                const groups = groupHuggingFaceFiles(files)
                const modelGroups = groups.filter((group) => group.kind === 'model')
                const recommended = bestGroup(groups, hardware)
                const parameterCount = inferParameterCount(model)
                const arch = inferArchitecture(model)
                const modalities = inferModalities(model, files)
                const isMlx = repoLooksMlx(model)
                const installed = repoInstalled(model)
                const hasTools = model.tags.some((tag) => /tool|function-call/i.test(tag))
                const expandedNow = expanded[model.id]

                return (
                  <div
                    key={model.id}
                    ref={rowVirtualizer.measureElement}
                    data-index={virtualRow.index}
                    className="absolute left-0 top-0 w-full pb-3"
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    <section className="rounded-xl border border-border bg-card p-4 shadow-[0_1px_2px_rgba(0,0,0,.03)] transition-[border-color,box-shadow] hover:border-border-strong hover:shadow-lift">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <button type="button" onClick={() => openModel(model)} className="min-w-0 text-left outline-none">
                            <p className="truncate text-xs font-medium text-muted-foreground">{model.author || model.id.split('/')[0]}</p>
                            <h2 className="mt-0.5 truncate text-[15px] font-semibold text-foreground hover:underline">
                              {model.id.split('/').slice(1).join('/') || model.id}
                            </h2>
                          </button>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {parameterCount != null && <span className="rounded-md bg-muted px-2 py-1 text-[11px]">{parameterCount}B</span>}
                            {arch && <span className="rounded-md bg-muted px-2 py-1 text-[11px] capitalize">{arch}</span>}
                            <span className="rounded-md bg-muted px-2 py-1 text-[11px]">{isMlx ? 'MLX' : 'GGUF'}</span>
                            {modalities.map((value) => (
                              <span key={value} className="rounded-md bg-muted px-2 py-1 text-[11px] capitalize">{value}</span>
                            ))}
                            {installed && <span className="rounded-md bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary">Installed</span>}
                            {model.gated && <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-[11px]"><LockKeyhole className="size-3" /> Gated</span>}
                          </div>
                        </div>

                        <div className="flex shrink-0 items-center gap-2">
                          {isMlx ? (
                            files.length > 0 ? (
                              <HuggingFaceDownloadAction repo={model.id} revision={model.sha} files={files} format="mlx" compact />
                            ) : (
                              <Button variant="outline" size="sm" onClick={() => void loadFiles(model.id)} disabled={loadingFiles[model.id]}>
                                {loadingFiles[model.id] ? <LoaderCircle className="size-3.5 animate-spin" /> : <Download className="size-3.5" />} Download
                              </Button>
                            )
                          ) : recommended ? (
                            <HuggingFaceDownloadAction repo={model.id} revision={model.sha} group={recommended} groups={groups} compact />
                          ) : (
                            <Button variant="outline" size="sm" onClick={() => void loadFiles(model.id)} disabled={loadingFiles[model.id]}>
                              {loadingFiles[model.id] ? <LoaderCircle className="size-3.5 animate-spin" /> : <Download className="size-3.5" />} Download
                            </Button>
                          )}
                        </div>
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1"><Download className="size-3.5" /> {formatCount(model.downloads)}</span>
                        <span className="inline-flex items-center gap-1"><Heart className="size-3.5" /> {formatCount(model.likes)}</span>
                        {!isMlx && <span className="inline-flex items-center gap-1"><FileCode2 className="size-3.5" /> {modelGroups.length || '—'} variants</span>}
                        {modalities.some((value) => value === 'vision' || value === 'multimodal') && <span className="inline-flex items-center gap-1"><Eye className="size-3.5" /> Vision</span>}
                        {hasTools && <span className="inline-flex items-center gap-1"><Wrench className="size-3.5" /> Tools</span>}
                        {model.lastModified && <span>Updated {new Date(model.lastModified).toLocaleDateString()}</span>}
                        {!isMlx && (
                          <button type="button" onClick={() => void toggleExpanded(model.id)} className="ml-auto inline-flex items-center gap-1 font-medium text-foreground hover:underline">
                            {expandedNow ? 'Hide variants' : 'Show variants'}
                            {expandedNow ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                          </button>
                        )}
                      </div>

                      {expandedNow && !isMlx && (
                        <div className="mt-4 overflow-hidden rounded-lg border border-border">
                          {loadingFiles[model.id] && modelGroups.length === 0 ? (
                            <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" /> Loading variants…</div>
                          ) : modelGroups.length === 0 ? (
                            <div className="px-3 py-4 text-sm text-muted-foreground">No downloadable GGUF variants found.</div>
                          ) : (
                            modelGroups.map((group) => {
                              const fit = assessModelFit({ weightsBytes: group.totalSize, ctxLength: DEFAULT_CTX_LENGTH, hardware })
                              const isRecommended = recommended?.id === group.id
                              return (
                                <div key={group.id} className="flex min-h-12 items-center gap-3 border-b border-border px-3 py-2 last:border-b-0">
                                  <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="truncate font-mono text-xs text-foreground">{group.quantization || group.primary.name}</span>
                                      {isRecommended && <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"><Sparkles className="size-2.5" /> Recommended</span>}
                                      {group.multipart && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{group.files.length} parts</span>}
                                    </div>
                                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{explainQuantization(group.quantization)} · {fitLabel(fit.verdict)}</p>
                                  </div>
                                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatModelBytes(group.totalSize)}</span>
                                  <HuggingFaceDownloadAction repo={model.id} revision={model.sha} group={group} groups={groups} compact />
                                </div>
                              )
                            })
                          )}
                        </div>
                      )}
                    </section>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
