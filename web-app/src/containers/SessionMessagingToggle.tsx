import { useId } from 'react'
import { Switch } from '@/components/ui/switch'
import { DetailsCard, HelpTip } from '@/containers/DetailsCard'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useSessionMessaging } from '@/hooks/useSessionMessaging'

/**
 * Messaging settings for one session: "Automatic wake-ups" (on by default:
 * mail from another session is sent to this session's agent once it is idle;
 * off, it waits for the user) and "Accept messages" (on by default; off, other
 * sessions are refused when they try to write to this one).
 *
 * Two switch rows. Each row's rationale sits behind an (i): it still
 * describes the switch for assistive technology, without three lines of
 * grey under every control.
 */
export function SessionMessagingToggle({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation()
  const on = useSessionMessaging((s) => s.autoWake[sessionId] !== false)
  const accepts = useSessionMessaging((s) => s.optOut[sessionId] !== true)
  const switchId = useId()
  const descriptionId = useId()
  const acceptId = useId()
  const acceptDescriptionId = useId()

  const row = (
    id: string,
    describedBy: string,
    label: string,
    description: string,
    checked: boolean,
    testId: string,
    onChange: (checked: boolean) => void
  ) => (
    <div className="flex min-h-8 items-center gap-2">
      <label htmlFor={id} className="min-w-0 flex-1 text-[length:calc(var(--ui-font-base)*0.78125)] leading-5 text-foreground">
        {label}
      </label>
      <HelpTip id={describedBy} label={label}>
        {description}
      </HelpTip>
      <Switch
        id={id}
        checked={checked}
        aria-describedby={describedBy}
        data-testid={testId}
        onCheckedChange={(value) => onChange(value === true)}
      />
    </div>
  )

  return (
    <DetailsCard className="gap-1" data-testid="session-messaging-toggle">
      {row(
        acceptId,
        acceptDescriptionId,
        t('messaging:accept.label'),
        t('messaging:accept.description'),
        accepts,
        'session-messaging-accept',
        (checked) =>
          useSessionMessaging.getState().setAcceptsMessages(sessionId, checked)
      )}
      {row(
        switchId,
        descriptionId,
        t('messaging:autoWake.label'),
        t('messaging:autoWake.description'),
        on,
        'session-messaging-autowake',
        (checked) => useSessionMessaging.getState().setAutoWake(sessionId, checked)
      )}
    </DetailsCard>
  )
}
