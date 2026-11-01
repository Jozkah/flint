
import { copyToClipboard } from '@/lib/clipboard'
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
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { HuggingFaceAvatar } from '@/containers/HuggingFaceAvatar'
import { HuggingFaceDownloadAction } from '@/containers/HuggingFaceDownloadAction'
import { RenderMarkdown } from '@/containers/RenderMarkdown'
import { route } from '@/constants/routes'
import { desktopOnlyRoute } from '@/lib/desktopOnlyRoute'
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
} from '@/lib/huggingfaceFit'
import { fitSummary } from '@/lib/hubFitSummary'
import type { KvArchitecture } from '@/lib/modelCompatibility'

export const Route = createFileRoute(route.hub.model)({
  // Like the Hub list: a browser served by `flint serve` gets the notice (F10b-004).
  component: desktopOnlyRoute(HuggingFaceModelDetail, 'common:shell.discover'),
  validateSearch: (search: Record<string, unknown>) => ({
    repo: typeof search.repo === 'string' ? search.repo : '',
  }),
})

class DetailError extends Error {
  constructor(readonly key: string) {
    super(key)
  }
}

function HuggingFaceModelDetail() {
  const { t, i18n } = useTranslation()
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
  const [error, setError] = useState<{ key?: string; message?: string } | null>(null)
  const [kvArchitecture, setKvArchitecture] = useState<KvArchitecture | null>(null)

  useEffect(() => {
    if (!repo.includes('/')) {
      setError({ key: 'hub:detail.errorRepoId' })
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    const run = async () => {
      try {
        const results = await searchHuggingFaceModels(repo, token, 'all')
        // Only the requested repo: the first search hit is a different model,
        // which this page would offer to download under the requested name.
        const exact = results.find((candidate) => candidate.id.toLowerCase() === repo.toLowerCase())
        if (!exact) throw new DetailError('hub:detail.errorNotFound')
        let repoFiles = exact.files ?? []
        if (!repoFiles.length) repoFiles = await getHuggingFaceFiles(exact.id, token)
        if (!cancelled) {
          setModel(exact)
          setFiles(repoFiles)
        }
        if (cancelled) return
        setReadmeLoading(true)
        const markdown = await getHuggingFaceReadme(exact.id, token).catch(() => '')
        if (!cancelled) setReadme(markdown)
      } catch (err) {
        if (!cancelled)
          setError(
            err instanceof DetailError
              ? { key: err.key }
              : { message: err instanceof Error ? err.message : String(err) }
          )
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

  const compact = new Intl.NumberFormat(i18n.language, { notation: 'compact' })

  if (loading) {
    return (
      <div className="grid h-full place-items-center text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-2"><LoaderCircle className="size-4 animate-spin" /> {t('hub:detail.loading')}</span>
      </div>
    )
  }

  if (error || !model) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-border p-3">
          <Button variant="ghost" size="sm" onClick={() => navigate({ to: route.hub.index })}><ArrowLeft className="size-4" /> {t('hub:detail.discover')}</Button>
        </div>
        <div className="grid flex-1 place-items-center px-6 text-center">
          <div>
            <p className="font-medium">{t('hub:detail.unavailable')}</p>
            <p className="mt-1 max-w-lg text-sm text-muted-foreground">{error?.key ? t(error.key) : error?.message || t('hub:detail.errorNoRepo')}</p>
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
          <Button variant="ghost" size="sm" onClick={() => navigate({ to: route.hub.index })}><ArrowLeft className="size-4" /> {t('hub:detail.discover')}</Button>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void copyToClipboard(model.id).then((copied) =>
                  copied
                    ? toast.success(t('hub:detail.repoCopied'))
                    : toast.error(t('hub:detail.repoCopyFailed'))
                )
              }}
            >
              <Copy className="size-3.5" /> {t('hub:detail.copyRepo')}
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={`https://huggingface.co/${model.id}`} target="_blank" rel="noreferrer">{t('hub:detail.openOnHf')} <ExternalLink className="size-3.5" /></a>
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
                  {model.gated && <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs"><LockKeyhole className="size-3" /> {t('hub:detail.gatedBadge')}</span>}
                </div>
              </div>
              {isMlx ? (
                <HuggingFaceDownloadAction repo={model.id} revision={model.sha} files={files} format="mlx" />
              ) : recommended ? (
                <HuggingFaceDownloadAction repo={model.id} revision={model.sha} group={recommended} groups={groups} />
              ) : null}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1.5 tabular-nums"><Download className="size-4" /> {compact.format(model.downloads)} {t('hub:detail.downloadsLabel')}</span>
              <span className="inline-flex items-center gap-1.5 tabular-nums"><Heart className="size-4" /> {compact.format(model.likes)} {t('hub:detail.likesLabel')}</span>
              {modalities.some((value) => value === 'vision' || value === 'multimodal') && <span className="inline-flex items-center gap-1.5"><Eye className="size-4" /> {t('hub:detail.vision')}</span>}
              {hasTools && <span className="inline-flex items-center gap-1.5"><Wrench className="size-4" /> {t('hub:detail.toolUse')}</span>}
              {model.lastModified && <span>{t('hub:detail.updated', { date: new Date(model.lastModified).toLocaleDateString(i18n.language) })}</span>}
            </div>

            {model.gated && !token && (
              <div className="mt-4 rounded-lg border border-border bg-muted/50 p-3 text-sm">
                {t('hub:detail.gatedNotice')}
              </div>
            )}
          </section>

          {isMlx ? (
            <section className="rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="font-semibold">{t('hub:detail.mlxBundle')}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">{t('hub:detail.mlxFiles', { count: mlxFiles.length, size: formatModelBytes(mlxSize) })}</p>
                </div>
                <HuggingFaceDownloadAction repo={model.id} revision={model.sha} files={files} format="mlx" />
              </div>
            </section>
          ) : (
            <section>
              <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2"><FileCode2 className="size-4 text-muted-foreground" /><h2 className="font-semibold">{t('hub:detail.variantsHeading', { count: variants.length })}</h2></div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {mmprojCount > 0 ? `${t(mmprojCount === 1 ? 'hub:detail.projectorOne' : 'hub:detail.projectorOther', { count: mmprojCount })} ` : ''}
                    {draftCount > 0 ? t(draftCount === 1 ? 'hub:detail.draftOne' : 'hub:detail.draftOther', { count: draftCount }) : ''}
                  </p>
                </div>
                {recommended && <span className="inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary"><Sparkles className="size-3" /> {t('hub:detail.recommends', { name: recommended.quantization || recommended.primary.name })}</span>}
              </div>

              <ul className="flex flex-col gap-2 sm:hidden" data-testid="variant-cards">
                {variants.map((group) => {
                  const fit = fitOfGroup(group, groups, fitContext)
                  const summary = fitSummary(fit)
                  const isRecommended = recommended?.id === group.id
                  return (
                    <li key={group.id} className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs">{group.quantization || group.primary.name}</span>
                        {isRecommended && <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[length:calc(var(--ui-font-base)*0.625)] font-medium text-primary">{t('hub:detail.recommended')}</span>}
                        <span className="ml-auto text-xs tabular-nums text-muted-foreground">{fit.sizeEstimated ? '≈ ' : ''}{formatModelBytes(group.totalSize ?? fit.required.weights)} · {group.multipart ? t('hub:detail.shards', { count: group.files.length }) : t('hub:detail.oneFile')}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">{explainQuantization(group.quantization)}</p>
                      <div>
                        <span className="text-xs font-medium" title={fitBasis(fit)}>{t(summary.titleKey)}</span>
                        <p className="mt-0.5 text-[length:calc(var(--ui-font-base)*0.6875)] text-muted-foreground">{t(summary.detailKey, summary.detailValues)}</p>
                      </div>
                      <div className="flex justify-end"><HuggingFaceDownloadAction repo={model.id} revision={model.sha} group={group} groups={groups} /></div>
                    </li>
                  )
                })}
              </ul>

              <div className="overflow-x-auto rounded-xl border border-border bg-card max-sm:hidden">
                <table className="w-full min-w-[760px] text-sm">
                  <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2.5 font-medium">{t('hub:detail.colVariant')}</th>
                      <th className="px-3 py-2.5 font-medium">{t('hub:detail.colFit')}</th>
                      <th className="px-3 py-2.5 font-medium">{t('hub:detail.colSize')}</th>
                      <th className="px-3 py-2.5 font-medium">{t('hub:detail.colFiles')}</th>
                      <th className="px-3 py-2.5 text-right font-medium">{t('hub:detail.colAction')}</th>
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
                              {isRecommended && <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[length:calc(var(--ui-font-base)*0.625)] font-medium text-primary">{t('hub:detail.recommended')}</span>}
                            </div>
                            <p className="mt-1 max-w-md text-xs text-muted-foreground">{explainQuantization(group.quantization)}</p>
                          </td>
                          <td className="px-3 py-3">
                            <span className="text-xs font-medium" title={fitBasis(fit)}>{t(summary.titleKey)}</span>
                            <p className="mt-1 max-w-52 text-[length:calc(var(--ui-font-base)*0.6875)] text-muted-foreground">{t(summary.detailKey, summary.detailValues)}</p>
                          </td>
                          <td className="px-3 py-3 text-xs tabular-nums text-muted-foreground">{fit.sizeEstimated ? '≈ ' : ''}{formatModelBytes(group.totalSize ?? fit.required.weights)}</td>
                          <td className="px-3 py-3 text-xs text-muted-foreground">{group.multipart ? t('hub:detail.shards', { count: group.files.length }) : t('hub:detail.oneFile')}</td>
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
            <h2 className="mb-3 font-semibold">{t('hub:detail.readme')}</h2>
            <div className="rounded-xl border border-border bg-card p-5">
              {readmeLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" /> {t('hub:detail.readmeLoading')}</div>
              ) : readme ? (
                <RenderMarkdown
                  className="reset-heading"
                  components={{ a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}
                  content={readme}
                />
              ) : (
                <p className="text-sm text-muted-foreground">{t('hub:detail.readmeMissing')}</p>
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}
