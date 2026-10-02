import { useEffect, useMemo, useState } from 'react'
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
  const navigate = useNavigate()
  const status = useStudio((s) => s.status)
  const refresh = useStudio((s) => s.refresh)
  const [models, setModels] = useState<HuggingFaceModel[]>([])
  const [families, setFamilies] = useState<StudioFamily[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [files, setFiles] = useState<Record<string, HuggingFaceFile[]>>({})
  const [family, setFamily] = useState<Record<string, string>>({})
  const [adding, setAdding] = useState<string | null>(null)

  useEffect(() => {
    void studioApi
      .families()
      .then(setFamilies)
      .catch(() => undefined)
    void refresh()
  }, [refresh])

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

  const toggle = async (repo: string) => {
    const opening = open !== repo
    setOpen(opening ? repo : null)
    if (!opening) return
    let known = files[repo] ?? []
    // The search lists file names only; sizes (and the order they give) come from the file listing.
    if (!known.length || known.some((f) => f.size == null)) {
      try {
        known = await getHuggingFaceFiles(repo, token)
        setFiles((current) => ({ ...current, [repo]: known }))
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    }
    const first = weightsFiles(known)[0]
    if (first) {
      const guess = await studioApi.guessFamily(repo, first.name).catch(() => null)
      // A choice made while the guess was on its way wins over it.
      if (guess) setFamily((current) => (current[repo] ? current : { ...current, [repo]: guess }))
    }
  }

  const add = async (model: HuggingFaceModel, file: HuggingFaceFile) => {
    const chosen = family[model.id]
    if (!chosen) return toast.error('Pick what kind of model this is first.')
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
      toast.success(`${added.display_name} added to Studio`, {
        action: {
          label: 'Open Studio',
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
        <p className="text-[13px] text-secondary-foreground">
          Picture models in the GGUF format that Studio can run. Pick a weights
          file and what kind of model it is; the text encoder and VAE it needs
          are downloaded with it and checked like every other download.
        </p>

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
            title="No picture models found"
            description="Try a broader search, for example qwen image, flux or z-image."
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
                      <span className="truncate text-[15px] font-semibold">
                        <span className="font-normal text-muted-foreground">
                          {rest.length ? `${author} / ` : ''}
                        </span>
                        {name}
                      </span>
                      <Chip mono>GGUF</Chip>
                      {restricted && <Chip tone="warn">{license}</Chip>}
                      {model.gated && (
                        <Chip tone="warn">
                          <LockKeyhole /> Gated
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
                  {opened ? 'Hide files' : 'Choose a file'}
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
                  <label className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    What kind of model is this?
                    <select
                      className={SELECT}
                      value={family[model.id] ?? ''}
                      onChange={(e) =>
                        setFamily((current) => ({
                          ...current,
                          [model.id]: e.target.value,
                        }))
                      }
                      aria-label="Model family"
                    >
                      <option value="">Pick one…</option>
                      {families.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                    {family[model.id] && (
                      <span>
                        {
                          families.find((f) => f.id === family[model.id])
                            ?.description
                        }
                      </span>
                    )}
                  </label>
                  {list.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No weights files (.gguf) in this repository.
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
                              <span className="font-mono text-[13px] font-semibold">
                                {quantizationFromFilename(file.name) ??
                                  file.name}
                              </span>
                              <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                                {formatModelBytes(file.size)}
                              </span>
                              <div className="truncate text-[11.5px] text-muted-foreground">
                                {file.name}
                              </div>
                            </div>
                            {isAdded ? (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => navigate({ to: route.studio })}
                              >
                                <Check className="size-3.5" /> In Studio
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                disabled={adding === key || !family[model.id]}
                                onClick={() => void add(model, file)}
                              >
                                <Plus className="size-3.5" />
                                {adding === key ? 'Adding…' : 'Add to Studio'}
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
