import { useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { SandboxApplyOutcome, SandboxApplyPlan } from '@/lib/coworkSandboxApply'
import { errorText } from '@/lib/errorText'
import { basenameOf } from '@/lib/coworkPreview'

export type ApplyState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  /** A guessed destination, shown for the user to accept before copying. */
  | { kind: 'where' }
  | { kind: 'confirm' }
  | { kind: 'done'; outcome: 'created' | 'replaced' }
  | { kind: 'error'; message: string }

/**
 * Copy one sandbox file into the attached folder. An existing file there is
 * only replaced after the user confirms it here.
 */
export function SandboxApply({
  path,
  plan,
  onApply,
}: {
  path: string
  plan: SandboxApplyPlan
  onApply: (path: string, overwrite: boolean) => Promise<SandboxApplyOutcome>
}) {
  const { t } = useTranslation()
  const [state, setState] = useState<ApplyState>({ kind: 'idle' })

  const apply = async (overwrite: boolean) => {
    setState({ kind: 'busy' })
    try {
      const outcome = await onApply(path, overwrite)
      setState(outcome === 'exists' ? { kind: 'confirm' } : { kind: 'done', outcome })
    } catch (e) {
      setState({ kind: 'error', message: errorText(e) })
    }
  }

  const button =
    'rounded-md border-[0.8px] border-border bg-card px-1.5 py-0.5 text-[length:calc(var(--ui-font-base)*0.65625)] text-secondary-foreground hover:text-foreground disabled:opacity-50'

  const folderName = basenameOf(plan.folder) || plan.folder
  const hint = t('common:changes.applyHint', {
    folder: folderName,
    path: plan.destination,
  })

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 pb-2 pl-8 text-[length:calc(var(--ui-font-base)*0.6875)] text-muted-foreground">
      {state.kind === 'where' ? (
        <>
          <span role="alert">
            {t('common:changes.applyWhere', {
              folder: folderName,
              path: plan.destination,
              source: plan.source,
            })}
          </span>
          <button type="button" className={button} onClick={() => void apply(false)}>
            {t('common:changes.applyConfirm')}
          </button>
          <button
            type="button"
            className={button}
            onClick={() => setState({ kind: 'idle' })}
          >
            {t('common:cancel')}
          </button>
        </>
      ) : state.kind === 'confirm' ? (
        <>
          <span role="alert">{t('common:changes.applyExists')}</span>
          <button type="button" className={button} onClick={() => void apply(true)}>
            {t('common:changes.applyReplace')}
          </button>
          <button
            type="button"
            className={button}
            onClick={() => setState({ kind: 'idle' })}
          >
            {t('common:cancel')}
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className={button}
            disabled={state.kind === 'busy'}
            title={hint}
            aria-label={hint}
            // A guessed destination is shown before anything is copied.
            onClick={() =>
              plan.remapped ? setState({ kind: 'where' }) : void apply(false)
            }
          >
            {t('common:changes.applyToFolder')}
          </button>
          <span role="status">
            {state.kind === 'done'
              ? t(
                  state.outcome === 'replaced'
                    ? 'common:changes.applyReplaced'
                    : 'common:changes.applyCreated'
                )
              : state.kind === 'error'
                ? t('common:changes.applyFailed', { message: state.message })
                : null}
          </span>
        </>
      )}
    </div>
  )
}
