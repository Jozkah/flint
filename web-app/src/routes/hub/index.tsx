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
    return (
      (a.totalSize ?? Number.MAX_SAFE_INTEGER) -
      (b.totalSize ?? Number.MAX_SAFE_INTEGER)
    )
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
  const [format, setFormat] = useState<HuggingFaceFormat>(
    IS_MACOS ? 'all' : 'gguf'
  )
  const [includeGated, setIncludeGated] = useState(true)
  const [downloadedOnly, setDownloadedOnly] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [filesByRepo, setFilesByRepo] = useState<
    Record<string, HuggingFaceFile[]>
  >({})
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
  }, [debouncedQuery, token, format])

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

  const visible = useMemo(() => {
    const filtered = models.filter((model) => {
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
    if (opening) await loadFiles(repo).catch(() => {})
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
              <h1 className="text-2xl font-semibold tracking-tight">
                Discover local models
              </h1>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                Search, compare, download, and update local models. Hugging Face
                is contacted only while you use Discover or start a download.
              </p>
            </div>
            <Button variant="outline" size="sm" asChild>
              <a
                href="https://huggingface.co/models"
                target="_blank"
                rel="noreferrer"
              >
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
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value as SortMode)}
              className="h-8 rounded-md border border-border bg-card px-2 text-foreground"
            >
              <option value="downloads">Most downloaded</option>
              <option value="likes">Most liked</option>
              <option value="updated">Recently updated</option>
              <option value="newest">Newest</option>
            </select>
            {IS_MACOS && (
              <select
                value={format}
                onChange={(event) =>
                  setFormat(event.target.value as HuggingFaceFormat)
                }
                className="h-8 rounded-md border border-border bg-card px-2 text-foreground"
              >
                <option value="all">GGUF + MLX</option>
                <option value="gguf">GGUF</option>
                <option value="mlx">MLX</option>
              </select>
            )}
            <select
              value={params}
              onChange={(event) =>
                setParams(event.target.value as ParamFilter)
              }
              className="h-8 rounded-md border border-border bg-card px-2 text-foreground"
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
              className="h-8 rounded-md border border-border bg-card px-2 text-foreground"
            >
              <option value="all">Any architecture</option>
              {architectures.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <select
              value={modality}
              onChange={(event) =>
                setModality(event.target.value as ModalityFilter)
              }
              className="h-8 rounded-md border border-border bg-card px-2 text-foreground"
            >
              <option value="all">Any modality</option>
              <option value="text">Text</option>
              <option value="vision">Vision</option>
              <option value="audio">Audio</option>
              <option value="embedding">Embedding</option>
            </select>
            <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-2">
              <Switch
                checked={downloadedOnly}
                onCheckedChange={setDownloadedOnly}
              />
              Downloaded
            </label>
            <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-2">
              <Switch checked={includeGated} onCheckedChange={setIncludeGated} />
              Gated
            </label>
          </div>
        </div>
      </header>

      <main ref={parentRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto w-full max-w-6xl">
          {error && (
            <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {!loading && !error && visible.length === 0 && (
            <div className="grid min-h-72 place-items-center rounded-xl border border-dashed border-border text-center">
              <div>
                <Search className="mx-auto size-5 text-muted-foreground" />
                <p className="mt-3 font-medium">No matching models</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Try a broader search or remove one of the filters.
                </p>
              </div>
            </div>
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
                const recommended = bestGroup(groups, hardware)
                const isMlx = repoLooksMlx(model)
                const modalities = inferModalities(model, files)
                const parameterCount = inferParameterCount(model)
                const arch = inferArchitecture(model)
                const opened = Boolean(expanded[model.id])
                const hasTools = model.tags.some((tag) =>
                  /tool|function-call/i.test(tag)
                )

                return (
                  <article
                    key={model.id}
                    ref={rowVirtualizer.measureElement}
                    data-index={virtualItem.index}
                    className="absolute left-0 top-0 w-full pb-3"
                    style={{ transform: `translateY(${virtualItem.start}px)` }}
                  >
                    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
                      <div className="flex flex-col gap-4 p-4 md:flex-row md:items-start md:justify-between">
                        <button
                          type="button"
                          onClick={() => openModel(model)}
                          className="min-w-0 flex-1 text-left outline-none"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <h2 className="truncate text-[15px] font-semibold">
                              {model.id}
                            </h2>
                            {model.gated && (
                              <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                <LockKeyhole className="size-3" /> Gated
                              </span>
                            )}
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              {isMlx ? 'MLX' : 'GGUF'}
                            </span>
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            <span className="inline-flex items-center gap-1">
                              <Download className="size-3.5" />
                              {formatCount(model.downloads)}
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <Heart className="size-3.5" />
                              {formatCount(model.likes)}
                            </span>
                            {parameterCount != null && <span>{parameterCount}B</span>}
                            {arch && <span className="capitalize">{arch}</span>}
                            {modalities.some(
                              (value) => value === 'vision' || value === 'multimodal'
                            ) && (
                              <span className="inline-flex items-center gap-1">
                                <Eye className="size-3.5" /> Vision
                              </span>
                            )}
                            {hasTools && (
                              <span className="inline-flex items-center gap-1">
                                <Wrench className="size-3.5" /> Tools
                              </span>
                            )}
                          </div>
                        </button>

                        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
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

                      {opened && !isMlx && (
                        <div className="border-t border-border bg-muted/20 px-4 py-3">
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
                            <div className="space-y-1.5">
                              {variants.map((group) => {
                                const fit = assessModelFit({
                                  weightsBytes: group.totalSize,
                                  ctxLength: DEFAULT_CTX_LENGTH,
                                  hardware,
                                })
                                const isRecommended = recommended?.id === group.id
                                return (
                                  <div
                                    key={group.id}
                                    className="flex flex-col gap-2 rounded-lg px-2 py-2 hover:bg-card sm:flex-row sm:items-center"
                                  >
                                    <div className="min-w-0 flex-1">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span className="font-mono text-xs font-medium">
                                          {group.quantization || group.primary.name}
                                        </span>
                                        {isRecommended && (
                                          <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                                            <Sparkles className="size-3" /> Recommended
                                          </span>
                                        )}
                                        <span className="text-[11px] text-muted-foreground">
                                          {formatModelBytes(group.totalSize)}
                                        </span>
                                        {group.multipart && (
                                          <span className="text-[11px] text-muted-foreground">
                                            {group.files.length} shards
                                          </span>
                                        )}
                                      </div>
                                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                                        <span>{fitLabel(fit.verdict)}</span>
                                        <span>{explainQuantization(group.quantization)}</span>
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
    </div>
  )
}
