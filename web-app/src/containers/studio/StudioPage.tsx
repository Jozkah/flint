import { useEffect, useMemo, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { Download, Loader, Square, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Segmented } from '@/components/ui/segmented'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EnginePage, PageHead } from '@/containers/engine/EngineKit'
import { useStudio } from '@/hooks/useStudio'
import { useFitContext } from '@/hooks/useFitContext'
import { formatModelBytes } from '@/lib/huggingface'
import { formatEta } from '@/lib/downloadSpeed'
import {
  IMAGE_SIZES,
  VIDEO_SECONDS,
  VIDEO_SIZES,
  durationText,
  framesForSeconds,
  parseSeed,
  phaseLabel,
  videoMemoryWarning,
} from '@/lib/studio/helpers'
import {
  studioApi,
  type EngineBuild,
  type GalleryItem,
  type StudioKind,
  type StudioModel,
} from '@/lib/studio/studio'

const BUILDS: Array<{ id: EngineBuild; label: string; note: string }> = [
  { id: 'win-vulkan-x64', label: 'Any graphics card', note: 'About 30 MB. Works on NVIDIA, AMD and Intel.' },
  { id: 'win-cuda12-x64', label: 'NVIDIA (faster)', note: 'About 900 MB. Needs a recent NVIDIA driver.' },
  { id: 'win-cpu-x64', label: 'No graphics card', note: 'About 17 MB. Very slow.' },
]

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="mb-3 text-sm font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  )
}

function EngineSetup() {
  const status = useStudio((s) => s.status)
  const installing = useStudio((s) => s.installing)
  const install = useStudio((s) => s.installEngine)
  const [build, setBuild] = useState<EngineBuild>('win-vulkan-x64')
  if (!status) return null
  if (!status.supported) {
    return (
      <Card title="Not available on this system yet">
        <p className="text-sm text-muted-foreground">
          Image and video generation works on Windows for now. It is not built for this system yet.
        </p>
      </Card>
    )
  }
  if (status.engineBackend) return null
  const percent = installing?.total ? Math.round((installing.downloaded / installing.total) * 100) : 0
  return (
    <Card title="Set up the image engine">
      <p className="mb-3 text-sm text-muted-foreground">
        Flint makes images and video on this computer with stable-diffusion.cpp. The engine is downloaded once, checked
        against its published checksum, and runs only while you generate.
      </p>
      <div className="mb-3 grid gap-2 sm:grid-cols-3">
        {BUILDS.map((b) => (
          <button
            key={b.id}
            type="button"
            disabled={!!installing}
            onClick={() => setBuild(b.id)}
            className={`rounded-lg border p-3 text-left text-sm ${build === b.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted'}`}
          >
            <div className="font-medium">{b.label}</div>
            <div className="text-xs text-muted-foreground">{b.note}</div>
          </button>
        ))}
      </div>
      {installing && (
        <div className="mb-3 space-y-1">
          <Progress value={installing.stage === 'download' ? percent : 100} className="h-1.5" />
          <p className="text-xs text-muted-foreground">
            {installing.stage === 'download'
              ? `Downloading… ${percent}%`
              : installing.stage === 'unpack'
                ? 'Unpacking…'
                : 'Checking that it starts…'}
          </p>
        </div>
      )}
      <Button disabled={!!installing} onClick={() => void install(build)}>
        {installing ? 'Installing…' : 'Download and install'}
      </Button>
    </Card>
  )
}

