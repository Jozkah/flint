import { ArrowUp, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * The composer's send slot: Stop while a reply streams or a tool runs, Send
 * otherwise.
 */
export function ComposerSendButton({
  isStreaming,
  toolInFlight,
  onStop,
  canSend,
  ready,
  sending,
  onSend,
}: {
  isStreaming: boolean
  toolInFlight: boolean
  onStop: () => void
  /** Send is enabled. */
  canSend: boolean
  /** There is something to send: the button wakes up. */
  ready: boolean
  sending: boolean
  onSend: () => void
}) {
  const { t } = useTranslation()
  if (isStreaming || toolInFlight) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* A quiet red outline: stopping keeps the partial
              reply, so it is not a filled destructive action. */}
          <Button
            variant="outline"
            size="icon-sm"
            className="hit-y size-7 border-destructive/40 text-destructive hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive hover:shadow-none pointer-coarse:size-11"
            data-test-id="stop-button"
            aria-label={t('common:a11y.stopGenerating')}
            onClick={onStop}
          >
            <Square className="size-3 fill-current" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>
            {isStreaming
              ? t('chat:composer.stopGenerating')
              : t('chat:stopToolCall')}
          </p>
        </TooltipContent>
      </Tooltip>
    )
  }
  return (
    <Button
      variant="default"
      size="icon-sm"
      disabled={!canSend}
      aria-busy={sending || undefined}
      data-test-id="send-message-button"
      data-press="static"
      aria-label={t('chat:sendMessage')}
      onClick={onSend}
      className={cn(
        'hit-y size-7 pointer-coarse:size-11',
        // Wakes up with a small pop once there is something to send.
        ready &&
          'shadow-[0_4px_14px_-4px_rgba(0,0,0,.35)] motion-safe:animate-send-ready'
      )}
    >
      <ArrowUp className="size-4" />
    </Button>
  )
}
