/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { Search, SlidersHorizontal, Heart, Download, LockKeyhole, ExternalLink, LoaderCircle } from 'lucide-react'
import { route } from '@/constants/routes'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import {
  type HuggingFaceModel,
  cleanHuggingFaceRepo,
  inferArchitecture,
  inferParameterCount,
  searchHuggingFaceModels,
} from '@/lib/huggingface'

export const Route = createFileRoute(route.hub.index as any)({
  component: ModelDiscoverRoute,
})

type SortMode = 'downloads' | 'likes' | 'updated' | 'newest'
type ParamFilter = 'all' | 'tiny' | 'small' | 'medium' | 'large'

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

function ModelDiscoverRoute() {
  const navigate = useNavigate()
  const token = useGeneralSetting((s) => s.huggingfaceToken)
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [models, setModels] = useState<HuggingFaceModel[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sort, setSort] = useState<SortMode>('downloads')
  const [params, setParams] = useState<ParamFilter>('all')
  const [architecture, setArchitecture] = useState('all')
  const [modality, setModality] = useState('all')
  const [includeGated, setIncludeGated] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    // Entering Discover is the explicit action that permits this request.
    // An empty query asks Hugging Face for popular GGUF repositories once the
    // backend supports catalogue-free browsing; older backends simply return [].
    searchHuggingFaceModels(submitted, token)
      .then((result) => {
        if (!cancelled) setModels(result)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [submitted, token])

  const architectures = useMemo(
    () =>
      [...new Set(models.map(inferArchitecture).filter((v): v is string => Boolean(v)))].sort(),
    [models]
  )

  const visible = useMemo(() => {
    const filtered = models.filter((model) => {
      const p = inferParameterCount(model)
      const arch = inferArchitecture(model)
      const tags = model.tags.join(' ').toLowerCase()
      const matchesModality =
        modality === 'all' ||
        (modality === 'vision' && /vision|multimodal|image-text/.test(tags)) ||
        (modality === 'audio' && /audio|speech/.test(tags)) ||
        (modality === 'embedding' && /embedding|feature-extraction/.test(tags)) ||
        (modality === 'text' && !/vision|multimodal|image-text|audio|speech|embedding|feature-extraction/.test(tags))
      return (
        inParameterBucket(p, params) &&
        (architecture === 'all' || arch === architecture) &&
        matchesModality &&
        (includeGated || !model.gated)
      )
    })
    return filtered.sort((a, b) => {
      if (sort === 'likes') return b.likes - a.likes
      if (sort === 'updated') return Date.parse(b.lastModified ?? '') - Date.parse(a.lastModified ?? '')
      if (sort === 'newest') return Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? '')
      return b.downloads - a.downloads
    })
  }, [models, params, architecture, modality, includeGated, sort])

  const openModel = (model: HuggingFaceModel) => {
    const repo = cleanHuggingFaceRepo(model.id)
    navigate({
      to: route.hub.model,
      params: { modelId: repo.split('/').pop() || repo },
      search: { repo },
    })
  }

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    setSubmitted(cleanHuggingFaceRepo(query))
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border px-5 py-4">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                <span className="inline-block size-1.5 rounded-full bg-foreground" />
                Hugging Face
              </div>
              <h1 className="text-2xl font-semibold tracking-tight">Discover local models</h1>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                Search GGUF models directly on Hugging Face. Flint only contacts Hugging Face while you use this page or start a download.
              </p>
            </div>
            <Button variant="outline" size="sm" asChild>
              <a href="https://huggingface.co/models?library=gguf" target="_blank" rel="noreferrer">
                Hugging Face <ExternalLink className="size-3.5" />
              </a>
            </Button>
          </div>

          <form onSubmit={submit} className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search a model, author, or paste a Hugging Face URL…"
              className="h-11 pl-10 pr-24"
              data-testid="hub-search"
            />
            <Button type="submit" size="sm" className="absolute right-1.5 top-1.5 h-8">
              Search
            </Button>
          </form>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="mr-1 inline-flex items-center gap-1.5 text-muted-foreground"><SlidersHorizontal className="size-3.5" /> Filters</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as SortMode)} className="h-8 rounded-md border border-border bg-card px-2 text-foreground">
              <option value="downloads">Most downloaded</option>
              <option value="likes">Most liked</option>
              <option value="updated">Recently updated</option>
              <option value="newest">Newest</option>
            </select>
            <select value={params} onChange={(e) => setParams(e.target.value as ParamFilter)} className="h-8 rounded-md border border-border bg-card px-2 text-foreground">
              <option value="all">Any parameter size</option>
              <option value="tiny">Under 3B</option>
              <option value="small">3B–8B</option>
              <option value="medium">8B–34B</option>
              <option value="large">34B+</option>
            </select>
            <select value={architecture} onChange={(e) => setArchitecture(e.target.value)} className="h-8 rounded-md border border-border bg-card px-2 text-foreground">
              <option value="all">Any architecture</option>
              {architectures.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <select value={modality} onChange={(e) => setModality(e.target.value)} className="h-8 rounded-md border border-border bg-card px-2 text-foreground">
              <option value="all">Any modality</option>
              <option value="text">Text</option>
              <option value="vision">Vision</option>
              <option value="audio">Audio</option>
              <option value="embedding">Embedding</option>
            </select>
            <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-2">
              <input type="checkbox" checked={includeGated} onChange={(e) => setIncludeGated(e.target.checked)} />
              Gated models
            </label>
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto w-full max-w-6xl">
          {loading ? (
            <div className="grid min-h-64 place-items-center text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-2"><LoaderCircle className="size-4 animate-spin" /> Loading Hugging Face models…</span>
            </div>
          ) : error ? (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
              <p className="font-medium text-destructive">Could not load Hugging Face</p>
              <p className="mt-1 text-muted-foreground">{error}</p>
            </div>
          ) : visible.length === 0 ? (
            <div className="grid min-h-64 place-items-center text-center">
              <div>
                <p className="font-medium">No models match these filters</p>
                <p className="mt-1 text-sm text-muted-foreground">Try another search, paste an exact owner/repository id, or loosen the filters.</p>
              </div>
            </div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {visible.map((model) => {
                const parameterCount = inferParameterCount(model)
                const arch = inferArchitecture(model)
                return (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => openModel(model)}
                    className="group flex min-h-36 flex-col rounded-xl border border-border bg-card p-4 text-left shadow-[0_1px_2px_rgba(0,0,0,.03)] transition-[border-color,box-shadow,transform] hover:-translate-y-px hover:border-border-strong hover:shadow-lift"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-muted-foreground">{model.id.split('/')[0]}</p>
                        <h2 className="mt-0.5 truncate text-[15px] font-semibold text-foreground">{model.id.split('/').slice(1).join('/') || model.id}</h2>
                      </div>
                      {model.gated && <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-1 text-[11px] text-muted-foreground"><LockKeyhole className="size-3" /> Gated</span>}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {parameterCount != null && <span className="rounded-md bg-muted px-2 py-1 text-[11px]">{parameterCount}B</span>}
                      {arch && <span className="rounded-md bg-muted px-2 py-1 text-[11px] capitalize">{arch}</span>}
                      {(model.pipelineTag || 'text-generation') && <span className="rounded-md bg-muted px-2 py-1 text-[11px]">{model.pipelineTag || 'text-generation'}</span>}
                      <span className="rounded-md bg-muted px-2 py-1 text-[11px]">GGUF</span>
                    </div>
                    <div className="mt-auto flex items-center gap-4 pt-4 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1"><Download className="size-3.5" /> {formatCount(model.downloads)}</span>
                      <span className="inline-flex items-center gap-1"><Heart className="size-3.5" /> {formatCount(model.likes)}</span>
                      {model.lastModified && <span className="ml-auto">Updated {new Date(model.lastModified).toLocaleDateString()}</span>}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
