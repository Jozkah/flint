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

  const worked = useMemo(() => {
    if (!results?.length) return false
    return (
      evidenceFor(results, {
        // The file size is not known on a row; size changes are checked in
        // the details view, which has it.
        modelSizeBytes: null,
        settings: settingsFromModel(model),
        runtimeVersion: runtimeVersion(),
        device: deviceSignature(hardware),
      }).state === 'ran-successfully'
    )
  }, [results, model, hardware])

  if (!worked && !isDefault) return null

  return (
    <span className="flex shrink-0 items-center gap-1">
      {isDefault && (
        <span className="rounded-full border px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {t('model-fit:badge.default')}
        </span>
      )}
      {worked && (
        <span className="rounded-full border border-green-500/40 px-1.5 py-0.5 text-[10px] text-green-700 dark:text-green-400">
          {t('model-fit:badge.worked')}
        </span>
      )}
    </span>
  )
}
