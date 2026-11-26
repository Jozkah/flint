import { useRef, useState } from 'react'
import { useAssetUrl } from '@/lib/assetPath'
import { CornerDownLeft, Download, Film, ImageIcon, Info, Maximize2, MoreHorizontal, Sparkles, Square, SquareDashedMousePointer, Expand } from 'lucide-react'
import { toast } from 'sonner'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { Progress } from '@/components/ui/progress'
import { DropRim } from '@/components/ui/drop-rim'
import { Slider } from '@/components/ui/slider'
import { RefineFrame } from '@/components/ui/refine-frame'
import { refineStatusFor } from '@/lib/refine-frame'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useStudio } from '@/hooks/useStudio'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useFitContext } from '@/hooks/useFitContext'
import { cn } from '@/lib/utils'
import { generateCloudImages, type CloudTarget } from '@/lib/studio/cloud'
import { writeLastHostedImageModel } from '@/lib/studio/lastHostedImage'
import { formatEta } from '@/lib/downloadSpeed'
import { useArchiveEnabled } from '@/hooks/useArchiveEnabled'
import { EXAMPLE_PROMPTS, framesForSeconds, parseSeed, videoMemoryWarning } from '@/lib/studio/helpers'
import { saveStudioItem } from '@/lib/studio/saveItem'
import { studioApi, type GalleryItem, type StudioKind, type StudioModel } from '@/lib/studio/studio'
import { MAX_REFERENCES, ReferencePictures } from '@/containers/studio/panels/ReferencePictures'
import { Elapsed } from '@/containers/studio/panels/Elapsed'
import { PanelButton } from '@/containers/studio/panels/PanelButton'
import { SelectionEditor, type SelectionEditorHandle } from '@/containers/studio/panels/SelectionEditor'
import { firstPicture, importPicture, PictureImportError } from '@/lib/studio/importPicture'
import { cropToGallery } from '@/lib/studio/cropPicture'
import { formatModelBytes } from '@/lib/huggingface'
import { chosenSize, phaseText, rise } from '@/containers/studio/studioHelpers'
import { Form } from '@/containers/studio/studioTypes'

const ENHANCE_SUFFIX = ', highly detailed, soft natural lighting, sharp focus'

const PROMPT_LIMIT = 2000

const GUIDE = ['g1', 'g2', 'g3', 'g4', 'g5'] as const