function ModelCard({ model }: { model: StudioModel }) {
  const status = useStudio((s) => s.status)
  const download = useStudio((s) => s.download)
  const job = useStudio((s) => s.job)
  const downloadModel = useStudio((s) => s.downloadModel)
  const load = useStudio((s) => s.load)
  const unload = useStudio((s) => s.unload)
  const [loading, setLoading] = useState(false)
  const resident = status?.resident?.model_id === model.id
  const downloading = download?.modelId === model.id
  const percent = downloading && download.total ? Math.round((download.bytes / download.total) * 100) : 0
  const engineReady = !!status?.engineBackend

  return (
    <Card title={model.display_name}>
      <p className="mb-3 text-sm text-muted-foreground">
        {formatModelBytes(model.totalBytes)} of files · {model.license}
        {resident ? ' · loaded' : ''}
      </p>
      {downloading && (
        <div className="mb-3 space-y-1">
          <Progress value={percent} className="h-1.5" />
          <p className="text-xs text-muted-foreground">
            Downloading… {formatModelBytes(download.bytes)} of {formatModelBytes(download.total)}
          </p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {!model.installed ? (
          <Button disabled={downloading} onClick={() => void downloadModel(model)}>
            <Download className="mr-2 size-4" />
            {downloading ? 'Downloading…' : `Download (${formatModelBytes(model.totalBytes)})`}
          </Button>
        ) : resident ? (
          <Button variant="outline" disabled={!!job} onClick={() => void unload()}>
            Unload
          </Button>
        ) : (
          <Button
            disabled={!engineReady || loading || !!job}
            onClick={async () => {
              setLoading(true)
              await load(model.id)
              setLoading(false)
            }}
          >
            {loading ? 'Loading…' : 'Load'}
          </Button>
        )}
      </div>
      {!engineReady && model.installed && (
        <p className="mt-2 text-xs text-muted-foreground">Install the image engine above to use this model.</p>
      )}
    </Card>
  )
}

function Generator({ kind, model }: { kind: StudioKind; model: StudioModel }) {
  const status = useStudio((s) => s.status)
  const job = useStudio((s) => s.job)
  const generate = useStudio((s) => s.generate)
  const cancel = useStudio((s) => s.cancel)
  const { hardware } = useFitContext()
  const sizes = kind === 'video' ? VIDEO_SIZES : IMAGE_SIZES
  const [prompt, setPrompt] = useState('')
  const [negative, setNegative] = useState('')
  const [sizeIndex, setSizeIndex] = useState(0)
  const [count, setCount] = useState(1)
  const [seconds, setSeconds] = useState(VIDEO_SECONDS[VIDEO_SECONDS.length - 1])
  const [seed, setSeed] = useState('')
  const [accepted, setAccepted] = useState(false)
  const size = sizes[Math.min(sizeIndex, sizes.length - 1)]
  const warning = kind === 'video' ? videoMemoryWarning(hardware.total_memory) : null
  const ready = status?.resident?.model_id === model.id
  const running = job?.kind === kind

  const start = async () => {
    const text = prompt.trim()
    if (!text) return toast.error('Write a prompt first.')
    const common = {
      model: model.id,
      prompt: text,
      negative_prompt: negative.trim() || undefined,
      width: size.width,
      height: size.height,
      seed: parseSeed(seed),
    }
    const ok = await generate(kind, () =>
      kind === 'video'
        ? studioApi.generateVideo({ ...common, frames: framesForSeconds(seconds, model.video?.fps ?? 24) })
        : studioApi.generateImage({ ...common, count })
    )
    if (ok) toast.success(kind === 'video' ? 'Video ready' : 'Image ready')
  }

  return (
    <Card title={kind === 'video' ? 'Make a video' : 'Make an image'}>
      <div className="space-y-3">
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={kind === 'video' ? 'A cat walking through a rainy alley, cinematic' : 'A lighthouse on a cliff at sunrise, oil painting'}
          disabled={running}
          aria-label="Prompt"
        />
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Avoid, seed and more</summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <Input
              value={negative}
              onChange={(e) => setNegative(e.target.value)}
              placeholder="What to avoid"
              disabled={running}
              aria-label="What to avoid"
            />
            <Input
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              placeholder="Seed (blank = random)"
              disabled={running}
              aria-label="Seed"
            />
          </div>
        </details>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2">
            Size
            <select
              className="rounded-md border border-border bg-card px-2 py-1"
              value={sizeIndex}
              onChange={(e) => setSizeIndex(Number(e.target.value))}
              disabled={running}
            >
              {sizes.map((s, i) => (
                <option key={s.label} value={i}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          {kind === 'image' ? (
            <label className="flex items-center gap-2">
              Images
              <select
                className="rounded-md border border-border bg-card px-2 py-1"
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
                disabled={running}
              >
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="flex items-center gap-2">
              Length
              <select
                className="rounded-md border border-border bg-card px-2 py-1"
                value={seconds}
                onChange={(e) => setSeconds(Number(e.target.value))}
                disabled={running}
              >
                {VIDEO_SECONDS.map((n) => (
                  <option key={n} value={n}>
                    {n} s
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {warning && (
          <label className="flex items-start gap-2 rounded-lg border border-border bg-muted p-3 text-xs">
            <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="mt-0.5" />
            <span>{warning} I understand and want to continue.</span>
          </label>
        )}
        {running ? (
          <div className="space-y-2">
            <Progress value={Math.round((job?.fraction ?? 0) * 100)} className="h-1.5" />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {phaseLabel(job?.phase ?? 'queued')} · {Math.round((job?.fraction ?? 0) * 100)}%
                {job?.startedAt && job.fraction > 0.05 && job.fraction < 0.97
                  ? ` · about ${formatEta(((Date.now() - job.startedAt) / 1000) * ((1 - job.fraction) / job.fraction))} left`
                  : ''}
              </span>
              <Button variant="outline" size="sm" onClick={() => void cancel()}>
                <Square className="mr-1 size-3" /> Stop
              </Button>
            </div>
          </div>
        ) : (
          <Button disabled={!ready || !!job || (!!warning && !accepted)} onClick={() => void start()}>
            {ready ? 'Generate' : 'Load the model first'}
          </Button>
        )}
      </div>
    </Card>
  )
}

function Viewer({ item, onClose }: { item: GalleryItem | null; onClose: () => void }) {
  const remove = useStudio((s) => s.remove)
  if (!item) return null
  const src = convertFileSrc(item.path)
  const r = item.recipe
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{r.modelName}</DialogTitle>
          <DialogDescription>
            {r.width} × {r.height} · {r.steps} steps · seed {r.seed}
            {r.frames ? ` · ${r.frames} frames` : ''} · {durationText(r.durationMs)}
          </DialogDescription>
        </DialogHeader>
        {item.kind === 'video' ? (
          <video src={src} controls className="max-h-[60vh] w-full rounded-lg bg-black" />
        ) : (
          <img src={src} alt={r.prompt} className="max-h-[60vh] w-full rounded-lg object-contain" />
        )}
        <p className="text-sm">{r.prompt}</p>
        {r.negativePrompt && <p className="text-xs text-muted-foreground">Avoid: {r.negativePrompt}</p>}
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => {
              void navigator.clipboard?.writeText(r.prompt)
              toast('Prompt copied')
            }}
          >
            Copy prompt
          </Button>
          <Button
            variant="outline"
            className="text-destructive"
            onClick={async () => {
              await remove(item.kind, item.id)
              onClose()
            }}
          >
            <Trash2 className="mr-1 size-4" /> Delete
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Gallery({ kind }: { kind: StudioKind }) {
  const items = useStudio((s) => s.gallery[kind])
  const [open, setOpen] = useState<GalleryItem | null>(null)
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing here yet. What you make appears here.</p>
  }
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setOpen(item)}
            className="group relative aspect-square overflow-hidden rounded-lg border border-border bg-muted"
            aria-label={item.recipe.prompt}
          >
            {item.kind === 'video' ? (
              <video src={convertFileSrc(item.path)} muted preload="metadata" className="size-full object-cover" />
            ) : (
              <img src={convertFileSrc(item.path)} alt={item.recipe.prompt} loading="lazy" className="size-full object-cover" />
            )}
          </button>
        ))}
      </div>
      <Viewer item={open} onClose={() => setOpen(null)} />
    </>
  )
}

export function StudioPage() {
  const status = useStudio((s) => s.status)
  const error = useStudio((s) => s.error)
  const refresh = useStudio((s) => s.refresh)
  const refreshGallery = useStudio((s) => s.refreshGallery)
  const clearError = useStudio((s) => s.clearError)
  const [kind, setKind] = useState<StudioKind>('image')

  useEffect(() => {
    void refresh()
    void refreshGallery('image')
    void refreshGallery('video')
  }, [refresh, refreshGallery])

  const model = useMemo(() => status?.models.find((m) => m.kind === kind), [status, kind])

  return (
    <EnginePage testId="studio-page">
      <PageHead
        title="Studio"
        description="Make images and video on this computer. Nothing is sent anywhere."
        actions={
          <Segmented<StudioKind>
            aria-label="What to make"
            options={[
              { value: 'image', label: 'Images' },
              { value: 'video', label: 'Video' },
            ]}
            value={kind}
            onValueChange={setKind}
          />
        }
      />
      {error && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
        >
          <span className="min-w-0 break-words">{error}</span>
          <button type="button" aria-label="Dismiss" onClick={clearError}>
            <X className="size-4" />
          </button>
        </div>
      )}
      {!status ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader className="size-4 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          <EngineSetup />
          {status.supported && model && (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
              <ModelCard model={model} />
              <Generator kind={kind} model={model} />
            </div>
          )}
          <section>
            <h2 className="mb-3 text-sm font-semibold">{kind === 'video' ? 'Your videos' : 'Your images'}</h2>
            <Gallery kind={kind} />
          </section>
        </>
      )}
    </EnginePage>
  )
}
