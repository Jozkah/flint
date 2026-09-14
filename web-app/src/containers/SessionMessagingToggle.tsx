import { useId } from 'react'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useSessionMessaging } from '@/hooks/useSessionMessaging'

/**
 * "Automatic wake-ups" for one session. Off by default: mail from another
 * session waits for the user. On: it is sent to this session's agent once the
 * session is idle and in view.
 */
export function SessionMessagingToggle({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation()
  const on = useSessionMessaging((s) => s.autoWake[sessionId] === true)
  const switchId = useId()
  const descriptionId = useId()
  return (
    <div
      className="flex items-start gap-2 text-xs"
      data-testid="session-messaging-toggle"
    >
      <Switch
        id={switchId}
        checked={on}
        aria-describedby={descriptionId}
        data-testid="session-messaging-autowake"
        onCheckedChange={(checked) =>
          useSessionMessaging.getState().setAutoWake(sessionId, checked === true)
        }
      />
      <div className="min-w-0">
        <label htmlFor={switchId} className="font-medium">
          {t('messaging:autoWake.label')}
        </label>
        <p id={descriptionId} className="text-muted-foreground">
          {t('messaging:autoWake.description')}
        </p>
      </div>
    </div>
  )
}
