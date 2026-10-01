import { useEffect, useMemo, useRef, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { Download, Film, ImageIcon, Loader, RefreshCw, Sparkles, Square, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { EmptyState } from '@/components/ui/empty-state'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Segmented } from '@/components/ui/segmented'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ImageViewer, type ViewerImage } from '@/components/ImageViewer'
import { EnginePage, PageHead } from '@/containers/engine/EngineKit'
import { useStudio, type StudioActivity } from '@/hooks/useStudio'
import { useFitContext } from '@/hooks/useFitContext'
import { cn } from '@/lib/utils'
import { formatModelBytes } from '@/lib/huggingface'
import { formatEta } from '@/lib/downloadSpeed'
import { useArchiveEnabled } from '@/hooks/useArchiveEnabled'
import {
  EXAMPLE_PROMPTS,
  IMAGE_SIZES,
  VIDEO_SECONDS,
  VIDEO_SIZES,
  durationText,
  estimateVideoMs,
  framesForSeconds,
  parseSeed,
  phaseLabel,
  sizeIndexOf,
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

/** What the left column and the stage share: the prompt and the options. */
type Form = {
  prompt: string
  negative: string
  seed: string
  sizeIndex: number
  count: number
  seconds: number
  accepted: boolean
}

const EMPTY_FORM: Form = {
  prompt: '',
  negative: '',
  seed: '',
  sizeIndex: 0,
  count: 1,
  seconds: VIDEO_SECONDS[VIDEO_SECONDS.length - 1],
  accepted: false,
}

const rise = (index: number) => ({ animationDelay: `${40 + Math.min(index, 10) * 35}ms` })

/** A pressable option, like the chips in the design: 28px, a hairline, pressed = filled. */
function Option({
  title,
  pressed,
  disabled,
  onClick,
  children,
  className,
}: {
  pressed: boolean
  title?: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-md border-[0.8px] border-border bg-card px-2.5 text-xs font-medium whitespace-nowrap text-muted-foreground transition-colors duration-150 pointer-coarse:h-11',
        'hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden',
        'aria-pressed:border-input aria-pressed:bg-accent aria-pressed:text-foreground',
        'disabled:pointer-events-none disabled:opacity-50',
        className
      )}
    >
      {children}
    </button>
  )
}

/** A little outline of the picture's shape, so "3:2" can be seen. */
function ShapeGlyph({ width, height }: { width: number; height: number }) {
  const long = 14
  const w = width >= height ? long : Math.round((long * width) / height)
  const h = height >= width ? long : Math.round((long * height) / width)
  return <i aria-hidden className="inline-block rounded-[2px] border-[1.5px] border-current" style={{ width: w, height: h }} />
}

function EngineSetup() {
  const status = useStudio((s) => s.status)
  const installing = useStudio((s) => s.installing)
  const install = useStudio((s) => s.installEngine)
  const [build, setBuild] = useState<EngineBuild>('win-vulkan-x64')
  if (!status) return null
  if (!status.supported) {
    return (
      <Frame className="motion-safe:animate-rise-in">
        <FrameHeader title="Not available on this system yet" />
        <FrameBody className="p-3.5">
          <p className="text-[13px] text-muted-foreground">
            Image and video generation works on Windows for now. It is not built for this system yet.
          </p>
        </FrameBody>
      </Frame>
    )
  }
  if (status.engineBackend) return null
  const percent = installing?.total ? Math.round((installing.downloaded / installing.total) * 100) : 0
  return (
    <Frame className="motion-safe:animate-rise-in">
      <FrameHeader title="Set up the image engine" />
      <FrameBody className="gap-3 p-3.5">
        <p className="text-[13px] text-muted-foreground">
          Flint makes images and video on this computer with stable-diffusion.cpp. The engine is downloaded once,
          checked against its published checksum, and runs only while you generate.
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          {BUILDS.map((b) => (
            <button
              key={b.id}
              type="button"
              disabled={!!installing}
              aria-pressed={build === b.id}
              onClick={() => setBuild(b.id)}
              className="rounded-lg border-[0.8px] border-border p-3 text-left text-[13px] transition-colors duration-150 hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden aria-pressed:border-input aria-pressed:bg-accent disabled:opacity-50"
            >
              <div className="font-medium text-foreground">{b.label}</div>
              <div className="mt-1 text-xs text-muted-foreground">{b.note}</div>
            </button>
          ))}
        </div>
        {installing && (
          <div className="space-y-1.5">
            <Progress value={installing.stage === 'download' ? percent : 100} />
            <p className="text-xs text-muted-foreground">
              {installing.stage === 'download'
                ? `Downloading… ${percent}%`
                : installing.stage === 'unpack'
                  ? 'Unpacking…'
                  : 'Checking that it starts…'}
            </p>
          </div>
        )}
        <div>
          <Button disabled={!!installing} onClick={() => void install(build)}>
            {installing ? 'Installing…' : 'Download and install'}
          </Button>
        </div>
      </FrameBody>
    </Frame>
  )
}

