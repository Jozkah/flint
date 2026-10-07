import { useEffect, useMemo, useRef, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import {
  ArrowLeftRight,
  Box,
  Check,
  ChevronRight,
  ChevronsUpDown,
  CornerDownLeft,
  Dices,
  Download,
  Film,
  ImageIcon,
  Info,
  LayoutGrid,
  List,
  Loader,
  Maximize2,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Ruler,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Switch } from '@/components/ui/switch'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ModelAvatar } from '@/containers/ModelAvatar'
import ProvidersAvatar from '@/containers/ProvidersAvatar'
import { useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { EmptyState } from '@/components/ui/empty-state'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { RefineFrame } from '@/components/ui/refine-frame'
import { refineStatusFor } from '@/lib/refine-frame'
import { useTranslation } from '@/i18n/react-i18next-compat'
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
import { useStudio } from '@/hooks/useStudio'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useFitContext } from '@/hooks/useFitContext'
import { cn } from '@/lib/utils'
import { providerHasRemoteApiKeys } from '@/lib/provider-api-keys'
import {
  cloudTargets,
  customCloudTargets,
  generateCloudImages,
  type CloudTarget,
} from '@/lib/studio/cloud'
import { formatModelBytes } from '@/lib/huggingface'
import { formatEta } from '@/lib/downloadSpeed'
import { useArchiveEnabled } from '@/hooks/useArchiveEnabled'
import {
  EXAMPLE_PROMPTS,
  IMAGE_SIZES,
  VIDEO_SECONDS,
  VIDEO_SIZES,
  customSize,
  downloadProgressText,
  durationText,
  estimateVideoMs,
  framesForSeconds,
  parseSeed,
  parseSide,
  phaseLabel,
  sizeIndexOf,
  snapSide,
  videoMemoryWarning,
} from '@/lib/studio/helpers'
import {
  studioApi,
  type EngineBuild,
  type GalleryItem,
  type StudioKind,
  type StudioModel,
  type StudioLora,
} from '@/lib/studio/studio'

const BUILDS: Array<{ id: EngineBuild; label: string; note: string }> = [
  { id: 'linux-vulkan-x64', label: 'Any graphics card', note: 'About 38 MB. NVIDIA, AMD or Intel with a Vulkan driver.' },
  { id: 'linux-cpu-x64', label: 'No graphics card', note: 'About 25 MB. Very slow.' },
  {
    id: 'win-vulkan-x64',
    label: 'Any graphics card',
    note: 'About 30 MB. Works on NVIDIA, AMD and Intel.',
  },
  {
    id: 'win-cuda12-x64',
    label: 'NVIDIA (faster)',
    note: 'About 900 MB. Needs a recent NVIDIA driver.',
  },
  {
    id: 'win-cpu-x64',
    label: 'No graphics card',
    note: 'About 17 MB. Very slow.',
  },
]

/** What the left column and the stage share: the prompt and the options. */
type Form = {
  prompt: string
  negative: string
  seed: string
  /** The index of a standard shape, or `CUSTOM` for the two boxes. */
  sizeIndex: number
  customWidth: string
  customHeight: string
  /** `provider/model` of a hosted image model, or empty for the model on this computer. */
  cloud: string
  /** The local model chosen, or empty for the first one of the kind. */
  localModel: string
  count: number
  seconds: number
  accepted: boolean
  loras: StudioLora[]
}

const CUSTOM = -1

const EMPTY_FORM: Form = {
  prompt: '',
  negative: '',
  seed: '',
  sizeIndex: 0,
  customWidth: '1024',
  customHeight: '1024',
  cloud: '',
  localModel: '',
  count: 1,
  seconds: VIDEO_SECONDS[VIDEO_SECONDS.length - 1],
  accepted: false,
  loras: [],
}

/** The hosted image models that can be used now: the providers with an API key set, and picture models on the user's own servers. */
function useCloudTargets(kind: StudioKind): CloudTarget[] {
  const providers = useModelProvider((s) => s.providers)
  return useMemo(() => {
    if (kind !== 'image') return []
    const configured = new Set(
      providers
        .filter((p) => p.active && providerHasRemoteApiKeys(p))
        .map((p) => p.provider)
    )
    return [...cloudTargets(configured), ...customCloudTargets(providers)]
  }, [providers, kind])
}

/** The smallest and largest side a custom size may have: the hosted provider's, or the local model's. */
function sideLimits(model: StudioModel, hosted?: CloudTarget): { min: number; max: number } {
  return hosted ? { min: 16, max: hosted.provider.limits.maxEdge } : { min: model.min_side, max: model.max_side }
}

/** The size the form asks for: a standard shape, or the two boxes snapped into range. */
function chosenSize(
  kind: StudioKind,
  model: StudioModel,
  form: Form,
  hosted?: CloudTarget
): { width: number; height: number } {
  if (form.sizeIndex === CUSTOM) {
    return customSize(form.customWidth, form.customHeight, sideLimits(model, hosted), 1024)
  }
  const sizes = kind === 'video' ? VIDEO_SIZES : IMAGE_SIZES
  return sizes[Math.min(Math.max(form.sizeIndex, 0), sizes.length - 1)]
}

const rise = (index: number) => ({
  animationDelay: `${40 + Math.min(index, 10) * 35}ms`,
})

/**
 * The engine for a picture, in the same popover the chat's model picker uses:
 * a search box, models on this computer first, then hosted ones grouped by
 * provider, then the two ways to get more.
 */
