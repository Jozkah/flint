import { useState } from 'react'
import { ArrowRight, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn, getModelDisplayName } from '@/lib/utils'
import { DEFAULT_CTX_LENGTH } from '@/lib/modelCompatibility'
import { ModelSetupCard } from '../ModelSetupCard'
import { ModelSupportStatus } from '../ModelSupportStatus'
import { SidebarItemsPicker } from '../SidebarItemsPicker'

/**
 * The finish page: where processing happens, the sidebar picker, and the
 * choice of a local model already on disk (or none).
 */
export function ModelPickStep({
  localModels,
  onConnectRemote,
  onFinish,
}: {
  localModels: Model[]
  onConnectRemote: () => void
  onFinish: (modelId?: string) => void
}) {
  const { t } = useTranslation()
  /** Whichever local model the user picks, if any. */
  const [chosenModel, setChosenModel] = useState<string | null>(null)
  /** The inline sidebar picker, closed until asked for. */
  const [customizingSidebar, setCustomizingSidebar] = useState(false)

  return (
    <div className="mt-5" data-testid="setup-finish">
      <section
        aria-labelledby="setup-processing-heading"
        className="mb-4 rounded-md border border-border bg-muted px-3.5 py-3 text-xs leading-relaxed"
        data-testid="setup-processing"
      >
        <h2
          id="setup-processing-heading"
          className="text-sm font-semibold text-foreground"
        >
          {t('onboarding:processingHeading')}
        </h2>
        <p className="mt-1.5 text-fg-2">{t('onboarding:processingLocal')}</p>
        <p className="mt-1.5 text-fg-2">{t('onboarding:processingRemote')}</p>
        <Button
          variant="link"
          className="mt-1 h-auto px-0 text-xs pointer-coarse:min-h-11"
          data-testid="setup-connect-remote"
          onClick={onConnectRemote}
        >
          {t('onboarding:connectRemote')}
        </Button>
      </section>
      <section
        aria-labelledby="setup-sidebar-heading"
        className="mb-4 rounded-md border border-border bg-muted px-3.5 py-3 text-xs leading-relaxed"
        data-testid="setup-sidebar"
      >
        <h2
          id="setup-sidebar-heading"
          className="text-sm font-semibold text-foreground"
        >
          {t('onboarding:sidebar.title')}
        </h2>
        <p className="mt-1.5 text-fg-2">{t('onboarding:sidebar.body')}</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-2 pointer-coarse:h-11"
          data-testid="setup-customize-sidebar"
          aria-expanded={customizingSidebar}
          onClick={() => setCustomizingSidebar((open) => !open)}
        >
          {customizingSidebar
            ? t('onboarding:sidebar.close')
            : t('onboarding:sidebar.customize')}
        </Button>
        {customizingSidebar && (
          <div className="mt-3 rounded-md border border-border bg-card px-3 py-2">
            <SidebarItemsPicker preview={false} />
          </div>
        )}
      </section>
      {localModels.length > 0 ? (
        <div
          role="radiogroup"
          aria-label={t('setup:finishChooseModel')}
          className="flex flex-col gap-1.5"
        >
          {localModels.map((model) => {
            const isChosen = chosenModel === model.id
            return (
              <button
                key={model.id}
                type="button"
                role="radio"
                aria-checked={isChosen}
                data-testid="setup-local-model"
                onClick={() => setChosenModel(model.id)}
                className={cn(
                  'flex min-h-11 items-center justify-between gap-2 rounded-lg border-[0.8px] px-3.5 py-2 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring',
                  isChosen
                    ? 'border-primary bg-accent'
                    : 'border-border bg-card hover:border-border-strong hover:bg-hover-row'
                )}
              >
                <span className="truncate">{getModelDisplayName(model)}</span>
                {isChosen && (
                  <Check className="size-4 shrink-0 text-acc-text" />
                )}
              </button>
            )
          })}
        </div>
      ) : (
        <>
          <p className="mb-3 text-sm text-muted-foreground">
            {t('setup:finishNoModels')}
          </p>
          <ModelSetupCard />
        </>
      )}

      {/* Fit advice for the model just picked, from the same
          check the model picker uses; read-only, runs nothing. */}
      {chosenModel && (
        <div
          className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"
          data-testid="setup-model-fit"
        >
          <span>{t('onboarding:fit.heading')}</span>
          <ModelSupportStatus
            modelId={chosenModel}
            provider="llamacpp"
            contextSize={DEFAULT_CTX_LENGTH}
          />
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button
          data-testid="setup-finish-start"
          className="pointer-coarse:h-11"
          onClick={() => onFinish(chosenModel ?? undefined)}
        >
          {chosenModel
            ? t('setup:finishStartChat')
            : t('setup:finishWithoutModel')}
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  )
}
