import { useState } from 'react'
import { toast } from 'sonner'
import { Card, CardItem } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SecretInput } from '@/components/ui/secret-input'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import FallbackModelsPicker from '@/containers/FallbackModelsPicker'

const TOKEN_VALIDATION_TIMEOUT_MS = 10_000

/**
 * Defaults that apply to every model: the fallback chain, the Hugging Face
 * token used for downloads, and the download speed limit (desktop only).
 */
export function ModelDefaultsCard() {
  const { t } = useTranslation()
  const huggingfaceToken = useGeneralSetting((s) => s.huggingfaceToken)
  const setHuggingfaceToken = useGeneralSetting((s) => s.setHuggingfaceToken)
  const downloadLimitMBps = useGeneralSetting((s) => s.downloadLimitMBps)
  const setDownloadLimitMBps = useGeneralSetting((s) => s.setDownloadLimitMBps)
  const [isValidatingToken, setIsValidatingToken] = useState(false)

  const validateToken = async () => {
    const token = (huggingfaceToken || '').trim()
    if (!token) {
      toast.error('Please enter a Hugging Face token to validate')
      return
    }
    setIsValidatingToken(true)
    const controller = new AbortController()
    const timeoutId = setTimeout(
      () => controller.abort(),
      TOKEN_VALIDATION_TIMEOUT_MS
    )
    try {
      const resp = await fetch('https://huggingface.co/api/whoami-v2', {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
      if (resp.ok) {
        const data = await resp.json()
        toast.success('Token is valid', {
          description: data?.name
            ? `Signed in as ${data.name}`
            : 'Your Hugging Face token is valid.',
        })
      } else {
        toast.error('Token invalid', {
          description:
            'The provided Hugging Face token is invalid. Please check your token and try again.',
        })
      }
    } catch (e) {
      const name = (e as { name?: string })?.name
      if (name === 'AbortError') {
        toast.error('Validation timed out', {
          description:
            'The validation request timed out. Please check your network connection and try again.',
        })
      } else {
        toast.error('Validation failed', {
          description:
            'A network error occurred while validating the token. Please check your internet connection.',
        })
      }
    } finally {
      clearTimeout(timeoutId)
      setIsValidatingToken(false)
    }
  }

  return (
    <Card title={t('settings:modelDefaults.title', { defaultValue: 'Defaults' })}>
      <CardItem
        anchor="settings-model-providers-fallback-models"
        title={t('settings:general.fallbackModels')}
        description={t('settings:general.fallbackModelsDesc')}
        actions={<FallbackModelsPicker />}
      />
      <CardItem
        anchor="settings-model-providers-huggingface-token"
        title={t('settings:general.huggingfaceToken', {
          ns: 'settings',
        })}
        description={t('settings:general.huggingfaceTokenDesc', {
          ns: 'settings',
        })}
        column
        actions={
          <div className="flex w-full min-w-0 items-center gap-2">
            <SecretInput
              id="hf-token"
              className="min-w-0 flex-1 font-mono"
              value={huggingfaceToken || ''}
              onChange={(e) => setHuggingfaceToken(e.target.value)}
              placeholder={'hf_xxx_xxx'}
              required
            />
            <Button
              variant="outline"
              size="sm"
              disabled={isValidatingToken}
              onClick={validateToken}
            >
              {t('settings:general.verify')}
            </Button>
          </div>
        }
      />
      {IS_TAURI && (
        <CardItem
          anchor="settings-model-providers-download-limit"
          title={t('settings:general.downloadLimit')}
          description={t('settings:general.downloadLimitDesc')}
          actions={
            <Input
              type="number"
              min={0}
              step={1}
              className="w-24"
              value={downloadLimitMBps}
              onChange={(e) => setDownloadLimitMBps(Number(e.target.value))}
            />
          }
        />
      )}
    </Card>
  )
}
