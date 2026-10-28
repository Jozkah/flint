import { ArrowLeftRight } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { parseSide, snapSide } from '@/lib/studio/helpers'
import { type StudioKind } from '@/lib/studio/studio'
import { Form } from '@/containers/studio/studioTypes'

/** Width and height boxes. A box is snapped into range when it is left, so what is shown is what runs. */
export function CustomSize({
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
  const { t, i18n } = useTranslation()
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
        {box('customWidth', t('studio:size.width'))}
        <span aria-hidden className="text-xs text-muted-foreground">
          ×
        </span>
        {box('customHeight', t('studio:size.height'))}
        <button
          type="button"
          title={t('studio:size.swap')}
          aria-label={t('studio:size.swap')}
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
        {t(kind === 'video' ? 'studio:size.hintVideo' : 'studio:size.hintImage', {
          max: new Intl.NumberFormat(i18n.language).format(limits.max),
        })}
      </p>
    </div>
  )
}
