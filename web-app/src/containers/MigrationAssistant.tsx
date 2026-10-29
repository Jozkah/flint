import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { IconLoader } from '@tabler/icons-react'
import { toast } from 'sonner'
import { useMigrationAssistant } from '@/stores/migration-assistant-store'
import { useMigrationWizard } from '@/hooks/useMigrationWizard'
import {
  COPY_LIKE,
  MigrationChooseStep,
  MigrationResultStep,
  MigrationReviewStep,
} from './migration/MigrationSteps'

/**
 * First-launch JAN -> Flint migration assistant.
 *
 * Mounted once near the app root. On mount it detects a legacy JAN install and,
 * when a first launch is pending, opens itself. The Settings entry opens the
 * same assistant later ("import from JAN"). Every filesystem effect is done by
 * the Rust core behind the six migration commands; this component only drives
 * detect -> choose -> plan -> execute, and offers rollback/retry on failure.
 */
export function MigrationAssistant() {
  const { t } = useTranslation()
  const { open, openedManually, openFirstRun, closeAssistant } =
    useMigrationAssistant()

  const {
    step,
    setStep,
    detect,
    mode,
    setMode,
    selected,
    toggleCategory,
    defaultConflict,
    setDefaultConflict,
    plan,
    result,
    error,
    busy,
    rolledBack,
    buildPlan,
    runExecute,
    onContinue,
    onRollback,
    onNotNow,
    onNeverAsk,
    locked,
    onOpenChange,
  } = useMigrationWizard({ open, openedManually, openFirstRun, closeAssistant })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[560px] max-w-[92vw]"
        showCloseButton={!locked}
        onEscapeKeyDown={(e) => {
          if (locked) e.preventDefault()
        }}
        onInteractOutside={(e) => {
          if (locked) e.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('common:migration.title')}</DialogTitle>
          <DialogDescription>
            {step === 'nolegacy'
              ? t('common:migration.descriptionNoLegacy')
              : t('common:migration.descriptionFound')}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        {step === 'detect' && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <IconLoader size={16} className="animate-spin" />
            {t('common:migration.detecting')}
          </div>
        )}

        {step === 'nolegacy' && (
          <div className="py-4 text-sm text-muted-foreground">
            {t('common:migration.noData')}
          </div>
        )}

        {step === 'choose' && (
          <MigrationChooseStep
            detect={detect}
            mode={mode}
            onModeChange={setMode}
            selected={selected}
            onToggleCategory={toggleCategory}
            defaultConflict={defaultConflict}
            onDefaultConflictChange={setDefaultConflict}
          />
        )}

        {step === 'review' && plan && (
          <MigrationReviewStep
            plan={plan}
            defaultConflict={defaultConflict}
            onDefaultConflictChange={setDefaultConflict}
            onReplan={(c) => void buildPlan(c)}
          />
        )}

        {step === 'running' && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <IconLoader size={16} className="animate-spin" />
            {t('common:migration.running')}
          </div>
        )}

        {step === 'result' && (
          <MigrationResultStep
            result={result}
            error={error}
            rolledBack={rolledBack}
          />
        )}

        <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <div className="flex gap-2">
            {step === 'choose' && !openedManually && (
              <>
                <Button variant="ghost" size="sm" onClick={onNotNow} disabled={busy}>
                  {t('common:migration.notNow')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onNeverAsk}
                  disabled={busy}
                >
                  {t('common:migration.dontAskAgain')}
                </Button>
              </>
            )}
            {step === 'review' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setStep('choose')}
                disabled={busy}
              >
                {t('common:migration.back')}
              </Button>
            )}
          </div>

          <div className="flex gap-2">
            {step === 'nolegacy' && (
              <Button size="sm" onClick={closeAssistant}>
                {t('common:migration.close')}
              </Button>
            )}
            {step === 'choose' && (
              <Button
                size="sm"
                onClick={onContinue}
                disabled={
                  busy ||
                  (COPY_LIKE.includes(mode) && selected.size === 0)
                }
              >
                {busy ? <IconLoader size={14} className="animate-spin" /> : null}
                {mode === 'fresh'
                  ? t('common:migration.startFresh')
                  : t('common:migration.continue')}
              </Button>
            )}
            {step === 'review' && plan && (
              <Button
                size="sm"
                onClick={() => runExecute(plan)}
                disabled={busy}
              >
                {busy ? <IconLoader size={14} className="animate-spin" /> : null}
                {t('common:migration.migrate')}
              </Button>
            )}
            {/* Same test as the body: a throw (no result) or a complete
                status with an error is a failure, and keeps Roll back. */}
            {step === 'result' &&
              !(result?.status === 'complete' && !result.error) && (
                <>
                  {!(result?.rolled_back || rolledBack) && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={onRollback}
                      disabled={busy}
                    >
                      {t('common:migration.rollBack')}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    onClick={() => setStep('choose')}
                    disabled={busy}
                  >
                    {t('common:migration.retry')}
                  </Button>
                </>
              )}
            {step === 'result' &&
              result?.status === 'complete' &&
              !result.error && (
                <Button
                  size="sm"
                  onClick={() => {
                    // The new data folder is only read at startup.
                    if (result?.restart_required) {
                      const relaunch = window.core?.api?.relaunch
                      if (relaunch) window.core?.api?.relaunch()
                      else {
                        // No relaunch bridge here: say so rather than do nothing.
                        toast.info(t('common:migration.restartManually'))
                        closeAssistant()
                      }
                    } else closeAssistant()
                  }}
                >
                  {result?.restart_required
                    ? t('common:migration.restart')
                    : t('common:migration.done')}
                </Button>
              )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default MigrationAssistant
