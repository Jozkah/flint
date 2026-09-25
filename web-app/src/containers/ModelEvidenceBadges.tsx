import { useMemo } from 'react'
import { useHardware } from '@/hooks/useHardware'
import { useModelEvidence } from '@/hooks/useModelEvidence'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  deviceSignature,
  evidenceFor,
  resultKey,
  settingsFromModel,
} from '@/lib/modelEvidence'
import { runtimeVersion } from '@/containers/ModelSupportStatus'

/** The design's `.evb`: a quiet tag, the same for every measured fact. */
const EVIDENCE_BADGE =
  'rounded-[5px] bg-accent px-1.5 py-px text-[10.5px] leading-4 whitespace-nowrap text-muted-foreground shadow-[inset_0_0_0_0.8px_var(--border)]'

/**
 * Small, text-only labels on a model picker row: whether the model has been
 * measured to work here under its current settings, and whether it is the
 * user's default for new chats. Neither hides or reorders anything.
 */
export function ModelEvidenceBadges({
  provider,
  model,
}: {
  provider: string
  model: Model
}) {
  const { t } = useTranslation()
  const hardware = useHardware((s) => s.hardwareData)
  const results = useModelEvidence((s) => s.results[resultKey(provider, model.id)])
  const isDefault = useModelEvidence(
    (s) =>
      s.preferredModel?.provider === provider &&
      s.preferredModel?.model === model.id
  )

  const state = useMemo(() => {
    if (!results?.length) return null
    return evidenceFor(results, {
      // The file size is not known on a row; size changes are checked in
      // the details view, which has it.
      modelSizeBytes: null,
      settings: settingsFromModel(model),
      runtimeVersion: runtimeVersion(),
      device: deviceSignature(hardware),
    }).state
  }, [results, model, hardware])
  const worked = state === 'ran-successfully'
  // A measured refusal by the runtime is a concrete incompatibility, unlike a
  // memory estimate, so it is stated on the row. Selecting stays possible:
  // the engine's own error is what the user then sees, not a silent block.
  const unsupported = state === 'unsupported'

  if (!worked && !unsupported && !isDefault) return null

  return (
    // Compact tinted labels in the same shape as every other status in the
    // app, so "Worked here" reads as a measured state, not as decoration.
    <span className="flex shrink-0 items-center gap-1">
      {isDefault && (
        <span className={EVIDENCE_BADGE}>
          {t('model-fit:badge.default')}
        </span>
      )}
      {unsupported && (
        <span className="rounded-md bg-destructive-tint px-1.5 text-[11px] font-medium leading-5 text-destructive">
          {t('model-fit:badge.unsupported')}
        </span>
      )}
      {worked && (
        <span className={EVIDENCE_BADGE}>
          {t('model-fit:badge.worked')}
        </span>
      )}
    </span>
  )
}
