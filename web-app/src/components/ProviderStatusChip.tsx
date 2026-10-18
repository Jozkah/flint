import { useTranslation } from '@/i18n/react-i18next-compat'
import { Chip } from '@/components/ui/chip'
import { missingKeyLabelKey, type ProviderKeyStatus } from '@/lib/providerKeyStatus'

/**
 * The status chip of a provider that is switched on: running (local engine),
 * connected (a key is saved, or none is needed) or a warning when a remote
 * provider has no API key. "Connected" never means the network was checked.
 */
export function ProviderStatusChip({ status }: { status: ProviderKeyStatus }) {
  const { t } = useTranslation()
  if (status === 'missing' || status === 'credentials-missing') {
    return (
      <Chip tone="warn" dot>
        {t(missingKeyLabelKey(status === 'credentials-missing' ? 'bedrock' : undefined))}
      </Chip>
    )
  }
  return (
    <Chip tone="ok" dot>
      {status === 'local'
        ? t('engine:status.running')
        : status === 'keyless'
          ? t('engine:status.keyless')
          : t('engine:status.connected')}
    </Chip>
  )
}
