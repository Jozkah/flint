import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useNavigate } from '@tanstack/react-router'
import {
  Check,
  ChevronDown,
  Download,
  Heart,
  ImageIcon,
  LockKeyhole,
  Plus,
  Search,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { HuggingFaceAvatar } from '@/containers/HuggingFaceAvatar'
import { route } from '@/constants/routes'
import { cn } from '@/lib/utils'
import {
  formatModelBytes,
  getHuggingFaceFiles,
  quantizationFromFilename,
  searchHuggingFaceModels,
  type HuggingFaceFile,
  type HuggingFaceModel,
} from '@/lib/huggingface'
import { studioApi, type StudioFamily } from '@/lib/studio/studio'
import { useStudio } from '@/hooks/useStudio'
import { pickLicense, weightsFiles } from '@/lib/studio/discover'
import { Select } from '@/components/ui/select'

const SELECT =
  'h-8 cursor-pointer rounded-lg border-[0.8px] border-border bg-card px-2 text-xs text-foreground transition-colors hover:border-border-strong'

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

/**
 * Picture models on Hugging Face that Studio can run, for the Discover page: GGUF
 * repositories tagged for text-to-image. A weights file is chosen, the family it
 * belongs to decides what else gets downloaded, and Studio takes it from there.
 */
export function StudioDiscover({
  query,
  token,
}: {
  query: string
  token?: string
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const status = useStudio((s) => s.status)
  const refresh = useStudio((s) => s.refresh)
  const [models, setModels] = useState<HuggingFaceModel[]>([])
  const [families, setFamilies] = useState<StudioFamily[]>([])
  const [familiesError, setFamiliesError] = useState<string | null>(null)
  const [filesError, setFilesError] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [files, setFiles] = useState<Record<string, HuggingFaceFile[]>>({})
  const [family, setFamily] = useState<Record<string, string>>({})
  const [adding, setAdding] = useState<string | null>(null)

  const loadFamilies = useCallback(() => {
    setFamiliesError(null)
    return studioApi
      .families()
      .then(setFamilies)
      .catch((err) =>
        setFamiliesError(err instanceof Error ? err.message : String(err))
      )
  }, [])

  useEffect(() => {
    void loadFamilies()
    void refresh()
  }, [refresh, loadFamilies])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    searchHuggingFaceModels(query, token, 'image')
      .then((result) => {
        if (cancelled) return
        setModels(result)
        setFiles((current) => {
          const next = { ...current }
          for (const model of result)
            if (model.files?.length) next[model.id] = model.files
          return next
        })
      })
      .catch(
        (err) =>
          !cancelled &&
          setError(err instanceof Error ? err.message : String(err))
      )
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [query, token])

  const added = useMemo(
    () =>
      new Set(
        (status?.models ?? [])
          .filter((m) => m.custom)
          .map((m) => `${m.files[0]?.repo}/${m.files[0]?.filename}`)
      ),
    [status]
  )

  const loadFiles = async (repo: string) => {
    let known = files[repo] ?? []
    // The search lists file names only; sizes (and the order they give) come from the file listing.
    if (!known.length || known.some((f) => f.size == null)) {
      try {
        known = await getHuggingFaceFiles(repo, token)
        setFiles((current) => ({ ...current, [repo]: known }))
        setFilesError((current) => {
          const next = { ...current }
          delete next[repo]
          return next
        })
      } catch (err) {
        setFilesError((current) => ({
          ...current,
          [repo]: err instanceof Error ? err.message : String(err),
        }))
        return
      }
    }
    const first = weightsFiles(known)[0]
    if (first) {
      const guess = await studioApi.guessFamily(repo, first.name).catch(() => null)
      // A choice made while the guess was on its way wins over it.
      if (guess) setFamily((current) => (current[repo] ? current : { ...current, [repo]: guess }))
    }
  }

  const toggle = async (repo: string) => {
    const opening = open !== repo
    setOpen(opening ? repo : null)
    if (!opening) return
    await loadFiles(repo)
  }

  const add = async (model: HuggingFaceModel, file: HuggingFaceFile) => {
    if (!status?.supported) {
      toast.error(t('studio:discover.unsupportedToast'))
      return
    }
    const chosen = family[model.id]
    if (!chosen) return toast.error(t('studio:discover.pickKindFirst'))
    setAdding(`${model.id}/${file.name}`)
    try {
      const added = await studioApi.addCustomModel({
        repo: model.id,
        filename: file.name,
        family: chosen,
        displayName:
          `${model.id.split('/').pop()} ${quantizationFromFilename(file.name) ?? ''}`.trim(),
        license: pickLicense(model),
        token,
      })
      await refresh()
      toast.success(t('studio:discover.added', { name: added.display_name }), {
        action: {
          label: t('studio:discover.openStudio'),
          onClick: () => navigate({ to: route.studio }),
        },
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setAdding(null)
    }
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3">
        {status && !status.supported && (
          <div role="status" className="rounded-xl border border-border bg-muted px-4 py-3 text-sm">
            {t('studio:discover.unsupportedArch')}
          </div>
        )}
        <p className="text-[length:calc(var(--ui-font-base)*0.8125)] text-secondary-foreground">
          {t('studio:discover.intro')}
        </p>

        {familiesError && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          >
            <span>
              {t('studio:discover.familiesError', { error: familiesError })}
            </span>
            <Button
              size="sm"
              variant="outline"
              data-testid="studio-families-retry"
              onClick={() => void loadFamilies()}
            >
              {t('studio:discover.retry')}
            </Button>
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {loading && models.length === 0 && (
          <div className="space-y-3" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="flex gap-3.5 rounded-2xl border-[0.8px] border-border bg-card p-4"
              >
                <Skeleton className="size-11 rounded-xl" />
                <div className="flex-1 space-y-2.5">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && !error && models.length === 0 && (
          <EmptyState
            icon={<Search />}
            title={t('studio:discover.emptyTitle')}
            description={t('studio:discover.emptyDescription')}
            className="min-h-72 rounded-2xl border border-dashed border-border"
          />
        )}

        {models.map((model) => {
          const [author, ...rest] = model.id.split('/')
          const name = rest.join('/') || author
          const list = weightsFiles(files[model.id] ?? model.files ?? [])
          const opened = open === model.id
          const license = pickLicense(model)
          const restricted = /non-?commercial|\bnc\b|other/i.test(license)
          return (
            <article
              key={model.id}
              className="overflow-hidden rounded-2xl border-[0.8px] border-border bg-card shadow-sm transition-[border-color,box-shadow] duration-150 hover:border-border-strong hover:shadow-lift"
            >
              <div className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
                <div className="flex min-w-0 flex-1 gap-3.5">
                  <HuggingFaceAvatar author={author} modelId={model.id} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="truncate text-[length:calc(var(--ui-font-base)*0.9375)] font-semibold">
                        <span className="font-normal text-muted-foreground">
                          {rest.length ? `${author} / ` : ''}
                        </span>
                        {name}
                      </span>
                      <Chip mono>GGUF</Chip>
                      {restricted && <Chip tone="warn">{license}</Chip>}
                      {model.gated && (
                        <Chip tone="warn">
                          <LockKeyhole /> {t('studio:discover.gated')}
                        </Chip>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Download className="size-3.5" />
                        {formatCount(model.downloads)}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Heart className="size-3.5" />
                        {formatCount(model.likes)}
                      </span>
                      {!restricted && <span>{license}</span>}
                    </div>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void toggle(model.id)}
                  aria-expanded={opened}
                >
                  <ImageIcon className="size-3.5" />
                  {opened
                    ? t('studio:discover.hideFiles')
                    : t('studio:discover.chooseFile')}
                  <ChevronDown
                    className={cn(
                      'size-3.5 transition-transform duration-200',
                      opened && 'rotate-180'
                    )}
                  />
                </Button>
              </div>

              {opened && (
                <div className="border-t border-border bg-muted/40 p-3 motion-safe:animate-rise-in">
                  <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <label htmlFor={`studio-family-${model.id}`}>
                      {t('studio:discover.whatKind')}
                    </label>
                    <Select
                      id={`studio-family-${model.id}`}
                      aria-describedby={
                        family[model.id] ? `studio-family-desc-${model.id}` : undefined
                      }
                      className={SELECT}
                      value={family[model.id] ?? ''}
                      onChange={(e) =>
                        setFamily((current) => ({
                          ...current,
                          [model.id]: e.target.value,
                        }))
                      }
                    >
                      <option value="">{t('studio:discover.pickOne')}</option>
                      {families.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.label}
                        </option>
                      ))}
                    </Select>
                    {family[model.id] && (
                      <span id={`studio-family-desc-${model.id}`}>
                        {
                          families.find((f) => f.id === family[model.id])
                            ?.description
                        }
                      </span>
                    )}
                  </div>
                  {filesError[model.id] && list.length === 0 ? (
                    <div
                      role="alert"
                      className="flex flex-wrap items-center gap-2 text-xs text-destructive"
                    >
                      <span>
                        {t('studio:discover.filesError', {
                          error: filesError[model.id],
                        })}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid="studio-files-retry"
                        onClick={() => void loadFiles(model.id)}
                      >
                        {t('studio:discover.retry')}
                      </Button>
                    </div>
                  ) : list.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {t('studio:discover.noWeights')}
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-1.5">
                      {list.map((file) => {
                        const key = `${model.id}/${file.name}`
                        const isAdded = added.has(key)
                        return (
                          <li
                            key={file.name}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border-[0.8px] border-border bg-card px-3 py-2"
                          >
                            <div className="min-w-0">
                              <span className="font-mono text-[length:calc(var(--ui-font-base)*0.8125)] font-semibold">
                                {quantizationFromFilename(file.name) ??
                                  file.name}
                              </span>
                              <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                                {formatModelBytes(file.size)}
                              </span>
                              <div className="truncate text-[length:calc(var(--ui-font-base)*0.71875)] text-muted-foreground">
                                {file.name}
                              </div>
                            </div>
                            {status && !status.supported ? (
                              <Button size="sm" variant="outline" disabled>
                                {t('studio:discover.unsupportedSystem')}
                              </Button>
                            ) : isAdded ? (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => navigate({ to: route.studio })}
                              >
                                <Check className="size-3.5" /> {t('studio:discover.inStudio')}
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                disabled={adding === key || !family[model.id] || !status?.supported}
                                onClick={() => void add(model, file)}
                              >
                                <Plus className="size-3.5" />
                                {adding === key
                                  ? t('studio:discover.adding')
                                  : t('studio:discover.addToStudio')}
                              </Button>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              )}
            </article>
          )
        })}
      </div>
    </main>
  )
}
