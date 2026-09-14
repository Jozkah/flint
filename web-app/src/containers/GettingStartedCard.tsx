import { useNavigate } from '@tanstack/react-router'
import { Check, Circle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { route } from '@/constants/routes'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useOnboardingGuide } from '@/hooks/useOnboardingGuide'
import { useThreads } from '@/hooks/useThreads'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { hasUsableProvider } from '@/lib/providerReadiness'
import {
  guideSteps,
  isObservedStep,
  isStepDone,
  type GuideStepId,
} from '@/lib/onboarding'
import { TermHint } from '@/containers/TermHint'

/**
 * The home screen's guide card, and for returning users a way back into their
 * most recent conversation. It reads real state and never creates content.
 */
export function GettingStartedCard() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const guide = useOnboardingGuide()
  const providers = useModelProvider((s) => s.providers)
  const threads = useThreads((s) => s.threads)

  const threadList = Object.values(threads ?? {})
  const signals = {
    hasUsableModel: hasUsableProvider(providers),
    threadCount: threadList.length,
  }

  if (guide.status === 'in-progress') {
    const steps = guideSteps(guide.intent)
    const allDone = steps.every((s) => isStepDone(s, guide, signals))
    const intentKey = guide.intent ?? 'question'
    return (
      <section
        aria-label={t('onboarding:guideRegion')}
        className="mb-4 rounded-lg border border-border bg-card p-4 text-sm"
        data-testid="getting-started"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-[13px] font-semibold text-foreground">
            {t(`onboarding:guideTitle.${intentKey}`)}
          </h2>
          <Button size="sm" variant="ghost" onClick={guide.skip}>
            {t('onboarding:hideGuide')}
          </Button>
        </div>
        {allDone ? (
          <div className="mt-2 space-y-2">
            <p role="status">{t('onboarding:guideComplete')}</p>
            <Button size="sm" onClick={guide.complete}>
              {t('onboarding:finish')}
            </Button>
          </div>
        ) : (
          <ol className="mt-3 space-y-3">
            {steps.map((step) => (
              <GuideStep
                key={step}
                step={step}
                intent={intentKey}
                done={isStepDone(step, guide, signals)}
                onConfirm={() => guide.confirmStep(step)}
                onOpenProviders={() =>
                  navigate({ to: route.settings.model_providers })
                }
                onOpenCowork={() => navigate({ to: route.cowork })}
              />
            ))}
          </ol>
        )}
      </section>
    )
  }

  const recent = [...threadList].sort(
    (a, b) => (b.updated ?? 0) - (a.updated ?? 0)
  )[0]
  if (!recent) return null
  return (
    <div className="mb-3 text-center text-sm">
      <Button
        variant="link"
        className="h-auto whitespace-normal"
        onClick={() =>
          navigate({
            to: route.threadsDetail,
            params: { threadId: recent.id },
          })
        }
      >
        {t('onboarding:resumeRecent', { title: recent.title || recent.id })}
      </Button>
    </div>
  )
}

function GuideStep({
  step,
  intent,
  done,
  onConfirm,
  onOpenProviders,
  onOpenCowork,
}: {
  step: GuideStepId
  intent: 'question' | 'documents' | 'project'
  done: boolean
  onConfirm: () => void
  onOpenProviders: () => void
  onOpenCowork: () => void
}) {
  const { t } = useTranslation()
  const isMaterial = step === 'add-material'
  const title = isMaterial
    ? t(`onboarding:step.addMaterialTitle.${intent}`)
    : t(`onboarding:step.${step}.title`)
  const body = isMaterial
    ? t(`onboarding:step.add-material.${intent}`)
    : t(`onboarding:step.${step}.body`)

  return (
    <li className="flex gap-2">
      <span className="mt-0.5 shrink-0" aria-hidden>
        {done ? (
          <Check className="size-4 text-success" />
        ) : (
          <Circle className="size-4 text-muted-foreground" />
        )}
      </span>
      <div className="min-w-0 space-y-1">
        <p className="font-medium text-foreground">
          {title}{' '}
          <span className="sr-only">
            ({done ? t('onboarding:stepDone') : t('onboarding:stepTodo')})
          </span>
        </p>
        <p className="leading-relaxed text-ink-2">{body}</p>
        {step === 'review-context' && (
          <p className="text-xs text-muted-foreground">
            <TermHint term="context" />
          </p>
        )}
        {!done && (
          <div className="flex flex-wrap gap-2">
            {step === 'choose-model' && (
              <Button size="sm" variant="outline" onClick={onOpenProviders}>
                {t('onboarding:openProviders')}
              </Button>
            )}
            {isMaterial && intent === 'project' && (
              <Button size="sm" variant="outline" onClick={onOpenCowork}>
                {t('onboarding:openCowork')}
              </Button>
            )}
            {!isObservedStep(step) && (
              <Button size="sm" variant="outline" onClick={onConfirm}>
                {t('onboarding:confirmStep')}
              </Button>
            )}
          </div>
        )}
      </div>
    </li>
  )
}
