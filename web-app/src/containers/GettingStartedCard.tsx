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
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { usePrompt } from '@/hooks/usePrompt'
import {
  checklistStatus,
  guideSteps,
  isObservedStep,
  isStepDone,
  type GuideStepId,
} from '@/lib/onboarding'
import { TermHint } from '@/containers/TermHint'
import { ModelSetupCard } from '@/containers/ModelSetupCard'
import { useSettingsSearch } from '@/hooks/useSettingsSearch'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'

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
  const navTrimmed = useInterfaceSettings((s) => s.hiddenNavItems.length > 0)
  const guide = useOnboardingGuide()
  const providers = useModelProvider((s) => s.providers)
  // The count only: a title change must not re-render the card.
  const threadCount = useThreads((s) => Object.keys(s.threads).length)

  const projectCount = useCoworkSessions(
    (s) => s.sessions.filter((session) => session.folder).length
  )

  const signals = {
    hasUsableModel: hasUsableProvider(providers),
    threadCount,
    projectCount,
  }

  // Fills the composer; the user sends it. Nothing is sent on their behalf,
  // and text the user already typed is never overwritten.
  const trySampleQuestion = () => {
    if (!usePrompt.getState().prompt.trim()) {
      usePrompt.getState().setPrompt(t('onboarding:sample.question'))
    }
    document
      .querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')
      ?.focus()
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
              <p role="status" className="text-[length:calc(var(--ui-font-base)*0.8125)] text-fg-2">
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
                  onOpenCowork={() => navigate({ to: route.cowork })}
                />
              ))}
            </ol>
          )}
          {!allDone && current === 'first-task' && (
            <div className="px-0.5 pt-1 pb-1">
              <Button
                size="sm"
                variant="outline"
                data-testid="guide-sample-question"
                onClick={trySampleQuestion}
              >
                {t('onboarding:sample.button')}
              </Button>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('onboarding:sample.hint')}
              </p>
            </div>
          )}
          {!allDone && intentKey === 'project' && (
            <p
              data-testid="guide-approvals-note"
              className="px-0.5 pt-1 text-xs leading-relaxed text-muted-foreground"
            >
              {t('onboarding:approvalsNote')}
            </p>
          )}
          {!allDone && (
            <ul
              aria-label={t('onboarding:checklist.label')}
              data-testid="guide-checklist"
              className="flex flex-wrap gap-x-4 gap-y-1 px-0.5 pt-2 text-xs text-muted-foreground"
            >
              {checklistStatus(guide, signals).map(({ id, done }) => (
                <li
                  key={id}
                  data-done={done || undefined}
                  className={cn('flex items-center gap-1.5', done && 'text-success')}
                >
                  {done ? (
                    <Check className="size-3.5" aria-hidden />
                  ) : (
                    <span
                      className="size-3.5 rounded-full border border-border-strong"
                      aria-hidden
                    />
                  )}
                  {t(`onboarding:checklist.${id}`)}
                </li>
              ))}
            </ul>
          )}
          {!allDone && (
            <div
              data-testid="guide-sidebar-note"
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-0.5 pt-2 text-xs text-muted-foreground"
            >
              <span className="min-w-0 flex-1">
                <b className="font-medium text-foreground">
                  {t('onboarding:sidebar.title')}
                </b>{' '}
                {navTrimmed
                  ? t('onboarding:sidebar.bodyMinimal')
                  : t('onboarding:sidebar.body')}
              </span>
              <Button
                size="sm"
                variant="outline"
                data-testid="guide-customize-sidebar"
                onClick={() => {
                  useSettingsSearch
                    .getState()
                    .requestTarget('settings-appearance-sidebar-items')
                  navigate({ to: route.settings.interface })
                }}
              >
                {t('onboarding:sidebar.customize')}
              </Button>
            </div>
          )}
          {!allDone && current === 'choose-model' && (
            <div className="px-0.5 pt-1 pb-2">
              <ModelSetupCard />
            </div>
          )}
        </FrameBody>
      </Frame>
    )
  }

  if (!resume) return null
  return <ResumeRecentLink />
}

/** "Continue your last conversation: ..." -- nothing when there is none. */
function newestThreadId(
  threads: Record<string, { id: string; updated?: number }> | undefined
): string | undefined {
  let best: { id: string; updated?: number } | undefined
  for (const th of Object.values(threads ?? {})) {
    if (!best || (th.updated ?? 0) > (best.updated ?? 0)) best = th
  }
  return best?.id
}

export function ResumeRecentLink({ className }: { className?: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  // The newest chat's id and title, as primitives, so other chats changing
  // never re-render the link.
  const recentId = useThreads((s) => newestThreadId(s.threads))
  const recentTitle = useThreads((s) =>
    recentId ? s.threads[recentId]?.title : undefined
  )
  if (!recentId) return null
  const recent = { id: recentId, title: recentTitle }
  return (
    <div className={cn('text-center', className)}>
      <button
        type="button"
        className="text-[length:calc(var(--ui-font-base)*0.78125)] whitespace-normal text-secondary-foreground underline underline-offset-2 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
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
  onOpenCowork,
}: {
  step: GuideStepId
  intent: 'question' | 'documents' | 'project'
  done: boolean
  current: boolean
  onConfirm: () => void
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
      className="flex items-center gap-3 px-0.5 py-2 text-[length:calc(var(--ui-font-base)*0.8125)]"
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
