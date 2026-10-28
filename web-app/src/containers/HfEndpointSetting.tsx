import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { CardItem } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useServiceHub } from '@/hooks/useServiceHub'

export const HF_MIRROR_ENDPOINT = 'https://hf-mirror.com'

type Mode = 'default' | 'mirror' | 'custom'

export function modeOf(endpoint: string): Mode {
  const value = endpoint.trim().replace(/\/+$/, '')
  if (!value) return 'default'
  return value === HF_MIRROR_ENDPOINT ? 'mirror' : 'custom'
}

/**
 * Which Hugging Face hub model search and downloads use: huggingface.co,
 * hf-mirror.com, or a custom https mirror. The HF_ENDPOINT environment
 * variable still wins, and the token goes to a mirror only when allowed here.
 */
export function HfEndpointSetting() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const [mode, setMode] = useState<Mode>('default')
  const [custom, setCustom] = useState('')
  const [sendToken, setSendToken] = useState(false)
  const [envOverride, setEnvOverride] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    serviceHub
      .app()
      .getHfEndpointSetting()
      .then((s) => {
        if (!live) return
        const m = modeOf(s.endpoint)
        setMode(m)
        setCustom(m === 'custom' ? s.endpoint : '')
        setSendToken(s.sendTokenToMirror)
        setEnvOverride(s.envOverride)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [serviceHub])

  const endpointFor = (m: Mode) =>
    m === 'default' ? '' : m === 'mirror' ? HF_MIRROR_ENDPOINT : custom.trim()

  const save = async (m: Mode, send: boolean) => {
    try {
      await serviceHub.app().setHfEndpointSetting(endpointFor(m), send)
      toast.success(t('settings:general.hfEndpointSaved'))
      return true
    } catch (e) {
      toast.error(String(e))
      return false
    }
  }

  const changeMode = (m: Mode) => {
    setMode(m)
    if (m !== 'custom') void save(m, sendToken)
  }

  const changeSendToken = async (send: boolean) => {
    if (await save(mode, send)) setSendToken(send)
  }

  return (
    <>
      <CardItem
        anchor="settings-model-providers-hf-endpoint"
        title={t('settings:general.hfEndpoint')}
        description={t('settings:general.hfEndpointDesc')}
        column
        actions={
          <div className="flex w-full min-w-0 flex-col gap-2">
            <Segmented<Mode>
              aria-label={t('settings:general.hfEndpoint')}
              value={mode}
              onValueChange={changeMode}
              options={[
                {
                  value: 'default',
                  label: t('settings:general.hfEndpointDefault'),
                },
                { value: 'mirror', label: 'hf-mirror.com' },
                {
                  value: 'custom',
                  label: t('settings:general.hfEndpointCustom'),
                },
              ]}
            />
            {mode === 'custom' && (
              <div className="flex w-full min-w-0 items-center gap-2">
                <Input
                  id="hf-endpoint"
                  className="min-w-0 flex-1 font-mono"
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  placeholder="https://mirror.example.com"
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!custom.trim()}
                  onClick={() => void save('custom', sendToken)}
                >
                  {t('settings:general.hfEndpointSave')}
                </Button>
              </div>
            )}
            {envOverride && (
              <p className="text-xs text-muted-foreground">
                {t('settings:general.hfEndpointEnvOverride', {
                  value: envOverride,
                })}
              </p>
            )}
          </div>
        }
      />
      {mode !== 'default' && (
        <CardItem
          anchor="settings-model-providers-hf-endpoint-token"
          title={t('settings:general.hfEndpointSendToken')}
          description={t('settings:general.hfEndpointSendTokenDesc')}
          actions={
            <Switch
              checked={sendToken}
              onCheckedChange={(v) => void changeSendToken(v)}
            />
          }
        />
      )}
    </>
  )
}