/** Prompt: the text, a look at the latest result, and the one big button. */
export function PromptPanel({
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
  const convertFileSrc = useAssetUrl()
  const hosted = targets.find((t) => t.key === form.cloud)
  const providerSettings = useModelProvider((s) =>
    hosted ? s.providers.find((p) => p.provider === hosted.provider.provider) : undefined
  )
  const { t } = useTranslation()
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
  const examples = EXAMPLE_PROMPTS[kind].map((_, i) => t(`studio:prompt.example.${kind}.${i}`))
  const mac =
    typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)
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
      ? ` · ${t('studio:prompt.eta', { eta: formatEta(((Date.now() - job.startedAt) / 1000) * ((1 - job.fraction) / job.fraction)) })}`
      : ''
  const stageDetail = job ? (
    <>
      <span className="line-clamp-1 block max-w-full">{jobPrompt}</span>
      <span>
        {job.remote
          ? t('studio:prompt.waitingFor', { provider: job.remote })
          : `${phaseText(t, job.phase)} · ${percent}%`}
        {job.remote ? <Elapsed since={job.startedAt} /> : null}
        {etaText}
      </span>
    </>
  ) : null
  const upscalers = status?.upscalers ?? []
  const upscaleItem = useStudio((s) => s.upscale)
  const upscalerDownload = useStudio((s) => s.upscalerDownload)
  const engineReady = !!status?.engineBackend
  // Selecting part of the latest picture to repaint only that part.
  const [selecting, setSelecting] = useState(false)
  const [painted, setPainted] = useState(false)
  const [strength, setStrength] = useState(0.9)
  const editorRef = useRef<SelectionEditorHandle>(null)
  const [dragOver, setDragOver] = useState(false)
  const [importing, setImporting] = useState(false)
  const canSelect = kind === 'image' && !hosted && !!latest
  // The selection stays while its edit runs, so a failed edit can be tried again.
  const editing = selecting && canSelect
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null)
  if (selecting && !canSelect) setSelecting(false)

  const upscale = async (item: GalleryItem, upscaler: (typeof upscalers)[number]) => {
    const ok = await upscaleItem(item, upscaler)
    if (ok) toast.success(t('studio:upscale.done', { scale: upscaler.scale }))
  }

  const importProblem = (error: unknown) => {
    const problem = error instanceof PictureImportError ? error.problem : 'failed'
    return problem === 'not-picture'
      ? t('studio:reference.notPicture')
      : problem === 'too-big'
        ? t('studio:reference.tooBig')
        : t('studio:reference.importFailed')
  }

  const dropPicture = async (files: FileList | null) => {
    const file = firstPicture(files)
    if (!file) {
      toast.error(t('studio:reference.notPicture'))
      return
    }
    setImporting(true)
    try {
      await importPicture(file, t('studio:reference.imported'))
      setSelecting(false)
      toast.success(t('studio:drop.added'))
    } catch (error) {
      toast.error(importProblem(error))
    } finally {
      setImporting(false)
    }
  }

  const upscaleSelection = async (upscaler: (typeof upscalers)[number]) => {
    if (!latest) return
    const rect = editorRef.current?.selectionRect()
    if (!rect) {
      toast.error(t('studio:select.empty'))
      return
    }
    let crop: GalleryItem
    try {
      crop = await cropToGallery(latest, rect, t('studio:upscale.selectionLabel'))
    } catch {
      toast.error(t('studio:upscale.cropFailed'))
      return
    }
    setSelecting(false)
    const ok = await upscaleItem(crop, upscaler)
    if (ok) toast.success(t('studio:upscale.done', { scale: upscaler.scale }))
  }

  const editSelection = async () => {
    const text = form.prompt.trim()
    if (!text) {
      toast.error(t('studio:prompt.writeFirst'))
      return
    }
    if (!latest) return
    const mask = editorRef.current?.exportMask()
    if (!mask) {
      toast.error(t('studio:select.empty'))
      return
    }
    const ok = await generate(kind, text, () =>
      studioApi.generateImage({
        model: model.id,
        prompt: text,
        negative_prompt: form.negative.trim() || undefined,
        seed: parseSeed(form.seed),
        lora: form.loras,
        count: 1,
        init_image_id: latest.id,
        mask,
        strength,
      })
    )
    if (ok) {
      setSelecting(false)
      toast.success(t('studio:select.edited'))
    }
  }

  const showReferences = kind === 'image' && !hosted && !!model.edit
  const showFrame = kind === 'image' && (running || !!latest)

  const start = async () => {
    const text = form.prompt.trim()
    if (!text) {
      toast.error(t('studio:prompt.writeFirst'))
      return
    }
    if (hosted) {
      if (!providerSettings) {
        toast.error(t('studio:prompt.notSetUp', { provider: hosted.provider.label }))
        return
      }
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
      if (ok) {
        writeLastHostedImageModel(hosted.key)
        toast.success(t('studio:prompt.imageReady'))
      }
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
    const references = model.edit ? form.references.filter((r) => items.some((i) => i.id === r.id)) : []
    const ok = await generate(kind, text, () =>
      kind === 'video'
        ? studioApi.generateVideo({
            ...common,
            frames: framesForSeconds(form.seconds, model.video?.fps ?? 24),
          })
        : studioApi.generateImage({
            ...common,
            count: form.count,
            reference_ids: references.length ? references.map((r) => r.id) : undefined,
          })
    )
    if (ok) toast.success(kind === 'video' ? t('studio:prompt.videoReady') : t('studio:prompt.imageReady'))
  }

  const roundBtn =
    'grid size-8 place-items-center rounded-lg bg-black/55 text-white backdrop-blur transition-colors hover:bg-black/75 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-hidden pointer-coarse:size-11'

  return (
    <Frame className="motion-safe:animate-rise-in max-lg:order-first" style={rise(2)}>
      <FrameHeader
        title={t('studio:prompt.title')}
        actions={
          <PanelButton onClick={() => setGuide(true)}>
            <Info className="size-3" aria-hidden /> {t('studio:prompt.guide')}
          </PanelButton>
        }
      />
      <FrameBody className="flex-1 gap-3 p-3.5">
        <div className="flex flex-col gap-2.5">
          {showReferences && (
            <ReferencePictures
              value={form.references.filter((r) => items.some((i) => i.id === r.id))}
              onChange={(references) => setForm({ references })}
              disabled={busy}
            />
          )}
          <div className="relative rounded-xl border-[0.8px] border-border bg-card transition-shadow duration-200 focus-within:border-input focus-within:shadow-lift">
            <Textarea
              ref={promptRef}
              value={form.prompt}
              maxLength={PROMPT_LIMIT}
              onChange={(e) => setForm({ prompt: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !busy) {
                  e.preventDefault()
                  void (editing ? editSelection() : start())
                }
              }}
              rows={3}
              disabled={busy}
              aria-label={t('studio:prompt.title')}
              placeholder={
                kind === 'video'
                  ? t('studio:prompt.placeholderVideo')
                  : t('studio:prompt.placeholderImage')
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
              title={t('studio:prompt.enhanceTitle')}
              className="inline-flex h-7 items-center gap-1.5 rounded-full border-[0.8px] border-blue-500/50 bg-blue-500/10 px-3 text-xs font-medium text-blue-300 transition-colors hover:bg-blue-500/20 focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50 pointer-coarse:h-11"
            >
              <Sparkles className="size-3" aria-hidden /> {t('studio:prompt.enhance')}
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
                  aria-label={t('common:more')}
                  className="grid h-7 w-8 place-items-center rounded-full border-[0.8px] border-border bg-card text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden pointer-coarse:h-11"
                >
                  <MoreHorizontal className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={!form.prompt} onSelect={() => setForm({ prompt: '' })}>
                  {t('studio:prompt.clear')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!form.prompt}
                  onSelect={() => {
                    // Only claim a copy that happened.
                    void navigator.clipboard
                      ?.writeText(form.prompt)
                      .then(() => toast(t('studio:actions.promptCopied')))
                      .catch(() => undefined)
                  }}
                >
                  {t('studio:prompt.copy')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div
          className="relative mx-auto w-full overflow-hidden rounded-xl bg-muted"
          data-testid="studio-stage"
          onDragOver={(e) => {
            if (kind !== 'image' || busy || editing || !e.dataTransfer.types.includes('Files')) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
            if (!dragOver) setDragOver(true)
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
          }}
          onDrop={(e) => {
            if (kind !== 'image' || busy || editing) return
            e.preventDefault()
            setDragOver(false)
            void dropPicture(e.dataTransfer.files)
          }}
          // Nothing made yet: a compact stage, not a tall empty square.
          style={
            latest
              ? { aspectRatio: `${size.width} / ${size.height}`, maxHeight: 'min(58vh, 420px)' }
              : { height: 'min(40vh, 320px)' }
          }
        >
          {editing && latest && (
            <SelectionEditor
              key={latest.id}
              ref={editorRef}
              src={convertFileSrc(latest.path)}
              alt={latest.recipe.prompt}
              onPaintedChange={setPainted}
              onDone={() => setSelecting(false)}
              inert={running}
              toolbarHost={toolbarHost}
            />
          )}
          {editing && !running ? null : showFrame ? (
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
                  'img-outline size-full object-contain transition-[filter,transform,opacity] duration-500 ease-expo',
                  running ? 'scale-105 opacity-60 blur-xl' : 'motion-safe:animate-rise-in'
                )}
              />
            )
          ) : (
            !running && (
              <EmptyState
                className="absolute inset-0"
                icon={kind === 'video' ? <Film /> : <ImageIcon />}
                title={kind === 'video' ? t('studio:prompt.emptyVideo') : t('studio:prompt.emptyImage')}
                description={
                  kind === 'image'
                    ? `${t('studio:prompt.emptyDesc')} ${t('studio:drop.hint')}`
                    : t('studio:prompt.emptyDesc')
                }
              />
            )
          )}
          {latest && !running && !editing && (
            <div className="absolute top-3 right-3 flex gap-1.5">
              <button
                type="button"
                onClick={() => void saveStudioItem(latest, convertFileSrc(latest.path))}
                title={t('studio:prompt.save')}
                aria-label={t('studio:prompt.save')}
                className={roundBtn}
              >
                <Download className="size-4" />
              </button>
              <button
                type="button"
                title={t('studio:prompt.openLarge')}
                aria-label={t('studio:prompt.openLarge')}
                onClick={() => onOpen(0)}
                className={roundBtn}
              >
                <Maximize2 className="size-4" />
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label={t('common:more')} className={roundBtn}>
                    <MoreHorizontal className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => onRemix(latest)}>
                    {t('studio:prompt.remix')}
                  </DropdownMenuItem>
                  {latest.kind === 'image' && (
                    <DropdownMenuItem
                      disabled={busy || !canSelect}
                      onSelect={() => {
                        setPainted(false)
                        setSelecting(true)
                      }}
                    >
                      {t('studio:select.start')}
                    </DropdownMenuItem>
                  )}
                  {latest.kind === 'image' &&
                    upscalers.map((u) => (
                      <DropdownMenuItem
                        key={u.id}
                        disabled={busy || !engineReady || !!upscalerDownload}
                        onSelect={() => void upscale(latest, u)}
                      >
                        {u.installed
                          ? t('studio:upscale.action', { scale: u.scale })
                          : t('studio:upscale.actionDownload', { scale: u.scale, size: formatModelBytes(u.totalBytes) })}
                      </DropdownMenuItem>
                    ))}
                  {showReferences && latest.kind === 'image' && (
                    <DropdownMenuItem
                      disabled={
                        busy ||
                        form.references.some((r) => r.id === latest.id) ||
                        form.references.length >= MAX_REFERENCES
                      }
                      onSelect={() => setForm({ references: [...form.references, latest] })}
                    >
                      {t('studio:reference.use')}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onSelect={() => {
                      // Only claim a copy that happened.
                      void navigator.clipboard
                        ?.writeText(latest.recipe.prompt)
                        .then(() => toast(t('studio:actions.promptCopied')))
                        .catch(() => undefined)
                    }}
                  >
                    {t('studio:prompt.copy')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive"
                    onSelect={() => void remove(latest.kind, latest.id)}
                  >
                    {archiveOn ? t('studio:actions.archive') : t('studio:actions.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
          <DropRim active={dragOver} count={1} />
          {(importing || upscalerDownload) && (
            <p
              role="status"
              className="absolute inset-x-3 bottom-3 rounded-lg bg-black/65 px-3 py-2 text-xs text-white backdrop-blur"
            >
              {importing
                ? t('studio:drop.adding')
                : t('studio:upscale.downloading', {
                    bytes: formatModelBytes(upscalerDownload?.bytes ?? 0),
                    total: formatModelBytes(upscalerDownload?.total ?? 0),
                  })}
            </p>
          )}
          {!showFrame && !editing && (
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
                    ? t('studio:prompt.waitingFor', { provider: job.remote })
                    : `${phaseText(t, job?.phase ?? 'queued')} · ${percent}%`}
                  {job?.remote && job.startedAt ? (
                    <Elapsed since={job.startedAt} />
                  ) : null}
                  {!job?.remote &&
                  job?.startedAt &&
                  job.fraction > 0.05 &&
                  job.fraction < 0.97
                    ? ` · ${t('studio:prompt.eta', { eta: formatEta(((Date.now() - job.startedAt) / 1000) * ((1 - job.fraction) / job.fraction)) })}`
                    : ''}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void cancel()}
                >
                  <Square className="size-3" /> {t('studio:prompt.stop')}
                </Button>
              </div>
            </div>
          )}
        </div>

        {editing && <div ref={setToolbarHost} />}
        {editing && (
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span id="studio-edit-strength" className="shrink-0">{t('studio:select.strength')}</span>
            <Slider
              aria-labelledby="studio-edit-strength"
              min={0.3}
              max={1}
              step={0.05}
              value={[strength]}
              onValueChange={([v]) => setStrength(v)}
              formatValue={(v) => `${Math.round(v * 100)}%`}
            />
            <span className="w-9 shrink-0 text-right tabular-nums">{Math.round(strength * 100)}%</span>
          </div>
        )}
        {editing && upscalers.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {upscalers.map((u) => (
              <Button
                key={u.id}
                variant="outline"
                size="sm"
                disabled={busy || !painted || !engineReady || !!upscalerDownload}
                title={
                  u.installed
                    ? t('studio:upscale.selection', { scale: u.scale })
                    : t('studio:upscale.selectionDownload', { scale: u.scale, size: formatModelBytes(u.totalBytes) })
                }
                onClick={() => void upscaleSelection(u)}
              >
                <Expand className="size-3.5" aria-hidden />
                {t('studio:upscale.selection', { scale: u.scale })}
              </Button>
            ))}
          </div>
        )}
        {editing ? (
          <button
            type="button"
            disabled={!ready || busy || !painted}
            onClick={() => void editSelection()}
            className="relative mt-auto flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#3b82f6] to-[#8b5cf6] text-sm font-semibold text-white shadow-[0_6px_20px_-6px_rgb(99_102_241/0.7)] transition-[filter,transform] duration-150 hover:brightness-110 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-hidden active:translate-y-px disabled:pointer-events-none disabled:opacity-50"
          >
            <SquareDashedMousePointer className="size-4" aria-hidden />
            {!ready ? t('studio:prompt.loadFirst') : painted ? t('studio:select.apply') : t('studio:select.paintFirst')}
          </button>
        ) : (
        <button
          type="button"
          disabled={!ready || busy || (!!warning && !form.accepted)}
          onClick={() => void start()}
          className="relative mt-auto flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#3b82f6] to-[#8b5cf6] text-sm font-semibold text-white shadow-[0_6px_20px_-6px_rgb(99_102_241/0.7)] transition-[filter,transform] duration-150 hover:brightness-110 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-hidden active:translate-y-px disabled:pointer-events-none disabled:opacity-50"
        >
          <Sparkles className="size-4" aria-hidden />
          {ready ? (kind === 'video' ? t('studio:prompt.generateVideo') : t('studio:prompt.generateImage')) : t('studio:prompt.loadFirst')}
          <span className="absolute right-3 hidden items-center gap-1 rounded-md bg-white/20 px-2 py-1 text-[length:calc(var(--ui-font-base)*0.6875)] font-medium sm:inline-flex">
            {mac ? '⌘' : 'Ctrl'} <CornerDownLeft className="size-3" aria-hidden />
          </span>
        </button>
        )}
      </FrameBody>

      <Dialog open={guide} onOpenChange={setGuide}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('studio:prompt.guide')}</DialogTitle>
            <DialogDescription>{t('studio:prompt.guideDesc')}</DialogDescription>
          </DialogHeader>
          <ul className="flex flex-col gap-3">
            {GUIDE.map((id) => (
              <li key={id} className="flex flex-col gap-0.5">
                <span className="text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground">{t(`studio:prompt.${id}.title`)}</span>
                <span className="text-xs leading-snug text-muted-foreground">{t(`studio:prompt.${id}.body`)}</span>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </Frame>
  )
}