/** The model on the left: what it is, whether it is ready, and the one button to get it ready. */
function ModelBlock({ model }: { model: StudioModel }) {
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
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col items-start gap-2">
        <Chip tone={resident ? 'ok' : 'neutral'} dot>
          {resident ? 'Loaded' : model.installed ? 'Ready' : 'Not downloaded'}
        </Chip>
        <div className="min-w-0">
          <p className="text-[13px] leading-snug font-medium text-foreground">{model.display_name}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatModelBytes(model.totalBytes)} · {model.license}
          </p>
        </div>
      </div>
      {downloading && (
        <div className="space-y-1.5">
          <Progress value={percent} />
          <p className="text-xs text-muted-foreground">
            {formatModelBytes(download.bytes)} of {formatModelBytes(download.total)}
          </p>
        </div>
      )}
      {!model.installed ? (
        <Button size="sm" disabled={downloading} onClick={() => void downloadModel(model)}>
          <Download className="size-3.5" />
          {downloading ? 'Downloading…' : `Download (${formatModelBytes(model.totalBytes)})`}
        </Button>
      ) : resident ? (
        <Button size="sm" variant="outline" disabled={!!job} onClick={() => void unload()}>
          Unload
        </Button>
      ) : (
        <Button
          size="sm"
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
      {!engineReady && model.installed && (
        <p className="text-xs text-muted-foreground">Install the image engine above to use this model.</p>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

function Settings({
  kind,
  model,
  form,
  setForm,
}: {
  kind: StudioKind
  model: StudioModel
  form: Form
  setForm: (patch: Partial<Form>) => void
}) {
  const job = useStudio((s) => s.job)
  const { hardware } = useFitContext()
  const sizes = kind === 'video' ? VIDEO_SIZES : IMAGE_SIZES
  const warning = kind === 'video' ? videoMemoryWarning(hardware.total_memory) : null
  const running = !!job
  const lastClip = useStudio((s) => s.gallery.video[0]?.recipe)
  const guess =
    kind === 'video'
      ? estimateVideoMs(lastClip, {
          width: sizes[Math.min(form.sizeIndex, sizes.length - 1)].width,
          height: sizes[Math.min(form.sizeIndex, sizes.length - 1)].height,
          frames: framesForSeconds(form.seconds, model.video?.fps ?? 24),
          steps: model.defaults.steps,
        })
      : null
  return (
    <Frame className="motion-safe:animate-rise-in" style={rise(0)}>
      <FrameHeader title="Settings" />
      <FrameBody className="gap-4 p-3.5">
        <ModelBlock model={model} />
        <Field label="Shape">
          <div className="flex flex-wrap gap-1.5">
            {sizes.map((s, i) => (
              <Option
                key={s.label}
                title={s.label}
                pressed={form.sizeIndex === i}
                disabled={running}
                onClick={() => setForm({ sizeIndex: i })}
              >
                <ShapeGlyph width={s.width} height={s.height} />
                {s.short}
              </Option>
            ))}
          </div>
        </Field>
        {kind === 'image' ? (
          <Field label="Images">
            <div className="flex flex-wrap gap-1.5">
              {[1, 2, 3, 4].map((n) => (
                <Option key={n} pressed={form.count === n} disabled={running} onClick={() => setForm({ count: n })}>
                  {n}
                </Option>
              ))}
            </div>
          </Field>
        ) : (
          <Field label="Length">
            <div className="flex flex-wrap gap-1.5">
              {VIDEO_SECONDS.map((n) => (
                <Option key={n} pressed={form.seconds === n} disabled={running} onClick={() => setForm({ seconds: n })}>
                  {n} s
                </Option>
              ))}
            </div>
          </Field>
        )}
        {guess !== null && (
          <p className="-mt-2 text-xs text-muted-foreground">
            About {durationText(guess)}, from your last clip.
          </p>
        )}
        <Field label="Seed">
          <Input
            value={form.seed}
            onChange={(e) => setForm({ seed: e.target.value })}
            placeholder="Random"
            disabled={running}
            aria-label="Seed"
          />
        </Field>
        <Field label="Avoid">
          <Input
            value={form.negative}
            onChange={(e) => setForm({ negative: e.target.value })}
            placeholder="Blurry, extra fingers…"
            disabled={running}
            aria-label="What to avoid"
          />
        </Field>
        {warning && (
          <label className="flex items-start gap-2 rounded-lg bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
            <input
              type="checkbox"
              checked={form.accepted}
              onChange={(e) => setForm({ accepted: e.target.checked })}
              className="mt-0.5"
            />
            <span>{warning} I understand and want to continue.</span>
          </label>
        )}
      </FrameBody>
    </Frame>
  )
}

/** A small look at a result, for the strip under the prompt and for the gallery. */
function Thumb({ item, className }: { item: GalleryItem; className?: string }) {
  const src = convertFileSrc(item.path)
  return item.kind === 'video' ? (
    <video src={src} muted preload="metadata" className={cn('size-full object-cover', className)} />
  ) : (
    <img src={src} alt="" loading="lazy" className={cn('size-full object-cover', className)} />
  )
}

function Stage({
  kind,
  model,
  form,
  setForm,
  promptRef,
  onOpen,
}: {
  kind: StudioKind
  model: StudioModel
  form: Form
  setForm: (patch: Partial<Form>) => void
  promptRef: React.RefObject<HTMLTextAreaElement | null>
  onOpen: (index: number) => void
}) {
  const status = useStudio((s) => s.status)
  const job = useStudio((s) => s.job)
  const jobPrompt = useStudio((s) => s.jobPrompt)
  const items = useStudio((s) => s.gallery[kind])
  const generate = useStudio((s) => s.generate)
  const cancel = useStudio((s) => s.cancel)
  const { hardware } = useFitContext()
  const sizes = kind === 'video' ? VIDEO_SIZES : IMAGE_SIZES
  const size = sizes[Math.min(form.sizeIndex, sizes.length - 1)]
  const warning = kind === 'video' ? videoMemoryWarning(hardware.total_memory) : null
  const ready = status?.resident?.model_id === model.id
  const running = job?.kind === kind
  const busy = !!job
  const latest = items[0]
  const percent = Math.round((job?.fraction ?? 0) * 100)
  const examples = EXAMPLE_PROMPTS[kind]

  const start = async () => {
    const text = form.prompt.trim()
    if (!text) return toast.error('Write a prompt first.')
    const common = {
      model: model.id,
      prompt: text,
      negative_prompt: form.negative.trim() || undefined,
      width: size.width,
      height: size.height,
      seed: parseSeed(form.seed),
    }
    const ok = await generate(kind, text, () =>
      kind === 'video'
        ? studioApi.generateVideo({ ...common, frames: framesForSeconds(form.seconds, model.video?.fps ?? 24) })
        : studioApi.generateImage({ ...common, count: form.count })
    )
    if (ok) toast.success(kind === 'video' ? 'Video ready' : 'Image ready')
  }

  return (
    <Frame className="motion-safe:animate-rise-in max-lg:order-first" style={rise(1)}>
      <FrameHeader
        title={kind === 'video' ? 'Video' : 'Image'}
        actions={
          running ? (
            <Chip tone="info" live>
              Making
            </Chip>
          ) : undefined
        }
      />
      <FrameBody className="gap-3 p-3">
        <div
          className="relative mx-auto w-full overflow-hidden rounded-lg bg-muted"
          // Nothing made yet: a compact stage, not a tall empty square.
          style={
            latest
              ? { aspectRatio: `${size.width} / ${size.height}`, maxHeight: '62vh' }
              : { height: 'min(44vh, 360px)' }
          }
        >
          {latest ? (
            kind === 'video' && !running ? (
              <video
                key={latest.id}
                src={convertFileSrc(latest.path)}
                controls
                className="size-full bg-black object-contain motion-safe:animate-rise-in"
              />
            ) : (
              <button
                type="button"
                disabled={running}
                onClick={() => onOpen(0)}
                aria-label="Open the latest result"
                className="block size-full cursor-zoom-in focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden disabled:cursor-default"
              >
                <img
                  key={latest.id}
                  src={convertFileSrc(latest.path)}
                  alt={latest.recipe.prompt}
                  className={cn(
                    'size-full object-contain transition-[filter,transform,opacity] duration-500 ease-expo',
                    running ? 'scale-105 opacity-60 blur-xl' : 'motion-safe:animate-rise-in'
                  )}
                />
              </button>
            )
          ) : (
            !running && (
              <EmptyState
                className="absolute inset-0"
                icon={kind === 'video' ? <Film /> : <ImageIcon />}
                title={kind === 'video' ? 'Your first video starts here' : 'Your first image starts here'}
                description="Describe it below, or try one of the examples."
              />
            )
          )}
          <div
            aria-hidden={!running}
            className={cn(
              'absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-gradient-to-t from-black/70 to-transparent p-4 pt-12 text-white transition-opacity duration-300',
              running ? 'opacity-100' : 'pointer-events-none opacity-0'
            )}
          >
            <p className="line-clamp-1 text-xs opacity-80">{jobPrompt}</p>
            <Progress value={percent} className="h-1 bg-white/25" />
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="tabular-nums">
                {phaseLabel(job?.phase ?? 'queued')} · {percent}%
                {job?.startedAt && job.fraction > 0.05 && job.fraction < 0.97
                  ? ` · about ${formatEta(((Date.now() - job.startedAt) / 1000) * ((1 - job.fraction) / job.fraction))} left`
                  : ''}
              </span>
              <Button variant="secondary" size="sm" onClick={() => void cancel()}>
                <Square className="size-3" /> Stop
              </Button>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2 rounded-xl border-[0.8px] border-border bg-card p-2 transition-shadow duration-200 focus-within:border-input focus-within:shadow-lift sm:flex-row sm:items-end">
          <Textarea
            ref={promptRef}
            value={form.prompt}
            onChange={(e) => setForm({ prompt: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !busy) {
                e.preventDefault()
                void start()
              }
            }}
            rows={2}
            disabled={busy}
            aria-label="Prompt"
            placeholder={kind === 'video' ? 'A cat walking through a rainy alley, cinematic' : 'A lighthouse on a cliff at sunrise, oil painting'}
            className="min-h-0 flex-1 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0"
          />
          <Button
            className="sm:self-stretch"
            disabled={!ready || busy || (!!warning && !form.accepted)}
            onClick={() => void start()}
            title="Ctrl+Enter"
          >
            <Sparkles className="size-3.5" />
            {ready ? 'Generate' : 'Load the model first'}
          </Button>
        </div>

        {!form.prompt && !busy && (
          <div className="flex flex-wrap gap-1.5 motion-safe:animate-rise-in">
            {examples.map((text) => (
              <Option
                key={text}
                pressed={false}
                onClick={() => {
                  setForm({ prompt: text })
                  promptRef.current?.focus()
                }}
              >
                {text}
              </Option>
            ))}
          </div>
        )}

        {items.length > 1 && (
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
            {items.slice(0, 6).map((item, i) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onOpen(i)}
                aria-label={item.recipe.prompt}
                className="aspect-square overflow-hidden rounded-lg border-[0.8px] border-border bg-muted transition-[transform,box-shadow] duration-200 ease-expo hover:-translate-y-0.5 hover:shadow-lift focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden motion-safe:animate-rise-in"
                style={rise(i)}
              >
                <Thumb item={item} />
              </button>
            ))}
          </div>
        )}
      </FrameBody>
    </Frame>
  )
}

const ACTIVITY_TONE = { done: 'ok', failed: 'err', stopped: 'neutral' } as const
const ACTIVITY_LABEL = { done: 'Done', failed: 'Failed', stopped: 'Stopped' } as const

function ActivityRow({ entry }: { entry: StudioActivity }) {
  return (
    <li className="flex min-w-0 flex-col gap-1.5 border-b border-dashed border-border py-2.5 first:pt-0 last:border-b-0 last:pb-0 motion-safe:animate-rise-in">
      <div className="flex items-center gap-2">
        <Chip tone={ACTIVITY_TONE[entry.status]} dot>
          {ACTIVITY_LABEL[entry.status]}
        </Chip>
        <span className="text-xs text-muted-foreground tabular-nums">{durationText(entry.durationMs)}</span>
      </div>
      <p className="line-clamp-2 text-[12.5px] text-foreground">{entry.prompt}</p>
      {entry.error && <p className="line-clamp-3 text-xs break-words text-muted-foreground">{entry.error}</p>}
    </li>
  )
}

function Activity({ kind }: { kind: StudioKind }) {
  const job = useStudio((s) => s.job)
  const jobPrompt = useStudio((s) => s.jobPrompt)
  const activity = useStudio((s) => s.activity)
  const entries = activity.filter((a) => a.kind === kind)
  const percent = Math.round((job?.fraction ?? 0) * 100)
  return (
    <Frame className="motion-safe:animate-rise-in" style={rise(2)}>
      <FrameHeader title="Activity" />
      <FrameBody className="p-3.5">
        {!job && entries.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing yet. Jobs from this session show up here.</p>
        ) : (
          <ul className="flex flex-col">
            {job && (
              <li className="flex min-w-0 flex-col gap-1.5 border-b border-dashed border-border pb-2.5">
                <div className="flex items-center gap-2">
                  <Chip tone="info" live>
                    Making
                  </Chip>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {phaseLabel(job.phase)} · {percent}%
                  </span>
                </div>
                <p className="line-clamp-2 text-[12.5px] text-foreground">{jobPrompt}</p>
                <Progress value={percent} />
              </li>
            )}
            {entries.map((entry) => (
              <ActivityRow key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
      </FrameBody>
    </Frame>
  )
}

/** A video opens in a dialog with its own controls: the image viewer is for pictures. */
export function VideoDialog({ item, onClose }: { item: GalleryItem | null; onClose: () => void }) {
  const remove = useStudio((s) => s.remove)
  const archiveOn = useArchiveEnabled()
  if (!item) return null
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
        <video src={convertFileSrc(item.path)} controls className="max-h-[60vh] w-full rounded-lg bg-black" />
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
            <Trash2 className="size-4" /> {archiveOn ? 'Move to Archive' : 'Delete'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Gallery({
  kind,
  onOpen,
  onRemix,
}: {
  kind: StudioKind
  onOpen: (index: number) => void
  onRemix: (item: GalleryItem) => void
}) {
  const items = useStudio((s) => s.gallery[kind])
  const remove = useStudio((s) => s.remove)
  const archiveOn = useArchiveEnabled()
  return (
    <Frame className="motion-safe:animate-rise-in" style={rise(3)}>
      <FrameHeader
        title={kind === 'video' ? 'Your videos' : 'Your images'}
        actions={
          items.length > 0 ? <span className="text-xs text-muted-foreground tabular-nums">{items.length}</span> : undefined
        }
      />
      <FrameBody className="p-3.5">
        {items.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">Nothing here yet. What you make appears here.</p>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,160px),1fr))] gap-3">
            {items.map((item, i) => (
              <li
                key={item.id}
                className="group relative aspect-square overflow-hidden rounded-lg border-[0.8px] border-border bg-muted transition-[transform,box-shadow] duration-200 ease-expo hover:-translate-y-0.5 hover:shadow-lift motion-safe:animate-rise-in"
                style={rise(i)}
              >
                <button
                  type="button"
                  onClick={() => onOpen(i)}
                  aria-label={item.recipe.prompt}
                  className="absolute inset-0 focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden focus-visible:ring-inset"
                >
                  <Thumb item={item} />
                </button>
                {item.kind === 'video' && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute top-2 left-2 grid size-6 place-items-center rounded-full bg-black/60 text-white"
                  >
                    <Film className="size-3" />
                  </span>
                )}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-1.5 bg-gradient-to-t from-black/75 to-transparent p-2 pt-10 text-white opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
                  <p className="line-clamp-2 text-[11px] leading-snug">{item.recipe.prompt}</p>
                  <div className="flex items-center justify-between gap-1">
                    <span className="truncate text-[10px] opacity-80 tabular-nums">
                      seed {item.recipe.seed} · {durationText(item.recipe.durationMs)}
                    </span>
                    <span className="pointer-events-auto flex shrink-0 gap-1">
                      <button
                        type="button"
                        title="Remix: same prompt, new seed"
                        aria-label="Remix"
                        onClick={() => onRemix(item)}
                        className="grid size-6 place-items-center rounded-md bg-white/15 transition-colors hover:bg-white/30 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-hidden pointer-coarse:size-9"
                      >
                        <RefreshCw className="size-3" />
                      </button>
                      <button
                        type="button"
                        title={archiveOn ? 'Move to Archive' : 'Delete'}
                        aria-label={archiveOn ? 'Move to Archive' : 'Delete'}
                        onClick={() => void remove(item.kind, item.id)}
                        className="grid size-6 place-items-center rounded-md bg-white/15 transition-colors hover:bg-white/30 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-hidden pointer-coarse:size-9"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </FrameBody>
    </Frame>
  )
}

export function StudioPage() {
  const status = useStudio((s) => s.status)
  const error = useStudio((s) => s.error)
  const refresh = useStudio((s) => s.refresh)
  const refreshGallery = useStudio((s) => s.refreshGallery)
  const clearError = useStudio((s) => s.clearError)
  const gallery = useStudio((s) => s.gallery)
  const [kind, setKind] = useState<StudioKind>('image')
  const [form, setFormState] = useState<Form>(EMPTY_FORM)
  const [viewing, setViewing] = useState<number | null>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)

  const setForm = (patch: Partial<Form>) => setFormState((f) => ({ ...f, ...patch }))

  useEffect(() => {
    void refresh()
    void refreshGallery('image')
    void refreshGallery('video')
  }, [refresh, refreshGallery])

  const model = useMemo(() => status?.models.find((m) => m.kind === kind), [status, kind])

  // The sizes differ between images and video, so the chosen shape starts over.
  const changeKind = (next: StudioKind) => {
    setViewing(null)
    setKind(next)
    setForm({ sizeIndex: 0 })
  }

  const remix = (item: GalleryItem) => {
    const sizes = item.kind === 'video' ? VIDEO_SIZES : IMAGE_SIZES
    setForm({
      prompt: item.recipe.prompt,
      negative: item.recipe.negativePrompt,
      seed: '',
      sizeIndex: sizeIndexOf(sizes, item.recipe.width, item.recipe.height),
    })
    promptRef.current?.focus()
    promptRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  // Pictures open in the same viewer the chat uses; a video has its own dialog.
  const shown = gallery[kind]
  const viewerImages = useMemo<ViewerImage[]>(
    () =>
      kind === 'image'
        ? shown.map((g) => ({ url: convertFileSrc(g.path), name: `studio-${g.recipe.seed}` }))
        : [],
    [shown, kind]
  )

  return (
    <EnginePage testId="studio-page">
      <PageHead
        title="Studio"
        description="Make images and video on this computer. Nothing is sent anywhere."
        actions={
          <Segmented<StudioKind>
            aria-label="What to make"
            className="min-w-[200px]"
            options={[
              { value: 'image', label: 'Images' },
              { value: 'video', label: 'Video' },
            ]}
            value={kind}
            onValueChange={changeKind}
          />
        }
      />
      {error && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-lg border-[0.8px] border-destructive/30 bg-destructive/5 p-3 text-[13px] motion-safe:animate-rise-in"
        >
          <span className="min-w-0 break-words">{error}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={clearError}
            className="shrink-0 rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
      {!status ? (
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Loader className="size-4 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          <EngineSetup />
          {status.supported && model && (
            <div className="grid items-start gap-4 lg:grid-cols-[250px_minmax(0,1fr)_270px]">
              <Settings kind={kind} model={model} form={form} setForm={setForm} />
              <Stage
                kind={kind}
                model={model}
                form={form}
                setForm={setForm}
                promptRef={promptRef}
                onOpen={setViewing}
              />
              <Activity kind={kind} />
            </div>
          )}
          <Gallery kind={kind} onOpen={setViewing} onRemix={remix} />
        </>
      )}
      {kind === 'image' && viewing !== null && viewerImages[viewing] && (
        <ImageViewer
          images={viewerImages}
          index={viewing}
          onIndexChange={setViewing}
          onClose={() => setViewing(null)}
        />
      )}
      <VideoDialog item={kind === 'video' && viewing !== null ? (shown[viewing] ?? null) : null} onClose={() => setViewing(null)} />
    </EnginePage>
  )
}