function EnginePicker({
  value,
  label,
  providerId,
  modelId,
  local,
  hosted,
  disabled,
  onLocal,
  onHosted,
}: {
  value: string
  label: string
  /** The hosted provider in use, for the mark beside the name. */
  providerId?: string
  modelId: string
  local: Array<{ id: string; name: string }>
  hosted: Array<{ key: string; name: string; provider: string; providerId: string }>
  disabled?: boolean
  onLocal: (id: string) => void
  onHosted: (key: string) => void
}) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const q = search.trim().toLowerCase()
  const localShown = local.filter((m) => !q || m.name.toLowerCase().includes(q))
  const hostedShown = hosted.filter(
    (m) => !q || `${m.name} ${m.provider}`.toLowerCase().includes(q)
  )
  const providers = [...new Set(hostedShown.map((m) => m.providerId))]
  const heading =
    'px-2 pt-2.5 pb-1 text-[11px] font-medium tracking-wide text-subtle-foreground uppercase'
  const row = (selected: boolean) =>
    cn(
      'flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11',
      selected && 'bg-accent'
    )
  const pick = (fn: () => void) => {
    fn()
    setOpen(false)
    setSearch('')
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setSearch('')
      }}
    >
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label="Engine"
          className="-ml-1 flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
        >
          <ModelAvatar modelId={modelId} name={label} provider={providerId} />
          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-foreground">
            {label}
          </span>
          <ChevronsUpDown className="size-[13px] shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-[min(26rem,calc(100vh-16px))] w-[360px] max-w-[calc(100vw-24px)] overflow-hidden p-1.5"
      >
        <div className="flex max-h-[inherit] flex-col">
          <div className="flex items-center gap-2 border-b border-dashed border-border px-2 pt-1.5 pb-2">
            <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search models..."
              aria-label="Search models"
              autoFocus
              className="min-w-0 flex-1 bg-transparent text-base font-normal text-foreground outline-0 placeholder:text-muted-foreground md:text-[13px]"
            />
            {search && (
              <button
                type="button"
                aria-label="Clear"
                onClick={() => setSearch('')}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-11"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pb-1 [scrollbar-width:thin]">
            {localShown.length === 0 && hostedShown.length === 0 && (
              <p className="px-4 py-3 text-sm text-muted-foreground">No models match.</p>
            )}
            {localShown.length > 0 && (
              <div>
                <p className={heading}>On this computer</p>
                {localShown.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={row(value === `local:${m.id}`)}
                    onClick={() => pick(() => onLocal(m.id))}
                  >
                    <ModelAvatar modelId={m.id} name={m.name} />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                      {m.name}
                    </span>
                    {value === `local:${m.id}` && <Check className="size-3.5 text-muted-foreground" aria-hidden />}
                  </button>
                ))}
              </div>
            )}
            {providers.map((id) => {
              const models = hostedShown.filter((m) => m.providerId === id)
              return (
                <div key={id}>
                  <div className="flex items-center gap-1.5 px-2 pt-2.5 pb-0.5 text-xs">
                    <span className="shrink-0 [&_[data-slot=brand-mark]]:!size-3.5">
                      <ProvidersAvatar provider={{ provider: id } as ProviderObject} />
                    </span>
                    <span className="font-semibold text-foreground">{models[0].provider}</span>
                    <span className="text-[11px] text-subtle-foreground">· prompt leaves this computer</span>
                  </div>
                  {models.map((m) => (
                    <button
                      key={m.key}
                      type="button"
                      className={row(value === `cloud:${m.key}`)}
                      onClick={() => pick(() => onHosted(m.key))}
                    >
                      <ModelAvatar modelId={m.name} name={m.name} provider={m.providerId} />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                        {m.name}
                      </span>
                      {value === `cloud:${m.key}` && <Check className="size-3.5 text-muted-foreground" aria-hidden />}
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
          <div className="mt-1.5 flex shrink-0 flex-col border-t border-dashed border-border pt-1">
            <button
              type="button"
              className={row(false)}
              onClick={() => pick(() => navigate({ to: route.hub.index }))}
            >
              <Search className="size-3.5 text-muted-foreground" aria-hidden />
              <span className="text-[13px] text-secondary-foreground">Find more picture models in Discover</span>
            </button>
            <button
              type="button"
              className={row(false)}
              onClick={() => pick(() => navigate({ to: route.settings.model_providers }))}
            >
              <Settings className="size-3.5 text-muted-foreground" aria-hidden />
              <span className="text-[13px] text-secondary-foreground">
                {hosted.length ? 'Manage hosted providers' : 'Add an API key to use hosted models'}
              </span>
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** A little outline of the picture's shape, so "3:2" can be seen. */
function ShapeGlyph({ width, height }: { width: number; height: number }) {
  const long = 14
  const w = width >= height ? long : Math.round((long * width) / height)
  const h = height >= width ? long : Math.round((long * height) / width)
  return (
    <i
      aria-hidden
      className="inline-block rounded-[2px] border-[1.5px] border-current"
      style={{ width: w, height: h }}
    />
  )
}

function EngineSetup() {
  const status = useStudio((s) => s.status)
  const installing = useStudio((s) => s.installing)
  const install = useStudio((s) => s.installEngine)
  const builds = BUILDS.filter((b) => (status?.engineBuilds ?? ['win-vulkan-x64', 'win-cuda12-x64', 'win-cpu-x64']).includes(b.id))
  const [selected, setBuild] = useState<EngineBuild | null>(null)
  const build = builds.find((b) => b.id === selected)?.id ?? builds[0]?.id
  if (!status) return null
  if (!status.supported) {
    return (
      <Frame className="motion-safe:animate-rise-in">
        <FrameHeader title="Not available on this system yet" />
        <FrameBody className="p-3.5">
          <p className="text-[13px] text-muted-foreground">
            Local image and video generation currently requires Windows x64 or Linux x64.
          </p>
        </FrameBody>
      </Frame>
    )
  }
  if (status.engineBackend) return null
  const percent = installing?.total
    ? Math.round((installing.downloaded / installing.total) * 100)
    : 0
  return (
    <Frame className="motion-safe:animate-rise-in">
      <FrameHeader title="Set up the image engine" />
      <FrameBody className="gap-3 p-3.5">
        <p className="text-[13px] text-muted-foreground">
          Flint makes images and video on this computer with
          stable-diffusion.cpp. The engine is downloaded once, checked against
          its published checksum, and runs only while you generate.
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          {builds.map((b) => (
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
          <Button disabled={!!installing || !build} onClick={() => { if (build) void install(build) }}>
            {installing ? 'Installing…' : 'Download and install'}
          </Button>
        </div>
      </FrameBody>
    </Frame>
  )
}

/** Width and height boxes. A box is snapped into range when it is left, so what is shown is what runs. */
function CustomSize({
  kind,
  limits,
  form,
  setForm,
  disabled,
}: {
  kind: StudioKind
  limits: { min: number; max: number }
  form: Form
  setForm: (patch: Partial<Form>) => void
  disabled: boolean
}) {
  const settle = (key: 'customWidth' | 'customHeight') => {
    const typed = parseSide(form[key])
    setForm({
      [key]: String(snapSide(typed ?? 1024, limits.min, limits.max)),
    })
  }
  const box = (key: 'customWidth' | 'customHeight', label: string) => (
    <Input
      value={form[key]}
      inputMode="numeric"
      disabled={disabled}
      aria-label={label}
      onChange={(e) =>
        setForm({ [key]: e.target.value.replace(/\D/g, '').slice(0, 5) })
      }
      onBlur={() => settle(key)}
      onKeyDown={(e) => e.key === 'Enter' && settle(key)}
      className="min-w-0 text-center tabular-nums"
    />
  )
  return (
    <div className="flex flex-col gap-2 motion-safe:animate-rise-in">
      <div className="flex items-center gap-1.5">
        {box('customWidth', 'Width in pixels')}
        <span aria-hidden className="text-xs text-muted-foreground">
          ×
        </span>
        {box('customHeight', 'Height in pixels')}
        <button
          type="button"
          title="Swap width and height"
          aria-label="Swap width and height"
          disabled={disabled}
          onClick={() =>
            setForm({
              customWidth: form.customHeight,
              customHeight: form.customWidth,
            })
          }
          className="grid size-8 shrink-0 place-items-center rounded-md border-[0.8px] border-border bg-card text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden disabled:opacity-50 pointer-coarse:size-11"
        >
          <ArrowLeftRight className="size-3.5" />
        </button>
      </div>
      <p className="text-xs leading-snug text-muted-foreground">
        Multiples of 16, up to {limits.max} pixels.
        {kind === 'video'
          ? ' Big clips need a lot of memory.'
          : ' Big pictures need more memory and time.'}
      </p>
    </div>
  )
}

/** A small look at a result, for the strip under the prompt and for the gallery. */
function Thumb({ item, className }: { item: GalleryItem; className?: string }) {
  const src = convertFileSrc(item.path)
  return item.kind === 'video' ? (
    <video
      src={src}
      muted
      preload="metadata"
      className={cn('size-full object-cover', className)}
    />
  ) : (
    <img
      src={src}
      alt=""
      loading="lazy"
      className={cn('size-full object-cover', className)}
    />
  )
}

const ACTIVITY_TONE = { done: 'ok', failed: 'err', stopped: 'neutral' } as const
const ACTIVITY_LABEL = {
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
} as const

/** A video opens in a dialog with its own controls: the image viewer is for pictures. */
export function VideoDialog({
  item,
  onClose,
}: {
  item: GalleryItem | null
  onClose: () => void
}) {
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
            {r.frames ? ` · ${r.frames} frames` : ''} ·{' '}
            {durationText(r.durationMs)}
          </DialogDescription>
        </DialogHeader>
        <video
          src={convertFileSrc(item.path)}
          controls
          className="max-h-[60vh] w-full rounded-lg bg-black"
        />
        <p className="text-sm">{r.prompt}</p>
        {r.negativePrompt && (
          <p className="text-xs text-muted-foreground">
            Avoid: {r.negativePrompt}
          </p>
        )}
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

/** Blue marks what is chosen, as in the design. */
const ON =
  'border-blue-500/70 bg-blue-500/10 text-foreground shadow-[0_0_0_1px_rgb(59_130_246/0.3)]'
const OFF =
  'border-border bg-card text-muted-foreground hover:border-border-strong hover:bg-accent hover:text-foreground'

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 20) return 'a few seconds ago'
  if (s < 90) return 'a minute ago'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} minutes ago`
  const h = Math.round(m / 60)
  if (h < 24) return h === 1 ? 'an hour ago' : `${h} hours ago`
  const d = Math.round(h / 24)
  return d === 1 ? 'yesterday' : `${d} days ago`
}

/** A flat gradient stand-in for a model preview: the colour comes from its id, so it stays the same. */
function modelTint(id: string): string {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360
  return `linear-gradient(135deg, hsl(${h} 55% 38%), hsl(${(h + 60) % 360} 60% 24%))`
}

function PanelButton({
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-lg border-[0.8px] border-border bg-card px-2.5 text-xs font-medium text-secondary-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50 pointer-coarse:h-11',
        props.className
      )}
    >
      {children}
    </button>
  )
}

/** Model: what is picked, whether it is ready, and the one button to get it ready. */
function ModelPanel({
  kind,
  model,
  form,
  setForm,
  targets,
}: {
  kind: StudioKind
  model: StudioModel
  form: Form
  setForm: (patch: Partial<Form>) => void
  targets: CloudTarget[]
}) {
  const navigate = useNavigate()
  const status = useStudio((s) => s.status)
  const download = useStudio((s) => s.download)
  const job = useStudio((s) => s.job)
  const downloadModel = useStudio((s) => s.downloadModel)
  const load = useStudio((s) => s.load)
  const unload = useStudio((s) => s.unload)
  const removeCustomModel = useStudio((s) => s.removeCustomModel)
  const allModels = useStudio((s) => s.status?.models)
  const localModels = useMemo(
    () => allModels?.filter((m) => m.kind === kind) ?? [],
    [allModels, kind]
  )
  const [loading, setLoading] = useState(false)
  const hosted = targets.find((t) => t.key === form.cloud)
  const resident = status?.resident?.model_id === model.id
  const downloading = download?.modelId === model.id
  const percent =
    downloading && download.total
      ? Math.round((download.bytes / download.total) * 100)
      : 0
  const engineReady = !!status?.engineBackend
  const running = !!job
  const name = hosted ? hosted.model.name : model.display_name
  const noun = kind === 'video' ? 'Text to Video' : 'Text to Image'

  return (
    <Frame className="motion-safe:animate-rise-in" style={rise(0)}>
      <FrameHeader
        icon={<Box className="size-4" aria-hidden />}
        title="Model"
        actions={
          <PanelButton onClick={() => navigate({ to: route.hub.index })}>
            Manage
          </PanelButton>
        }
      />
      <FrameBody className="gap-3 p-3.5">
        <div className="flex gap-3.5">
          <div
            aria-hidden
            className="grid size-20 shrink-0 place-items-center rounded-xl text-white/80"
            style={{ background: modelTint(hosted ? hosted.key : model.id) }}
          >
            {kind === 'video' ? <Film className="size-7" /> : <ImageIcon className="size-7" />}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <EnginePicker
              disabled={running}
              value={hosted ? `cloud:${form.cloud}` : `local:${model.id}`}
              label={name}
              modelId={hosted ? hosted.model.name : model.id}
              providerId={hosted?.provider.provider}
              local={localModels.map((m) => ({ id: m.id, name: m.display_name }))}
              hosted={targets.map((t) => ({
                key: t.key,
                name: t.model.name,
                provider: t.provider.label,
                providerId: t.provider.provider,
              }))}
              onLocal={(id) => setForm({ cloud: '', localModel: id })}
              onHosted={(key) => setForm({ cloud: key })}
            />
            {hosted ? (
              <Chip tone="info" dot>
                Hosted by {hosted.provider.label}
              </Chip>
            ) : (
              <Chip tone={resident ? 'ok' : 'neutral'} dot>
                {resident ? 'Loaded' : model.installed ? 'Ready' : 'Not downloaded'}
              </Chip>
            )}
            <p className="text-xs leading-snug text-muted-foreground">
              {hosted
                ? `Your prompt is sent to ${hosted.provider.label}, uses your API key from Providers and is billed by them.`
                : `Runs on this computer. Starts at ${model.defaults.width} × ${model.defaults.height}, ${model.defaults.steps} steps.`}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {!hosted && (
            <>
              <Chip mono>{formatModelBytes(model.totalBytes)}</Chip>
              <Chip mono>{model.license}</Chip>
            </>
          )}
          <Chip mono>{noun}</Chip>
        </div>
        {!hosted && downloading && (
          <div className="space-y-1.5">
            <Progress value={percent} />
            <p className="text-xs text-muted-foreground">
              {downloadProgressText(download.bytes, download.total, formatModelBytes)}
            </p>
          </div>
        )}
        {!hosted &&
          (!model.installed ? (
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
          ))}
        {!hosted && !engineReady && model.installed && (
          <p className="text-xs text-muted-foreground">
            Install the image engine above to use this model.
          </p>
        )}
        {!hosted && model.custom && (
          <button
            type="button"
            disabled={!!job || resident}
            onClick={async () => {
              await removeCustomModel(model.id)
              setForm({ localModel: '' })
            }}
            title="Takes it off this list. Its downloaded files stay on disk."
            className="self-start rounded-md text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
          >
            Remove from Studio
          </button>
        )}
      </FrameBody>
    </Frame>
  )
}

/**
 * The shapes in the order the design lays them out, four to a row with Custom
 * last. Pairs keep the real index, so remixing a shape that is not shown
 * (21:9, reached through Custom) still works.
 */
function shapeOrder<T extends { short: string }>(
  sizes: readonly T[],
  kind: StudioKind
): Array<[T, number]> {
  const all = sizes.map((s, i) => [s, i] as [T, number])
  if (kind !== 'image') return all
  const order = ['1:1', '4:3', '3:4', '16:9', '3:2', '2:3', '9:16']
  return order.flatMap((short) => all.filter(([s]) => s.short === short))
}

/** Generation Settings: shape, how many, seed, and the less common options. */
function SettingsPanel({
  kind,
  model,
  form,
  setForm,
  targets,
}: {
  kind: StudioKind
  model: StudioModel
  form: Form
  setForm: (patch: Partial<Form>) => void
  targets: CloudTarget[]
}) {
  const job = useStudio((s) => s.job)
  const serviceHub = useServiceHub()
  const [availableLoras, setAvailableLoras] = useState<string[]>([])
  useEffect(() => {
    void studioApi.listLoras().then(setAvailableLoras).catch(() => {})
  }, [])
  const importLora = async () => {
    try {
      const path = await serviceHub.dialog().open({ multiple: false, directory: false })
      if (typeof path !== 'string') return
      const name = await studioApi.importLora(path)
      setAvailableLoras(await studioApi.listLoras())
      setForm({ loras: [...form.loras, { name, multiplier: 1 }] })
      toast.success(`${name} imported`)
    } catch (error) {
      toast.error(String(error))
    }
  }
  const hosted = targets.find((t) => t.key === form.cloud)
  const { hardware } = useFitContext()
  const sizes = kind === 'video' ? VIDEO_SIZES : IMAGE_SIZES
  const warning = kind === 'video' ? videoMemoryWarning(hardware.total_memory) : null
  const running = !!job
  const lastClip = useStudio((s) => s.gallery.video[0]?.recipe)
  const [advanced, setAdvanced] = useState(false)
  const [negativeOn, setNegativeOn] = useState(false)
  const guess =
    kind === 'video'
      ? estimateVideoMs(lastClip, {
          ...chosenSize(kind, model, form),
          frames: framesForSeconds(form.seconds, model.video?.fps ?? 24),
          steps: model.defaults.steps,
        })
      : null
  const negativeShown = negativeOn || form.negative !== ''

  const label = 'text-[13px] font-medium text-secondary-foreground'
  const tile = (pressed: boolean) =>
    cn(
      'flex h-10 items-center justify-center gap-2 rounded-lg border-[0.8px] text-xs font-medium transition-colors duration-150 focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50 pointer-coarse:h-12',
      pressed ? ON : OFF
    )

  return (
    <Frame className="motion-safe:animate-rise-in lg:flex-1" style={rise(1)}>
      <FrameHeader
        icon={<SlidersHorizontal className="size-4" aria-hidden />}
        title="Generation Settings"
        actions={
          <PanelButton
            disabled={running}
            onClick={() => {
              setForm({ sizeIndex: 0, count: 1, seed: '', negative: '', accepted: false, loras: [] })
              setNegativeOn(false)
            }}
          >
            <RotateCcw className="size-3" aria-hidden /> Reset
          </PanelButton>
        }
      />
      <FrameBody className="flex-1 gap-4 p-3.5">
        <div className="flex flex-col gap-2">
          <span className={label}>{kind === 'video' ? 'Shape' : 'Aspect Ratio'}</span>
          <div className="grid grid-cols-4 gap-2">
            {shapeOrder(sizes, kind).map(([s, i]) => (
              <button
                key={s.label}
                type="button"
                title={s.label}
                aria-pressed={form.sizeIndex === i}
                disabled={running}
                onClick={() => setForm({ sizeIndex: i })}
                className={tile(form.sizeIndex === i)}
              >
                <ShapeGlyph width={s.width} height={s.height} />
                {s.short}
              </button>
            ))}
            <button
              type="button"
              title="Type your own width and height"
              aria-pressed={form.sizeIndex === CUSTOM}
              disabled={running}
              onClick={() => setForm({ sizeIndex: CUSTOM })}
              className={tile(form.sizeIndex === CUSTOM)}
            >
              <Ruler className="size-3.5" aria-hidden />
              Custom
            </button>
          </div>
          {form.sizeIndex === CUSTOM && (
            <CustomSize
              kind={kind}
              limits={sideLimits(model, hosted)}
              form={form}
              setForm={setForm}
              disabled={running}
            />
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          {kind === 'image' ? (
            <div className="flex flex-col gap-2">
              <span className={label}>Image Count</span>
              <div className="flex gap-2">
                {[1, 2, 3, 4].map((n) => (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={form.count === n}
                    disabled={running}
                    onClick={() => setForm({ count: n })}
                    className={cn(tile(form.count === n), 'size-10 flex-none tabular-nums pointer-coarse:size-12')}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <span className={label}>Length</span>
              <div className="flex flex-wrap gap-2">
                {VIDEO_SECONDS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={form.seconds === n}
                    disabled={running}
                    onClick={() => setForm({ seconds: n })}
                    className={cn(tile(form.seconds === n), 'h-10 px-3 tabular-nums')}
                  >
                    {n} s
                  </button>
                ))}
              </div>
            </div>
          )}
          {!hosted && (
            <div className="flex flex-col gap-2">
              <span className={label}>Seed</span>
              <div className="relative">
                <Input
                  value={form.seed}
                  onChange={(e) => setForm({ seed: e.target.value })}
                  placeholder="Random"
                  disabled={running}
                  aria-label="Seed"
                  className="h-10 pr-10"
                />
                <button
                  type="button"
                  title="Pick a random seed"
                  aria-label="Pick a random seed"
                  disabled={running}
                  onClick={() => setForm({ seed: String(Math.floor(Math.random() * 2 ** 31)) })}
                  className="absolute top-1/2 right-1.5 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden disabled:opacity-50"
                >
                  <Dices className="size-4" />
                </button>
              </div>
            </div>
          )}
        </div>
        {guess !== null && (
          <p className="-mt-2 text-xs text-muted-foreground">
            About {durationText(guess)}, from your last clip.
          </p>
        )}

        {!hosted && (
          <div className="mt-auto flex flex-col gap-3 border-t border-border pt-3">
            <button
              type="button"
              aria-expanded={advanced}
              onClick={() => setAdvanced((v) => !v)}
              className="flex items-center justify-between rounded-md text-[13px] font-medium text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden"
            >
              Advanced
              <ChevronRight
                className={cn('size-4 text-muted-foreground transition-transform duration-200', advanced && 'rotate-90')}
                aria-hidden
              />
            </button>
            {advanced && (
              <div className="flex flex-col gap-3 motion-safe:animate-rise-in">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className={label}>LoRA adapters</span>
                    <PanelButton disabled={running} onClick={() => void importLora()}>Import .safetensors</PanelButton>
                  </div>
                  <p className="text-xs text-muted-foreground">Use adapters made for selected local model family.</p>
                  {availableLoras.map((name) => {
                    const selected = form.loras.find((lora) => lora.name === name)
                    return (
                      <div key={name} className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          aria-label={`Use ${name}`}
                          checked={!!selected}
                          disabled={running}
                          onChange={(event) => setForm({ loras: event.target.checked
                            ? [...form.loras, { name, multiplier: 1 }]
                            : form.loras.filter((lora) => lora.name !== name) })}
                        />
                        <span className="min-w-0 flex-1 truncate" title={name}>{name}</span>
                        {selected && <Input
                          type="number"
                          min="0"
                          max="2"
                          step="0.1"
                          value={selected.multiplier}
                          aria-label={`${name} strength`}
                          disabled={running}
                          onChange={(event) => setForm({ loras: form.loras.map((lora) => lora.name === name
                            ? { ...lora, multiplier: Number(event.target.value) }
                            : lora) })}
                          className="h-8 w-20"
                        />}
                      </div>
                    )
                  })}
                </div>
                <label className="flex items-center gap-2.5 text-[13px] text-secondary-foreground">
                  <Switch
                    checked={negativeShown}
                    disabled={running}
                    onCheckedChange={(on) => {
                      setNegativeOn(on)
                      if (!on) setForm({ negative: '' })
                    }}
                    aria-label="Negative prompt"
                  />
                  Negative Prompt
                </label>
                {negativeShown && (
                  <Textarea
                    value={form.negative}
                    onChange={(e) => setForm({ negative: e.target.value })}
                    placeholder="Blurry, low quality, extra fingers, text, watermark…"
                    disabled={running}
                    aria-label="What to avoid"
                    rows={3}
                    className="min-h-0 resize-none"
                  />
                )}
              </div>
            )}
          </div>
        )}
        {warning && !hosted && (
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

const ENHANCE_SUFFIX = ', highly detailed, soft natural lighting, sharp focus'
const PROMPT_LIMIT = 2000

const GUIDE = [
  ['Say what is in it', 'Start with the subject, then where it is and what it is doing.'],
  ['Name the style', 'Oil painting, photograph, flat illustration, 3D render: the style changes everything.'],
  ['Add light and mood', 'Soft morning light, neon at night, overcast: light sets the feel.'],
  ['Keep it to one idea', 'A short, clear prompt beats a long list. Add detail one step at a time.'],
  ['Use Avoid for what you do not want', 'Under Advanced, a negative prompt lists things to leave out.'],
] as const

/** Prompt: the text, a look at the latest result, and the one big button. */
function PromptPanel({
  kind,
  model,
  form,
  setForm,
  promptRef,
  onOpen,
  targets,
  onRemix,
}: {
  kind: StudioKind
  model: StudioModel
  form: Form
  setForm: (patch: Partial<Form>) => void
  promptRef: React.RefObject<HTMLTextAreaElement | null>
  onOpen: (index: number) => void
  targets: CloudTarget[]
  onRemix: (item: GalleryItem) => void
}) {
  const hosted = targets.find((t) => t.key === form.cloud)
  const providerSettings = useModelProvider((s) =>
    hosted ? s.providers.find((p) => p.provider === hosted.provider.provider) : undefined
  )
  const status = useStudio((s) => s.status)
  const job = useStudio((s) => s.job)
  const jobPrompt = useStudio((s) => s.jobPrompt)
  const items = useStudio((s) => s.gallery[kind])
  const generate = useStudio((s) => s.generate)
  const cancel = useStudio((s) => s.cancel)
  const remove = useStudio((s) => s.remove)
  const archiveOn = useArchiveEnabled()
  const { hardware } = useFitContext()
  const [guide, setGuide] = useState(false)
  const size = chosenSize(kind, model, form, hosted)
  const warning = kind === 'video' ? videoMemoryWarning(hardware.total_memory) : null
  const ready = hosted ? true : status?.resident?.model_id === model.id
  const running = job?.kind === kind
  const busy = !!job
  const latest = items[0]
  const percent = Math.round((job?.fraction ?? 0) * 100)
  const examples = EXAMPLE_PROMPTS[kind]
  const mac =
    typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)
  const { t } = useTranslation()
  const storeError = useStudio((s) => s.error)
  // A failed run keeps its Retry on the stage until the next one starts.
  const [failedRun, setFailedRun] = useState(false)
  const [wasRunning, setWasRunning] = useState(running)
  if (running !== wasRunning) {
    setWasRunning(running)
    setFailedRun(!running && !!storeError)
  }
  const refineStatus = running
    ? refineStatusFor(job)
    : failedRun && storeError && latest
      ? 'error'
      : 'complete'
  const etaText =
    !job?.remote && job?.startedAt && job.fraction > 0.05 && job.fraction < 0.97
      ? ` · about ${formatEta(((Date.now() - job.startedAt) / 1000) * ((1 - job.fraction) / job.fraction))} left`
      : ''
  const stageDetail = job ? (
    <>
      <span className="line-clamp-1 block max-w-full">{jobPrompt}</span>
      <span>
        {job.remote
          ? `Waiting for ${job.remote}…`
          : `${phaseLabel(job.phase)} · ${percent}%`}
        {etaText}
      </span>
    </>
  ) : null
  const showFrame = kind === 'image' && (running || !!latest)

  const start = async () => {
    const text = form.prompt.trim()
    if (!text) return toast.error('Write a prompt first.')
    if (hosted) {
      if (!providerSettings)
        return toast.error(`${hosted.provider.label} is not set up in Providers.`)
      const abort = new AbortController()
      const ok = await generate(
        kind,
        text,
        () =>
          generateCloudImages(
            hosted,
            providerSettings,
            { prompt: text, width: size.width, height: size.height, count: form.count },
            abort.signal
          ),
        { label: hosted.provider.label, abort }
      )
      if (ok) toast.success('Image ready')
      return
    }
    const common = {
      model: model.id,
      prompt: text,
      negative_prompt: form.negative.trim() || undefined,
      width: size.width,
      height: size.height,
      seed: parseSeed(form.seed),
      lora: form.loras,
    }
    const ok = await generate(kind, text, () =>
      kind === 'video'
        ? studioApi.generateVideo({
            ...common,
            frames: framesForSeconds(form.seconds, model.video?.fps ?? 24),
          })
        : studioApi.generateImage({ ...common, count: form.count })
    )
    if (ok) toast.success(kind === 'video' ? 'Video ready' : 'Image ready')
  }

  const roundBtn =
    'grid size-8 place-items-center rounded-lg bg-black/55 text-white backdrop-blur transition-colors hover:bg-black/75 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-hidden pointer-coarse:size-11'

  return (
    <Frame className="motion-safe:animate-rise-in max-lg:order-first" style={rise(2)}>
      <FrameHeader
        title="Prompt"
        actions={
          <PanelButton onClick={() => setGuide(true)}>
            <Info className="size-3" aria-hidden /> Prompt Guide
          </PanelButton>
        }
      />
      <FrameBody className="flex-1 gap-3 p-3.5">
        <div className="flex flex-col gap-2.5">
          <div className="relative rounded-xl border-[0.8px] border-border bg-card transition-shadow duration-200 focus-within:border-input focus-within:shadow-lift">
            <Textarea
              ref={promptRef}
              value={form.prompt}
              maxLength={PROMPT_LIMIT}
              onChange={(e) => setForm({ prompt: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !busy) {
                  e.preventDefault()
                  void start()
                }
              }}
              rows={3}
              disabled={busy}
              aria-label="Prompt"
              placeholder={
                kind === 'video'
                  ? 'A cat walking through a rainy alley, cinematic'
                  : 'A lighthouse on a cliff at sunrise, oil painting'
              }
              className="min-h-24 resize-none border-0 bg-transparent px-3.5 pt-3 pb-8 shadow-none focus-visible:ring-0"
            />
            <span className="pointer-events-none absolute right-3.5 bottom-2.5 text-xs text-muted-foreground tabular-nums">
              {form.prompt.length}/{PROMPT_LIMIT}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={busy || !form.prompt.trim() || form.prompt.includes(ENHANCE_SUFFIX)}
              onClick={() => setForm({ prompt: form.prompt.trim() + ENHANCE_SUFFIX })}
              title="Adds a few words about detail and light"
              className="inline-flex h-7 items-center gap-1.5 rounded-full border-[0.8px] border-blue-500/50 bg-blue-500/10 px-3 text-xs font-medium text-blue-300 transition-colors hover:bg-blue-500/20 focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50 pointer-coarse:h-11"
            >
              <Sparkles className="size-3" aria-hidden /> Enhance
            </button>
            {examples.map((text) => (
              <button
                key={text}
                type="button"
                disabled={busy}
                onClick={() => {
                  setForm({ prompt: text })
                  promptRef.current?.focus()
                }}
                className="inline-flex h-7 max-w-[11rem] items-center truncate rounded-full border-[0.8px] border-border bg-card px-3 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50 pointer-coarse:h-11"
              >
                <span className="truncate">{text}</span>
              </button>
            ))}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="More"
                  className="grid h-7 w-8 place-items-center rounded-full border-[0.8px] border-border bg-card text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden pointer-coarse:h-11"
                >
                  <MoreHorizontal className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={!form.prompt} onSelect={() => setForm({ prompt: '' })}>
                  Clear the prompt
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!form.prompt}
                  onSelect={() => {
                    void navigator.clipboard?.writeText(form.prompt)
                    toast('Prompt copied')
                  }}
                >
                  Copy the prompt
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div
          className="relative mx-auto w-full overflow-hidden rounded-xl bg-muted"
          // Nothing made yet: a compact stage, not a tall empty square.
          style={
            latest
              ? { aspectRatio: `${size.width} / ${size.height}`, maxHeight: 'min(58vh, 420px)' }
              : { height: 'min(40vh, 320px)' }
          }
        >
          {showFrame ? (
            <RefineFrame
              className="absolute inset-0"
              src={latest ? convertFileSrc(latest.path) : null}
              alt={latest?.recipe.prompt ?? ''}
              status={refineStatus}
              fraction={job?.fraction ?? 0}
              detail={stageDetail}
              onStop={() => void cancel()}
              onRetry={() => void start()}
              labels={{
                queued: t('common:motionMedia.queued'),
                generating: t('common:motionMedia.generating'),
                refining: t('common:motionMedia.refining'),
                complete: t('common:motionMedia.ready'),
                error: t('common:motionMedia.failed'),
                stop: t('common:motionMedia.stop'),
                retry: t('common:motionMedia.retry'),
              }}
            />
          ) : latest ? (
            kind === 'video' && !running ? (
              <video
                key={latest.id}
                src={convertFileSrc(latest.path)}
                controls
                className="size-full bg-black object-contain motion-safe:animate-rise-in"
              />
            ) : (
              <img
                key={latest.id}
                src={convertFileSrc(latest.path)}
                alt={latest.recipe.prompt}
                className={cn(
                  'size-full object-contain transition-[filter,transform,opacity] duration-500 ease-expo',
                  running ? 'scale-105 opacity-60 blur-xl' : 'motion-safe:animate-rise-in'
                )}
              />
            )
          ) : (
            !running && (
              <EmptyState
                className="absolute inset-0"
                icon={kind === 'video' ? <Film /> : <ImageIcon />}
                title={kind === 'video' ? 'Your first video starts here' : 'Your first image starts here'}
                description="Describe it above, or try one of the examples."
              />
            )
          )}
          {latest && !running && (
            <div className="absolute top-3 right-3 flex gap-1.5">
              <a
                href={convertFileSrc(latest.path)}
                download={`studio-${latest.recipe.seed}.${kind === 'video' ? 'mp4' : 'png'}`}
                title="Save"
                aria-label="Save"
                className={roundBtn}
              >
                <Download className="size-4" />
              </a>
              <button
                type="button"
                title="Open large"
                aria-label="Open large"
                onClick={() => onOpen(0)}
                className={roundBtn}
              >
                <Maximize2 className="size-4" />
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label="More" className={roundBtn}>
                    <MoreHorizontal className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => onRemix(latest)}>
                    Remix: same prompt, new seed
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      void navigator.clipboard?.writeText(latest.recipe.prompt)
                      toast('Prompt copied')
                    }}
                  >
                    Copy the prompt
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive"
                    onSelect={() => void remove(latest.kind, latest.id)}
                  >
                    {archiveOn ? 'Move to Archive' : 'Delete'}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
          {!showFrame && (
            <div
              aria-hidden={!running}
              className={cn(
                'absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-gradient-to-t from-black/70 to-transparent p-4 pt-12 text-white transition-opacity duration-300',
                running ? 'opacity-100' : 'pointer-events-none opacity-0'
              )}
            >
              <p className="line-clamp-1 text-xs opacity-80">{jobPrompt}</p>
              <Progress
                value={job?.remote ? 100 : percent}
                className={cn(
                  'h-1 bg-white/25',
                  job?.remote && 'motion-safe:animate-pulse'
                )}
              />
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="tabular-nums">
                  {job?.remote
                    ? `Waiting for ${job.remote}…`
                    : `${phaseLabel(job?.phase ?? 'queued')} · ${percent}%`}
                  {!job?.remote &&
                  job?.startedAt &&
                  job.fraction > 0.05 &&
                  job.fraction < 0.97
                    ? ` · about ${formatEta(((Date.now() - job.startedAt) / 1000) * ((1 - job.fraction) / job.fraction))} left`
                    : ''}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void cancel()}
                >
                  <Square className="size-3" /> Stop
                </Button>
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          disabled={!ready || busy || (!!warning && !form.accepted)}
          onClick={() => void start()}
          className="relative mt-auto flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#3b82f6] to-[#8b5cf6] text-sm font-semibold text-white shadow-[0_6px_20px_-6px_rgb(99_102_241/0.7)] transition-[filter,transform] duration-150 hover:brightness-110 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-hidden active:translate-y-px disabled:pointer-events-none disabled:opacity-50"
        >
          <Sparkles className="size-4" aria-hidden />
          {ready ? (kind === 'video' ? 'Generate Video' : 'Generate Image') : 'Load the model first'}
          <span className="absolute right-3 hidden items-center gap-1 rounded-md bg-white/20 px-2 py-1 text-[11px] font-medium sm:inline-flex">
            {mac ? '⌘' : 'Ctrl'} <CornerDownLeft className="size-3" aria-hidden />
          </span>
        </button>
      </FrameBody>

      <Dialog open={guide} onOpenChange={setGuide}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Prompt Guide</DialogTitle>
            <DialogDescription>Short habits that give better pictures.</DialogDescription>
          </DialogHeader>
          <ul className="flex flex-col gap-3">
            {GUIDE.map(([title, body]) => (
              <li key={title} className="flex flex-col gap-0.5">
                <span className="text-[13px] font-medium text-foreground">{title}</span>
                <span className="text-xs leading-snug text-muted-foreground">{body}</span>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </Frame>
  )
}

/** Recent Activity: what is running now, what just finished, what failed. */
function ActivityPanel({
  kind,
  onOpen,
  onRemix,
}: {
  kind: StudioKind
  onOpen: (index: number) => void
  onRemix: (item: GalleryItem) => void
}) {
  const job = useStudio((s) => s.job)
  const jobPrompt = useStudio((s) => s.jobPrompt)
  const activity = useStudio((s) => s.activity)
  const items = useStudio((s) => s.gallery[kind])
  const remove = useStudio((s) => s.remove)
  const archiveOn = useArchiveEnabled()
  // "Clear all" empties this list only; the pictures stay in Your Generations.
  const [clearedAt, setClearedAt] = useState(0)
  const percent = Math.round((job?.fraction ?? 0) * 100)
  const recent = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.recipe.createdAtMs > clearedAt)
    .slice(0, 8)
  const problems = activity
    .filter((a) => a.kind === kind && a.status !== 'done' && a.at > clearedAt)
    .slice(0, 3)
  const empty = !job && recent.length === 0 && problems.length === 0

  return (
    <Frame className="motion-safe:animate-rise-in" style={rise(3)}>
      <FrameHeader
        title="Recent Activity"
        actions={
          <PanelButton
            disabled={empty}
            onClick={() => setClearedAt(Date.now())}
            title="Empties this list. Your pictures stay in Your Generations."
          >
            Clear all
          </PanelButton>
        }
      />
      <FrameBody className="min-h-0 flex-1 p-2.5">
        {empty ? (
          <p className="px-1.5 py-2 text-xs text-muted-foreground">
            Nothing yet. What you make shows up here.
          </p>
        ) : (
          <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto overscroll-contain pr-0.5 [scrollbar-width:thin]">
            {job && (
              <li className="flex min-w-0 flex-col gap-1.5 rounded-xl border-[0.8px] border-blue-500/40 bg-blue-500/5 p-2.5">
                <div className="flex items-center gap-2">
                  <Chip tone="info" live>
                    Making
                  </Chip>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {job.remote ? `Waiting for ${job.remote}` : `${phaseLabel(job.phase)} · ${percent}%`}
                  </span>
                </div>
                <p className="line-clamp-2 text-[12.5px] text-foreground">{jobPrompt}</p>
                <Progress
                  value={job.remote ? 100 : percent}
                  className={cn(job.remote && 'motion-safe:animate-pulse')}
                />
              </li>
            )}
            {recent.map(({ item, index }, i) => (
              <li
                key={item.id}
                className={cn(
                  'group flex min-w-0 items-center gap-3 rounded-xl border-[0.8px] p-2 transition-colors',
                  i === 0 && !job ? ON : 'border-transparent hover:bg-accent/60'
                )}
              >
                <button
                  type="button"
                  onClick={() => onOpen(index)}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden"
                >
                  <span className="size-14 shrink-0 overflow-hidden rounded-lg bg-muted">
                    <Thumb item={item} />
                  </span>
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="line-clamp-2 text-[13px] leading-snug text-foreground">
                      {item.recipe.prompt}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {timeAgo(item.recipe.createdAtMs)}
                    </span>
                  </span>
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label="More"
                      className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden pointer-coarse:size-11"
                    >
                      <MoreHorizontal className="size-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => onOpen(index)}>Open</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => onRemix(item)}>
                      Remix: same prompt, new seed
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive"
                      onSelect={() => void remove(item.kind, item.id)}
                    >
                      {archiveOn ? 'Move to Archive' : 'Delete'}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
            {problems.map((entry) => (
              <li key={entry.id} className="flex min-w-0 flex-col gap-1 rounded-xl p-2.5">
                <div className="flex items-center gap-2">
                  <Chip tone={ACTIVITY_TONE[entry.status]} dot>
                    {ACTIVITY_LABEL[entry.status]}
                  </Chip>
                  <span className="text-xs text-muted-foreground">{timeAgo(entry.at)}</span>
                </div>
                <p className="line-clamp-2 text-[12.5px] text-foreground">{entry.prompt}</p>
                {entry.error && (
                  <p className="line-clamp-3 text-xs break-words text-muted-foreground">
                    {entry.error}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </FrameBody>
    </Frame>
  )
}

/** Your Generations: everything made, filterable, with a select mode to remove several. */
function GenerationsPanel({
  onOpen,
  onRemix,
}: {
  onOpen: (item: GalleryItem) => void
  onRemix: (item: GalleryItem) => void
}) {
  const gallery = useStudio((s) => s.gallery)
  const remove = useStudio((s) => s.remove)
  const archiveOn = useArchiveEnabled()
  const [tab, setTab] = useState<'all' | StudioKind>('all')
  const [layout, setLayout] = useState<'grid' | 'list'>('grid')
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const all = useMemo(
    () =>
      [...gallery.image, ...gallery.video].sort(
        (a, b) => b.recipe.createdAtMs - a.recipe.createdAtMs
      ),
    [gallery]
  )
  const items = tab === 'all' ? all : all.filter((i) => i.kind === tab)

  const toggle = (id: string) =>
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const leaveSelect = () => {
    setSelecting(false)
    setPicked(new Set())
  }
  const removePicked = async () => {
    for (const item of items) if (picked.has(item.id)) await remove(item.kind, item.id)
    leaveSelect()
  }
  const activate = (item: GalleryItem) => (selecting ? toggle(item.id) : onOpen(item))

  const tabClass = (on: boolean) =>
    cn(
      'inline-flex h-7 items-center rounded-lg px-3 text-xs font-medium transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden pointer-coarse:h-11',
      on ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
    )
  const iconBtn = (on: boolean) =>
    cn(
      'grid size-7 place-items-center rounded-md transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden pointer-coarse:size-11',
      on ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
    )

  return (
    <Frame className="motion-safe:animate-rise-in" style={rise(4)}>
      <FrameHeader
        title="Your Generations"
        actions={
          <div className="flex items-center gap-2">
            {selecting && (
              <>
                <PanelButton
                  disabled={picked.size === 0}
                  onClick={() => void removePicked()}
                  className="text-destructive"
                >
                  <Trash2 className="size-3" aria-hidden />
                  {archiveOn ? 'Archive' : 'Delete'} {picked.size > 0 ? picked.size : ''}
                </PanelButton>
              </>
            )}
            <PanelButton onClick={() => (selecting ? leaveSelect() : setSelecting(true))}>
              {selecting ? 'Done' : 'Select'}
            </PanelButton>
            <div className="flex items-center gap-0.5 rounded-lg border-[0.8px] border-border bg-card p-0.5">
              <button type="button" aria-label="Grid" aria-pressed={layout === 'grid'} onClick={() => setLayout('grid')} className={iconBtn(layout === 'grid')}>
                <LayoutGrid className="size-3.5" />
              </button>
              <button type="button" aria-label="List" aria-pressed={layout === 'list'} onClick={() => setLayout('list')} className={iconBtn(layout === 'list')}>
                <List className="size-3.5" />
              </button>
            </div>
          </div>
        }
      />
      <FrameBody className="gap-3 p-3.5">
        <div role="tablist" aria-label="Filter" className="flex w-fit items-center gap-1 rounded-xl border-[0.8px] border-border bg-card p-0.5">
          {(
            [
              ['all', 'All'],
              ['image', 'Images'],
              ['video', 'Video'],
            ] as const
          ).map(([value, text]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={tabClass(tab === value)}
            >
              {text}
            </button>
          ))}
        </div>
        {items.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            Nothing here yet. What you make appears here.
          </p>
        ) : layout === 'grid' ? (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,150px),1fr))] gap-3">
            {items.map((item, i) => {
              const on = picked.has(item.id)
              return (
                <li
                  key={item.id}
                  className={cn(
                    'group relative aspect-[4/3] overflow-hidden rounded-xl border-[0.8px] bg-muted transition-[transform,box-shadow] duration-200 ease-expo hover:-translate-y-0.5 hover:shadow-lift motion-safe:animate-rise-in',
                    on || (i === 0 && !selecting) ? ON : 'border-border'
                  )}
                  style={rise(i)}
                >
                  <button
                    type="button"
                    onClick={() => activate(item)}
                    aria-label={item.recipe.prompt}
                    aria-pressed={selecting ? on : undefined}
                    className="absolute inset-0 focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden focus-visible:ring-inset"
                  >
                    <Thumb item={item} />
                  </button>
                  {selecting && (
                    <span
                      aria-hidden
                      className={cn(
                        'pointer-events-none absolute top-2 left-2 grid size-5 place-items-center rounded-md border-[0.8px]',
                        on ? 'border-blue-400 bg-blue-500 text-white' : 'border-white/70 bg-black/40'
                      )}
                    >
                      {on && <Check className="size-3" />}
                    </span>
                  )}
                  {item.kind === 'video' && !selecting && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute top-2 left-2 grid size-6 place-items-center rounded-full bg-black/60 text-white"
                    >
                      <Film className="size-3" />
                    </span>
                  )}
                  {!selecting && (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-1.5 bg-gradient-to-t from-black/75 to-transparent p-2 pt-10 text-white opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
                      <p className="line-clamp-2 text-[11px] leading-snug">{item.recipe.prompt}</p>
                      <div className="flex items-center justify-between gap-1">
                        <span className="truncate text-[10px] opacity-80 tabular-nums">
                          {timeAgo(item.recipe.createdAtMs)}
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
                  )}
                </li>
              )
            })}
          </ul>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {items.map((item) => {
              const on = picked.has(item.id)
              return (
                <li
                  key={item.id}
                  className={cn(
                    'flex min-w-0 items-center gap-3 rounded-xl border-[0.8px] p-2',
                    on ? ON : 'border-border'
                  )}
                >
                  <button
                    type="button"
                    onClick={() => activate(item)}
                    aria-pressed={selecting ? on : undefined}
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden"
                  >
                    <span className="size-12 shrink-0 overflow-hidden rounded-lg bg-muted">
                      <Thumb item={item} />
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-[13px] text-foreground">{item.recipe.prompt}</span>
                      <span className="truncate text-xs text-muted-foreground tabular-nums">
                        {item.recipe.modelName} · {item.recipe.width} × {item.recipe.height} ·{' '}
                        {timeAgo(item.recipe.createdAtMs)}
                      </span>
                    </span>
                  </button>
                  {!selecting && (
                    <button
                      type="button"
                      title={archiveOn ? 'Move to Archive' : 'Delete'}
                      aria-label={archiveOn ? 'Move to Archive' : 'Delete'}
                      onClick={() => void remove(item.kind, item.id)}
                      className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:text-destructive focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden pointer-coarse:size-11"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </li>
              )
            })}
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
  const targets = useCloudTargets(kind)

  // A hosted model whose provider lost its key must not come back selected, and
  // billed, when the key is added again.
  useEffect(() => {
    if (form.cloud && !targets.some((t) => t.key === form.cloud)) {
      setFormState((f) => ({ ...f, cloud: '' }))
    }
  }, [form.cloud, targets])

  const setForm = (patch: Partial<Form>) =>
    setFormState((f) => ({ ...f, ...patch }))

  useEffect(() => {
    void refresh()
    void refreshGallery('image')
    void refreshGallery('video')
  }, [refresh, refreshGallery])

  const model = useMemo(() => {
    const ofKind = status?.models.filter((m) => m.kind === kind) ?? []
    return ofKind.find((m) => m.id === form.localModel) ?? ofKind[0]
  }, [status, kind, form.localModel])

  // The sizes differ between images and video, so the chosen shape starts over.
  const changeKind = (next: StudioKind) => {
    setViewing(null)
    setKind(next)
    setForm({
      sizeIndex: form.sizeIndex === CUSTOM ? CUSTOM : 0,
      cloud: '',
      localModel: '',
      loras: [],
    })
  }

  const remix = (item: GalleryItem) => {
    const sizes = item.kind === 'video' ? VIDEO_SIZES : IMAGE_SIZES
    setForm({
      prompt: item.recipe.prompt,
      negative: item.recipe.negativePrompt,
      seed: '',
      cloud: targets.some((t) => t.key === item.recipe.modelId)
        ? item.recipe.modelId
        : '',
      localModel: status?.models.some((m) => m.id === item.recipe.modelId)
        ? item.recipe.modelId
        : '',
      loras: item.recipe.lora ?? [],
      // The exact size it was made at: a standard shape when it is one,
      // else the custom boxes, so a remix never quietly changes the size.
      ...(sizes.some(
        (s) => s.width === item.recipe.width && s.height === item.recipe.height
      )
        ? {
            sizeIndex: sizeIndexOf(
              sizes,
              item.recipe.width,
              item.recipe.height
            ),
          }
        : {
            sizeIndex: CUSTOM,
            customWidth: String(item.recipe.width),
            customHeight: String(item.recipe.height),
          }),
    })
    promptRef.current?.focus()
    promptRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  // The list under the studio shows both kinds; opening or remixing one of the
  // other kind switches to it first.
  const openItem = (item: GalleryItem) => {
    if (item.kind !== kind) changeKind(item.kind)
    setViewing(gallery[item.kind].findIndex((g) => g.id === item.id))
  }
  const remixAny = (item: GalleryItem) => {
    if (item.kind !== kind) changeKind(item.kind)
    remix(item)
  }

  // Pictures open in the same viewer the chat uses; a video has its own dialog.
  const shown = gallery[kind]
  const viewerImages = useMemo<ViewerImage[]>(
    () =>
      kind === 'image'
        ? shown.map((g) => ({
            url: convertFileSrc(g.path),
            name: `studio-${g.recipe.seed}`,
          }))
        : [],
    [shown, kind]
  )

  return (
    <EnginePage testId="studio-page">
      <PageHead
        title="Studio"
        description="Create images and video locally on this computer. Nothing leaves your device."
        actions={
          <Segmented<StudioKind>
            aria-label="What to make"
            className="min-w-[200px]"
            options={[
              { value: 'image', label: 'Images', icon: <ImageIcon className="size-4" /> },
              { value: 'video', label: 'Video', icon: <Film className="size-4" /> },
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
            <div className="grid gap-4 lg:grid-cols-[minmax(300px,1.1fr)_minmax(0,1.35fr)_minmax(260px,1fr)] lg:items-stretch">
              <div className="flex min-w-0 flex-col gap-4">
                <ModelPanel
                  kind={kind}
                  model={model}
                  form={form}
                  setForm={setForm}
                  targets={targets}
                />
                <SettingsPanel
                  kind={kind}
                  model={model}
                  form={form}
                  setForm={setForm}
                  targets={targets}
                />
              </div>
              <PromptPanel
                kind={kind}
                model={model}
                form={form}
                setForm={setForm}
                promptRef={promptRef}
                onOpen={setViewing}
                targets={targets}
                onRemix={remix}
              />
              <ActivityPanel kind={kind} onOpen={setViewing} onRemix={remix} />
            </div>
          )}
          <GenerationsPanel onOpen={openItem} onRemix={remixAny} />
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
      <VideoDialog
        item={
          kind === 'video' && viewing !== null ? (shown[viewing] ?? null) : null
        }
        onClose={() => setViewing(null)}
      />
    </EnginePage>
  )
}
