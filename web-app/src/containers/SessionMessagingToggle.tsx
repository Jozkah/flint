import { useId } from 'react'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useSessionMessaging } from '@/hooks/useSessionMessaging'

/**
 * Messaging settings for one session: "Automatic wake-ups" (on by default:
 * mail from another session is sent to this session's agent once it is idle;
 * off, it waits for the user) and "Accept messages" (on by default; off, other
 * sessions are refused when they try to write to this one).
 */
export function SessionMessagingToggle({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation()
  const on = useSessionMessaging((s) => s.autoWake[sessionId] !== false)
  const accepts = useSessionMessaging((s) => s.optOut[sessionId] !== true)
  const switchId = useId()
  const descriptionId = useId()
  const acceptId = useId()
  const acceptDescriptionId = useId()
  return (
    <div className="space-y-2" data-testid="session-messaging-toggle">
      <div className="flex items-start gap-2 text-xs">
        <Switch
          id={acceptId}
          checked={accepts}
          aria-describedby={acceptDescriptionId}
          data-testid="session-messaging-accept"
          onCheckedChange={(checked) =>
            useSessionMessaging
              .getState()
              .setAcceptsMessages(sessionId, checked === true)
          }
        />
        <div className="min-w-0">
          <label htmlFor={acceptId} className="font-medium">
            {t('messaging:accept.label')}
          </label>
          <p id={acceptDescriptionId} className="text-muted-foreground">
            {t('messaging:accept.description')}
          </p>
        </div>
      </div>
      <div className="flex items-start gap-2 text-xs">
        <Switch
          id={switchId}
          checked={on}
          aria-describedby={descriptionId}
          data-testid="session-messaging-autowake"
          onCheckedChange={(checked) =>
            useSessionMessaging
              .getState()
              .setAutoWake(sessionId, checked === true)
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
    </div>
  )
}
