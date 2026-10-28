import { useEffect, useState } from 'react'
import { ChevronRight, Dices, RotateCcw, Ruler, SlidersHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { Switch } from '@/components/ui/switch'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { Input } from '@/components/ui/input'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Textarea } from '@/components/ui/textarea'
import { useStudio } from '@/hooks/useStudio'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useFitContext } from '@/hooks/useFitContext'
import { cn } from '@/lib/utils'
import { type CloudTarget } from '@/lib/studio/cloud'
import { IMAGE_SIZES, VIDEO_SECONDS, VIDEO_SIZES, estimateVideoMs, framesForSeconds, videoMemoryWarning } from '@/lib/studio/helpers'
import { studioApi, type StudioKind, type StudioModel } from '@/lib/studio/studio'
import { Checkbox } from '@/components/ui/checkbox'
import { CustomSize } from '@/containers/studio/panels/CustomSize'
import { PanelButton } from '@/containers/studio/panels/PanelButton'
import { OFF, ON, chosenSize, formatDuration, rise, shapeOrder, sideLimits } from '@/containers/studio/studioHelpers'
import { CUSTOM, Form } from '@/containers/studio/studioTypes'

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

/** Generation Settings: shape, how many, seed, and the less common options. */
export function SettingsPanel({
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
  const { t } = useTranslation()
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
      toast.success(t('studio:settings.loraImported', { name }))
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

  const label = 'text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-secondary-foreground'
  const tile = (pressed: boolean) =>
    cn(
      'flex h-10 items-center justify-center gap-2 rounded-lg border-[0.8px] text-xs font-medium transition-colors duration-150 focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50 pointer-coarse:h-12',
      pressed ? ON : OFF
    )

  return (
    <Frame className="motion-safe:animate-rise-in lg:flex-1" style={rise(1)}>
      <FrameHeader
        icon={<SlidersHorizontal className="size-4" aria-hidden />}
        title={t('studio:settings.title')}
        actions={
          <PanelButton
            disabled={running}
            onClick={() => {
              setForm({ sizeIndex: 0, count: 1, seed: '', negative: '', accepted: false, loras: [] })
              setNegativeOn(false)
            }}
          >
            <RotateCcw className="size-3" aria-hidden /> {t('studio:settings.reset')}
          </PanelButton>
        }
      />
      <FrameBody className="flex-1 gap-4 p-3.5">
        <div className="flex flex-col gap-2">
          <span className={label}>{kind === 'video' ? t('studio:settings.shape') : t('studio:settings.aspectRatio')}</span>
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
              title={t('studio:settings.customTitle')}
              aria-pressed={form.sizeIndex === CUSTOM}
              disabled={running}
              onClick={() => setForm({ sizeIndex: CUSTOM })}
              className={tile(form.sizeIndex === CUSTOM)}
            >
              <Ruler className="size-3.5" aria-hidden />
              {t('studio:settings.custom')}
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
              <span className={label}>{t('studio:settings.imageCount')}</span>
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
              <span className={label}>{t('studio:settings.length')}</span>
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
                    {t('studio:duration.s', { count: n })}
                  </button>
                ))}
              </div>
            </div>
          )}
          {!hosted && (
            <div className="flex flex-col gap-2">
              <span className={label}>{t('studio:settings.seed')}</span>
              <div className="relative">
                <Input
                  value={form.seed}
                  onChange={(e) => setForm({ seed: e.target.value })}
                  placeholder={t('studio:settings.random')}
                  disabled={running}
                  aria-label={t('studio:settings.seed')}
                  className="h-10 pr-10"
                />
                <button
                  type="button"
                  title={t('studio:settings.randomSeed')}
                  aria-label={t('studio:settings.randomSeed')}
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
            {t('studio:settings.guess', { duration: formatDuration(t, guess) })}
          </p>
        )}

        {!hosted && (
          <div className="mt-auto flex flex-col gap-3 border-t border-border pt-3">
            <button
              type="button"
              aria-expanded={advanced}
              onClick={() => setAdvanced((v) => !v)}
              className="flex items-center justify-between rounded-md text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden"
            >
              {t('studio:settings.advanced')}
              <ChevronRight
                className={cn('size-4 text-muted-foreground transition-transform duration-200', advanced && 'rotate-90')}
                aria-hidden
              />
            </button>
            {advanced && (
              <div className="flex flex-col gap-3 motion-safe:animate-rise-in">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className={label}>{t('studio:settings.loras')}</span>
                    <PanelButton disabled={running} onClick={() => void importLora()}>{t('studio:settings.importLora')}</PanelButton>
                  </div>
                  <p className="text-xs text-muted-foreground">{t('studio:settings.loraHint')}</p>
                  {availableLoras.map((name) => {
                    const selected = form.loras.find((lora) => lora.name === name)
                    return (
                      <div key={name} className="flex items-center gap-2 text-xs">
                        <Checkbox
                          aria-label={t('studio:settings.useLora', { name })}
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
                          aria-label={t('studio:settings.loraStrength', { name })}
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
                <label className="flex items-center gap-2.5 text-[length:calc(var(--ui-font-base)*0.8125)] text-secondary-foreground">
                  <Switch
                    checked={negativeShown}
                    disabled={running}
                    onCheckedChange={(on) => {
                      setNegativeOn(on)
                      if (!on) setForm({ negative: '' })
                    }}
                    aria-label={t('studio:settings.negativeAria')}
                  />
                  {t('studio:settings.negative')}
                </label>
                {negativeShown && (
                  <Textarea
                    value={form.negative}
                    onChange={(e) => setForm({ negative: e.target.value })}
                    placeholder={t('studio:settings.negativePlaceholder')}
                    disabled={running}
                    aria-label={t('studio:settings.avoidAria')}
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
            <Checkbox
              checked={form.accepted}
              onChange={(e) => setForm({ accepted: e.target.checked })}
              className="mt-0.5"
            />
            <span>
              {t('studio:settings.memoryWarning', {
                gb: Math.round((hardware.total_memory ?? 0) / 1024),
              })}{' '}
              {t('studio:settings.accept')}
            </span>
          </label>
        )}
      </FrameBody>
    </Frame>
  )
}
