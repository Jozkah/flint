import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Switch } from '@/components/ui/switch'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { guestApi, type GuestApi } from '@/lib/guestShare'

/**
 * Settings > Chat > Guest links. Off by default: a link shows one conversation
 * to anyone who has it, from outside this computer. Turning it off ends every
 * link at once. The backend owns the switch and refuses guests while it is off.
 */
export function GuestLinksCard({ api = guestApi }: { api?: GuestApi }) {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    api
      .getEnabled()
      .then((on) => alive && setEnabled(on))
      .catch(() => undefined)
      .finally(() => alive && setLoaded(true))
    return () => {
      alive = false
    }
  }, [api])

  const change = async (on: boolean) => {
    try {
      setEnabled(await api.setEnabled(on))
    } catch {
      toast.error(t('chat:guest.failed'))
    }
  }

  return (
    <Card title={t('chat:guest.group')}>
      <CardItem
        title={t('chat:guest.enable')}
        description={t('chat:guest.enableDesc')}
        wrapDescription
        actions={
          <Switch
            checked={enabled}
            disabled={!loaded}
            onCheckedChange={(on) => void change(on)}
            aria-label={t('chat:guest.enable')}
            data-testid="guest-links-switch"
          />
        }
      />
    </Card>
  )
}
