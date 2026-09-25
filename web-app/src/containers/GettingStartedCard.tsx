import { useNavigate } from '@tanstack/react-router'
import { Check, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { route } from '@/constants/routes'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useOnboardingGuide } from '@/hooks/useOnboardingGuide'
import { useThreads } from '@/hooks/useThreads'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { hasUsableProvider } from '@/lib/providerReadiness'
import { cn } from '@/lib/utils'
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
 *
 * `resume` off leaves the way back to the caller, which places it on its own
 * (the new-chat page puts it under the suggestions).
 */
export function GettingStartedCard({ resume = true }: { resume?: boolean }) {
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
    // The step to do next wears the orange "now" ring.
    const current = steps.find((s) => !isStepDone(s, guide, signals))
    return (
      <Frame
        aria-label={t('onboarding:guideRegion')}
        className="text-sm motion-safe:animate-rise-in motion-safe:[animation-delay:120ms]"
        data-testid="getting-started"
      >
        <FrameHeader
          icon={<Sparkles />}
          title={t(`onboarding:guideTitle.${intentKey}`)}
          actions={
            <Button size="sm" variant="surface" onClick={guide.skip}>
              {t('onboarding:hideGuide')}
            </Button>
          }
        />
        <FrameBody className="gap-1 px-3 py-2.5">
          {allDone ? (
            <div className="space-y-2 py-1.5">
              <p role="status" className="text-[13px] text-fg-2">
                {t('onboarding:guideComplete')}
              </p>
              <Button size="sm" onClick={guide.complete}>
                {t('onboarding:finish')}
              </Button>
            </div>
          ) : (
            <ol className="flex flex-col">
              {steps.map((step) => (
                <GuideStep
                  key={step}
                  step={step}
                  intent={intentKey}
                  done={isStepDone(step, guide, signals)}
                  current={step === current}
                  onConfirm={() => guide.confirmStep(step)}
                  onOpenProviders={() =>
                    navigate({ to: route.settings.model_providers })
                  }
                  onOpenCowork={() => navigate({ to: route.cowork })}
                />
              ))}
            </ol>
          )}
        </FrameBody>
      </Frame>
    )
  }

  if (!resume) return null
  return <ResumeRecentLink />
}

/** "Continue your last conversation: ..." -- nothing when there is none. */
export function ResumeRecentLink({ className }: { className?: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const threads = useThreads((s) => s.threads)
  const recent = Object.values(threads ?? {}).sort(
    (a, b) => (b.updated ?? 0) - (a.updated ?? 0)
  )[0]
  if (!recent) return null
  return (
    <div className={cn('text-center', className)}>
      <button
        type="button"
        className="text-[12.5px] whitespace-normal text-secondary-foreground underline underline-offset-2 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
        onClick={() =>
          navigate({
            to: route.threadsDetail,
            params: { threadId: recent.id },
          })
        }
      >
        {t('onboarding:resumeRecent', { title: recent.title || recent.id })}
      </button>
    </div>
  )
}

function GuideStep({
  step,
  intent,
  done,
  current,
  onConfirm,
  onOpenProviders,
  onOpenCowork,
}: {
  step: GuideStepId
  intent: 'question' | 'documents' | 'project'
  done: boolean
  current: boolean
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
    <li
      data-current={current || undefined}
      className="flex items-center gap-3 px-0.5 py-2 text-[13px]"
    >
      <span
        className="flex size-4 shrink-0 items-center justify-center"
        aria-hidden
      >
        {done ? (
          <Check className="size-4 text-success" />
        ) : (
          <span
            className={cn(
              'size-4 rounded-full',
              current
                ? 'border-4 border-[#fb923c]'
                : 'border border-border-strong'
            )}
          />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <p
          className={cn(
            'font-medium',
            done ? 'text-subtle-foreground' : 'text-foreground'
          )}
        >
          {title}{' '}
          <span className="sr-only">
            ({done ? t('onboarding:stepDone') : t('onboarding:stepTodo')})
          </span>
        </p>
        {!done && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {body}
          </p>
        )}
        {step === 'review-context' && !done && (
          <p className="text-xs text-muted-foreground">
            <TermHint term="context" />
          </p>
        )}
      </div>
      {!done && (
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
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
            <Button size="sm" variant="surface" onClick={onConfirm}>
              {t('onboarding:confirmStep')}
            </Button>
          )}
        </div>
      )}
    </li>
  )
}
