import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  hasVoices,
  readAloud,
  speakingMessageId,
  stopReadAloud,
  subscribeReadAloud,
} from '@/lib/readAloud'
import { IconPlayerStopFilled, IconVolume } from '@tabler/icons-react'
import { useEffect, useState, useSyncExternalStore } from 'react'

let voicesChecked: Promise<boolean> | null = null

export const ReadAloudButton = ({
  messageId,
  text,
}: {
  messageId: string
  text: string
}) => {
  const { t } = useTranslation()
  const [available, setAvailable] = useState(false)
  const speaking =
    useSyncExternalStore(subscribeReadAloud, speakingMessageId) === messageId

  useEffect(() => {
    let alive = true
    voicesChecked ??= hasVoices()
    voicesChecked.then((ok) => alive && setAvailable(ok))
    return () => {
      alive = false
    }
  }, [])

  // Leaving the thread unmounts the message: stop it if it is still talking.
  useEffect(
    () => () => {
      if (speakingMessageId() === messageId) stopReadAloud()
    },
    [messageId]
  )

  if (!available) return null

  const label = speaking
    ? t('chat:actions.stopReading')
    : t('chat:actions.readAloud')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="h-7 min-w-7 text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent pointer-coarse:h-11 pointer-coarse:min-w-11"
          aria-label={label}
          aria-pressed={speaking}
          onClick={() =>
            speaking
              ? stopReadAloud()
              : readAloud(messageId, text, t('chat:actions.codeOmitted'))
          }
        >
          {speaking ? (
            <IconPlayerStopFilled className="size-3.5" />
          ) : (
            <IconVolume className="size-4" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** Test hook: forget the cached voice check. */
export const resetReadAloudVoiceCheck = () => {
  voicesChecked = null
}
