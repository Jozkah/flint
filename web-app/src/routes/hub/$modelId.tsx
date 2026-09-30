/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  ArrowLeft,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileCode2,
  Heart,
  LoaderCircle,
  LockKeyhole,
  Sparkles,
  Wrench,
} from 'lucide-react'
import {
  createFileRoute,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { HuggingFaceAvatar } from '@/containers/HuggingFaceAvatar'
import { HuggingFaceDownloadAction } from '@/containers/HuggingFaceDownloadAction'
import { RenderMarkdown } from '@/containers/RenderMarkdown'
import { route } from '@/constants/routes'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useFitContext } from '@/hooks/useFitContext'
import {
  explainQuantization,
  formatModelBytes,
  getHuggingFaceFiles,
  getHuggingFaceReadme,
  groupHuggingFaceFiles,
  inferArchitecture,
  inferModalities,
  inferParameterCount,
  isMlxRuntimeFile,
  repoLooksMlx,
  searchHuggingFaceModels,
  type HuggingFaceModel,
} from '@/lib/huggingface'
import {
  bestGroup,
  fitBasis,
  fitOfGroup,
  loadRepoArchitecture,
  type GroupFit,
} from '@/lib/huggingfaceFit'
import type { KvArchitecture } from '@/lib/modelCompatibility'

export const Route = createFileRoute(route.hub.model as any)({
  component: HuggingFaceModelDetail,
  validateSearch: (search: Record<string, unknown>) => ({
    repo: typeof search.repo === 'string' ? search.repo : '',
  }),
})

function fitSummary(fit: GroupFit): { title: string; detail: string } {
  if (fit.verdict === 'fits') return { title: 'Fits comfortably', detail: `${formatModelBytes(fit.required.total)} estimated working set` }
  if (fit.verdict === 'fits-partial-offload') return { title: 'Partial GPU offload', detail: 'Expected to use both GPU and system memory' }
  if (fit.verdict === 'tight') return { title: 'Tight fit', detail: 'A smaller context or quant may be safer' }
  if (fit.verdict === 'exceeds') return { title: 'May exceed memory', detail: 'Flint will not block it, but a smaller quant is recommended' }
  return { title: 'Fit unknown', detail: 'Not enough local hardware or file-size information' }
}

