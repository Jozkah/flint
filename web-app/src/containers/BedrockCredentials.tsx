import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { SecretInput } from '@/components/ui/secret-input'
import { useBedrockCredentials } from '@/hooks/useBedrockCredentials'
import {
  getBedrockCredentialStatus,
  setBedrockCredential,
  type BedrockCredentialField,
  type BedrockCredentialStatus,
} from '@/lib/bedrock'

const FIELDS: { field: BedrockCredentialField; label: string; hint?: string }[] = [
  { field: 'access_key_id', label: 'providers:bedrock.accessKeyId' },
  { field: 'secret_access_key', label: 'providers:bedrock.secretAccessKey', hint: 'providers:bedrock.secretHint' },
  { field: 'session_token', label: 'providers:bedrock.sessionToken', hint: 'providers:bedrock.sessionTokenHint' },
]

/**
 * AWS credentials for Amazon Bedrock. A typed value goes straight to the OS
 * keyring on blur and is dropped from this component; it is never read back,
 * only whether one is saved.
 */
export function BedrockCredentials() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<BedrockCredentialStatus | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void getBedrockCredentialStatus().then(setStatus)
    void useBedrockCredentials.getState().refresh()
  }, [])
  useEffect(refresh, [refresh])

  const commit = async (field: BedrockCredentialField) => {
    const value = (drafts[field] ?? '').trim()
    if (!value) return
    try {
      await setBedrockCredential(field, value)
      setError(null)
      setDrafts((d) => ({ ...d, [field]: '' }))
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const clear = async (field: BedrockCredentialField) => {
    try {
      await setBedrockCredential(field, '')
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-[13px] font-medium text-foreground">
          {t('providers:bedrock.title')}
        </h3>
        <p className="text-xs leading-normal text-muted-foreground">
          {t('providers:bedrock.description')}
        </p>
      </div>
      {FIELDS.map(({ field, label, hint }) => {
        const saved = status?.[field] === true
        return (
          <div key={field} className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-medium text-foreground">{t(label)}</label>
              {saved && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline"
                  onClick={() => void clear(field)}
                >
                  {t('providers:bedrock.saved')} · {t('providers:bedrock.remove')}
                </button>
              )}
            </div>
            <SecretInput
              className="font-mono"
              placeholder={
                saved ? t('providers:bedrock.replace') : t('providers:bedrock.enter')
              }
              value={drafts[field] ?? ''}
              onChange={(e) => setDrafts((d) => ({ ...d, [field]: e.target.value }))}
              onBlur={() => void commit(field)}
              spellCheck={false}
              autoComplete="off"
            />
            {hint && (
              <p className="text-xs leading-normal text-muted-foreground">{t(hint)}</p>
            )}
          </div>
        )
      })}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
