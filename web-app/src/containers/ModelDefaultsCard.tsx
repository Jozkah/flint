import { useState } from 'react'
import { toast } from 'sonner'
import { Card, CardItem } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SecretInput } from '@/components/ui/secret-input'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import FallbackModelsPicker from '@/containers/FallbackModelsPicker'
import { HfEndpointSetting } from '@/containers/HfEndpointSetting'

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
      toast.error(t('settings:general.hfToken.empty'))
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
        toast.success(t('settings:general.hfToken.valid'), {
          description: data?.name
            ? t('settings:general.hfToken.signedInAs', { name: data.name })
            : t('settings:general.hfToken.validDesc'),
        })
      } else {
        toast.error(t('settings:general.hfToken.invalid'), {
          description: t('settings:general.hfToken.invalidDesc'),
        })
      }
    } catch (e) {
      const name = (e as { name?: string })?.name
      if (name === 'AbortError') {
        toast.error(t('settings:general.hfToken.timedOut'), {
          description: t('settings:general.hfToken.timedOutDesc'),
        })
      } else {
        toast.error(t('settings:general.hfToken.failed'), {
          description: t('settings:general.hfToken.failedDesc'),
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
      {IS_TAURI && <HfEndpointSetting />}
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
