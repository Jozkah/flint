import type { KeyboardEvent } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { INTENTS, type Intent } from '@/lib/onboarding'

/** The welcome page's intentions, as a radio group. */
export function IntentionList({
  intent,
  onIntent,
}: {
  intent: Intent | null | undefined
  onIntent: (intent: Intent) => void
}) {
  const { t } = useTranslation()

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Arrow keys move and select within the group, as a
    // native radio group does; Tab still leaves it.
    const step =
      event.key === 'ArrowDown' || event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
          ? -1
          : 0
    if (!step) return
    event.preventDefault()
    // With nothing chosen yet, the first arrow picks the
    // first (down) or last (up) option.
    const current = intent ? INTENTS.indexOf(intent) : step > 0 ? -1 : 0
    const next = INTENTS[(current + step + INTENTS.length) % INTENTS.length]
    onIntent(next)
    const target = event.currentTarget.querySelector(
      `[data-testid="setup-intent-${next}"]`
    ) as HTMLElement | null
    target?.focus()
  }

  return (
    <fieldset className="mt-5" data-testid="setup-intents">
      <legend className="text-sm font-semibold text-foreground">
        {t('onboarding:intentHeading')}
      </legend>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {t('onboarding:intentHint')}
      </p>
      <div
        role="radiogroup"
        aria-label={t('onboarding:intentHeading')}
        className="mt-3 flex flex-col gap-2"
        onKeyDown={onKeyDown}
      >
        {INTENTS.map((option) => {
          const isChosen = intent === option
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={isChosen}
              data-testid={`setup-intent-${option}`}
              onClick={() => onIntent(option)}
              className={cn(
                'flex min-h-11 items-start gap-3 rounded-lg border-[0.8px] px-3.5 py-3 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring',
                isChosen
                  ? 'border-primary bg-accent'
                  : 'border-border bg-card hover:border-border-strong hover:bg-hover-row'
              )}
            >
              {/* The radio mark: a ring, filled when chosen. */}
              <span
                aria-hidden
                className={cn(
                  'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
                  isChosen ? 'border-primary' : 'border-input'
                )}
              >
                {isChosen && (
                  <span className="size-2 rounded-full bg-primary" />
                )}
              </span>
              <span className="min-w-0">
                <span className="block font-medium text-foreground">
                  {t(`onboarding:intent.${option}.title`)}
                </span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                  {t(`onboarding:intent.${option}.description`)}
                </span>
              </span>
            </button>
          )
        })}
      </div>
    </fieldset>
  )
}