function HuggingFaceModelDetail() {
  const navigate = useNavigate()
  const { modelId } = useParams({ strict: false }) as { modelId?: string }
  const search = useSearch({ strict: false }) as { repo?: string }
  const token = useGeneralSetting((state) => state.huggingfaceToken)
  const { hardware, devices } = useFitContext()
  const repo = search.repo || modelId || ''

  const [model, setModel] = useState<HuggingFaceModel | null>(null)
  const [files, setFiles] = useState<NonNullable<HuggingFaceModel['files']>>([])
  const [readme, setReadme] = useState('')
  const [loading, setLoading] = useState(true)
  const [readmeLoading, setReadmeLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [kvArchitecture, setKvArchitecture] = useState<KvArchitecture | null>(null)

  useEffect(() => {
    if (!repo.includes('/')) {
      setError('A full Hugging Face repository id is required.')
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    const run = async () => {
      try {
        const results = await searchHuggingFaceModels(repo, token, 'all')
        const exact = results.find((candidate) => candidate.id.toLowerCase() === repo.toLowerCase()) ?? results[0]
        if (!exact) throw new Error('Model repository not found on Hugging Face.')
        let repoFiles = exact.files ?? []
        if (!repoFiles.length) repoFiles = await getHuggingFaceFiles(exact.id, token)
        if (!cancelled) {
          setModel(exact)
          setFiles(repoFiles)
        }
        setReadmeLoading(true)
        const markdown = await getHuggingFaceReadme(exact.id, token).catch(() => '')
        if (!cancelled) setReadme(markdown)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) {
          setLoading(false)
          setReadmeLoading(false)
        }
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [repo, token])

  const groups = useMemo(() => groupHuggingFaceFiles(files), [files])
  const variants = useMemo(() => groups.filter((group) => group.kind === 'model'), [groups])
  const mmprojCount = groups.filter((group) => group.kind === 'mmproj').length
  const draftCount = groups.filter((group) => group.kind === 'draft').length
  const fitContext = useMemo(
    () => ({
      hardware,
      devices,
      architecture: kvArchitecture,
      parameterBillions: model ? inferParameterCount(model) : null,
    }),
    [hardware, devices, kvArchitecture, model]
  )
  const recommended = useMemo(() => bestGroup(groups, fitContext), [groups, fitContext])

  // The model's own header sizes its context memory exactly; the estimate
  // covers the moment before it arrives and any repository it cannot be read from.
  useEffect(() => {
    if (!model || variants.length === 0) return
    let cancelled = false
    void loadRepoArchitecture(model.id, groups, token).then((value) => {
      if (!cancelled) setKvArchitecture(value)
    })
    return () => {
      cancelled = true
    }
  }, [model, groups, variants.length, token])
  const isMlx = Boolean(model && (repoLooksMlx(model) || (files.some((file) => file.name.endsWith('.safetensors')) && variants.length === 0)))
  const mlxFiles = files.filter(isMlxRuntimeFile)
  const mlxSize = mlxFiles.every((file) => typeof file.size === 'number')
    ? mlxFiles.reduce((sum, file) => sum + (file.size ?? 0), 0)
    : null

  if (loading) {
    return (
      <div className="grid h-full place-items-center text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-2"><LoaderCircle className="size-4 animate-spin" /> Loading model…</span>
      </div>
    )
  }

  if (error || !model) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-border p-3">
          <Button variant="ghost" size="sm" onClick={() => navigate({ to: route.hub.index })}><ArrowLeft className="size-4" /> Discover</Button>
        </div>
        <div className="grid flex-1 place-items-center px-6 text-center">
          <div>
            <p className="font-medium">Model not available</p>
            <p className="mt-1 max-w-lg text-sm text-muted-foreground">{error || 'Hugging Face did not return this repository.'}</p>
          </div>
        </div>
      </div>
    )
  }

  const parameterCount = inferParameterCount(model)
  const architecture = inferArchitecture(model)
  const modalities = inferModalities(model, files)
  const license = typeof model.cardData?.license === 'string' ? model.cardData.license : undefined
  const hasTools = model.tags.some((tag) => /tool|function-call/i.test(tag))

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate({ to: route.hub.index })}><ArrowLeft className="size-4" /> Discover</Button>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(model.id)
                toast.success('Repository id copied')
              }}
            >
              <Copy className="size-3.5" /> Copy repo
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={`https://huggingface.co/${model.id}`} target="_blank" rel="noreferrer">Open on Hugging Face <ExternalLink className="size-3.5" /></a>
            </Button>
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
        <div className="mx-auto max-w-5xl space-y-7">
          <section>
            <div className="flex items-center gap-2.5">
              <HuggingFaceAvatar
                author={model.author || model.id.split('/')[0]}
                modelId={model.id}
                size={28}
              />
              <p className="text-sm text-muted-foreground">{model.author || model.id.split('/')[0]}</p>
            </div>
            <div className="mt-1 flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <h1 className="break-words text-2xl font-semibold tracking-tight">{model.id.split('/').slice(1).join('/') || model.id}</h1>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {parameterCount != null && <span className="rounded-md bg-muted px-2 py-1 text-xs">{parameterCount}B</span>}
                  {architecture && <span className="rounded-md bg-muted px-2 py-1 text-xs capitalize">{architecture}</span>}
                  <span className="rounded-md bg-muted px-2 py-1 text-xs">{isMlx ? 'MLX' : 'GGUF'}</span>
                  {modalities.map((value) => <span key={value} className="rounded-md bg-muted px-2 py-1 text-xs capitalize">{value}</span>)}
                  {license && <span className="rounded-md bg-muted px-2 py-1 text-xs">{license}</span>}
                  {model.gated && <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs"><LockKeyhole className="size-3" /> Gated</span>}
                </div>
              </div>
              {isMlx ? (
                <HuggingFaceDownloadAction repo={model.id} revision={model.sha} files={files} format="mlx" />
              ) : recommended ? (
                <HuggingFaceDownloadAction repo={model.id} revision={model.sha} group={recommended} groups={groups} />
              ) : null}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1.5"><Download className="size-4" /> {model.downloads.toLocaleString()} downloads</span>
              <span className="inline-flex items-center gap-1.5"><Heart className="size-4" /> {model.likes.toLocaleString()} likes</span>
              {modalities.some((value) => value === 'vision' || value === 'multimodal') && <span className="inline-flex items-center gap-1.5"><Eye className="size-4" /> Vision</span>}
              {hasTools && <span className="inline-flex items-center gap-1.5"><Wrench className="size-4" /> Tool use</span>}
              {model.lastModified && <span>Updated {new Date(model.lastModified).toLocaleDateString()}</span>}
            </div>

            {model.gated && !token && (
              <div className="mt-4 rounded-lg border border-border bg-muted/50 p-3 text-sm">
                This repository is gated. Accept its license on Hugging Face, then add a Hugging Face token in Flint Settings before downloading.
              </div>
            )}
          </section>

          {isMlx ? (
            <section className="rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="font-semibold">MLX model bundle</h2>
                  <p className="mt-1 text-sm text-muted-foreground">{mlxFiles.length} runtime files · {formatModelBytes(mlxSize)}</p>
                </div>
                <HuggingFaceDownloadAction repo={model.id} revision={model.sha} files={files} format="mlx" />
              </div>
            </section>
          ) : (
            <section>
              <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2"><FileCode2 className="size-4 text-muted-foreground" /><h2 className="font-semibold">Variants ({variants.length})</h2></div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {mmprojCount > 0 ? `${mmprojCount} vision projector${mmprojCount === 1 ? '' : 's'} detected. ` : ''}
                    {draftCount > 0 ? `${draftCount} speculative draft companion${draftCount === 1 ? '' : 's'} detected.` : ''}
                  </p>
                </div>
                {recommended && <span className="inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary"><Sparkles className="size-3" /> Flint recommends {recommended.quantization || recommended.primary.name}</span>}
              </div>

              <div className="overflow-x-auto rounded-xl border border-border bg-card">
                <table className="w-full min-w-[760px] text-sm">
                  <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2.5 font-medium">Variant</th>
                      <th className="px-3 py-2.5 font-medium">Fit</th>
                      <th className="px-3 py-2.5 font-medium">Size</th>
                      <th className="px-3 py-2.5 font-medium">Files</th>
                      <th className="px-3 py-2.5 text-right font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {variants.map((group) => {
                      const fit = fitOfGroup(group, groups, fitContext)
                      const summary = fitSummary(fit)
                      const isRecommended = recommended?.id === group.id
                      return (
                        <tr key={group.id} className="border-t border-border">
                          <td className="px-3 py-3">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs">{group.quantization || group.primary.name}</span>
                              {isRecommended && <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">Recommended</span>}
                            </div>
                            <p className="mt-1 max-w-md text-xs text-muted-foreground">{explainQuantization(group.quantization)}</p>
                          </td>
                          <td className="px-3 py-3">
                            <span className="text-xs font-medium" title={fitBasis(fit)}>{summary.title}</span>
                            <p className="mt-1 max-w-52 text-[11px] text-muted-foreground">{summary.detail}</p>
                          </td>
                          <td className="px-3 py-3 text-xs tabular-nums text-muted-foreground">{fit.sizeEstimated ? '≈ ' : ''}{formatModelBytes(group.totalSize ?? fit.required.weights)}</td>
                          <td className="px-3 py-3 text-xs text-muted-foreground">{group.multipart ? `${group.files.length} shards` : '1 file'}</td>
                          <td className="px-3 py-3 text-right"><div className="flex justify-end"><HuggingFaceDownloadAction repo={model.id} revision={model.sha} group={group} groups={groups} /></div></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section>
            <h2 className="mb-3 font-semibold">README</h2>
            <div className="rounded-xl border border-border bg-card p-5">
              {readmeLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" /> Loading README…</div>
              ) : readme ? (
                <RenderMarkdown
                  className="reset-heading"
                  components={{ a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}
                  content={readme}
                />
              ) : (
                <p className="text-sm text-muted-foreground">This repository does not expose a README that Flint can display.</p>
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}
