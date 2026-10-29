import { useState } from 'react'
import { Check, Cpu, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import type { GpuVerdict, SetupStageState } from '@/hooks/useSetupChecklist'
import type { WizardStep } from '@/lib/setupFlow'
import { DependencyAdvice } from '../dialogs/DependencyAdvice'

/**
 * The setup page below its heading: the GPU badge, any warning with its
 * detail and dependency advice, the engine's asset name, and the actions.
 */
export function EngineInstallStatus({
  page,
  gpu,
  warnings,
  isWarning,
  isSetupComplete,
  isRunning,
  engineBackendName,
  onContinue,
  onRerun,
}: {
  page: WizardStep
  gpu: GpuVerdict
  warnings: SetupStageState[]
  isWarning: boolean
  isSetupComplete: boolean
  isRunning: boolean
  engineBackendName: string | undefined
  onContinue: () => void
  onRerun: () => void
}) {
  const { t } = useTranslation()
  const [showDetails, setShowDetails] = useState(false)

  // Named dependencies come from the same warning the standalone dialog would
  // have raised; the advice is rendered inline here instead.
  const dependencyWarning = warnings.find(
    (warning) => (warning.missingLibraries?.length ?? 0) > 0
  )
  const missingLibraries = dependencyWarning?.missingLibraries ?? []
  const dependencyBackend = dependencyWarning?.backend ?? ''

  return (
    <>
      {/* The one fact a user cannot infer from a progress line:
          whether the work they are waiting for lands on the GPU. */}
      <div
        className={cn(
          'mt-5 flex items-start gap-2.5 rounded-md border px-3.5 py-3',
          gpu.willUse
            ? 'border-success/30 bg-success-tint'
            : 'border-border bg-muted'
        )}
        data-testid="setup-gpu-badge"
      >
        <span
          className={cn(
            'mt-0.5 shrink-0',
            gpu.willUse ? 'text-success' : 'text-muted-foreground'
          )}
        >
          {gpu.willUse === undefined ? (
            <Loader2 className="size-[15px] motion-safe:animate-spin" />
          ) : gpu.willUse ? (
            <Check className="size-[15px]" />
          ) : (
            <Cpu className="size-[15px]" />
          )}
        </span>
        <div className="min-w-0">
          <p
            className={cn(
              'text-sm font-medium',
              gpu.willUse ? 'text-success' : 'text-foreground'
            )}
          >
            {gpu.willUse === undefined
              ? t('setup:badgeGpuUnknown')
              : gpu.willUse
                ? t('setup:badgeGpu')
                : t('setup:badgeCpu')}
          </p>
          {gpu.label && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {gpu.label}
            </p>
          )}
        </div>
      </div>

      {isWarning && (
        <div className="mt-4" data-testid="setup-page-warning">
          {warnings.length > 1 && (
            <p className="mb-2 text-xs text-destructive">
              {t('setup:otherWarnings', {
                count: warnings.length - 1,
              })}
            </p>
          )}
          {page.detail && (
            <>
              <button
                type="button"
                aria-expanded={showDetails}
                className="rounded-sm text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground pointer-coarse:min-h-11"
                onClick={() => setShowDetails((prev) => !prev)}
              >
                {showDetails ? t('setup:hideDetails') : t('setup:showDetails')}
              </button>
              {showDetails && (
                <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted p-2.5 font-mono text-xs text-fg-2">
                  {page.detail}
                </pre>
              )}
            </>
          )}
          {missingLibraries.length > 0 && (
            <div className="mt-3">
              <DependencyAdvice
                backend={dependencyBackend}
                missingLibraries={missingLibraries}
              />
            </div>
          )}
        </div>
      )}

      {/* The engine's asset name: a caption, never the sentence. */}
      {engineBackendName && (
        <p
          className="mt-3 truncate font-mono text-[length:calc(var(--ui-font-base)*0.6875)] text-muted-foreground"
          title={engineBackendName}
        >
          {engineBackendName}
        </p>
      )}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        {/* Continue once the work is done; the same button skips
            ahead while it is still running, since this page covers
            a backend download and waiting must not be the only
            option. */}
        <Button className="flex-1 pointer-coarse:h-11" onClick={onContinue}>
          {isSetupComplete
            ? t('setup:continueStep')
            : isWarning
              ? t('setup:continueAnyway')
              : t('setup:skipStep')}
        </Button>
        {isWarning && !isRunning && (
          <Button variant="link" onClick={onRerun} className="px-0">
            {t('setup:retryChecks')}
          </Button>
        )}
      </div>
    </>
  )
}
