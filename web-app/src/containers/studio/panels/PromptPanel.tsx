import { useState } from 'react'
import { useAssetUrl } from '@/lib/assetPath'
import { CornerDownLeft, Download, Film, ImageIcon, Info, Maximize2, MoreHorizontal, Sparkles, Square } from 'lucide-react'
import { toast } from 'sonner'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { Progress } from '@/components/ui/progress'
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
import { formatEta } from '@/lib/downloadSpeed'
import { useArchiveEnabled } from '@/hooks/useArchiveEnabled'
import { EXAMPLE_PROMPTS, framesForSeconds, parseSeed, videoMemoryWarning } from '@/lib/studio/helpers'
import { studioApi, type GalleryItem, type StudioKind, type StudioModel } from '@/lib/studio/studio'
import { Elapsed } from '@/containers/studio/panels/Elapsed'
import { PanelButton } from '@/containers/studio/panels/PanelButton'
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
  const showFrame = kind === 'image' && (running || !!latest)

  const start = async () => {
    const text = form.prompt.trim()
    if (!text) return toast.error(t('studio:prompt.writeFirst'))
    if (hosted) {
      if (!providerSettings)
        return toast.error(t('studio:prompt.notSetUp', { provider: hosted.provider.label }))
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
      if (ok) toast.success(t('studio:prompt.imageReady'))
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
                description={t('studio:prompt.emptyDesc')}
              />
            )
          )}
          {latest && !running && (
            <div className="absolute top-3 right-3 flex gap-1.5">
              <a
                href={convertFileSrc(latest.path)}
                download={`studio-${latest.recipe.seed}.${kind === 'video' ? 'mp4' : 'png'}`}
                title={t('studio:prompt.save')}
                aria-label={t('studio:prompt.save')}
                className={roundBtn}
              >
                <Download className="size-4" />
              </a>
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
