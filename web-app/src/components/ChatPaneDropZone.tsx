import type { ReactNode } from 'react'
import { Paperclip } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useChatPaneDrop } from '@/hooks/useChatPaneDrop'
import { cn } from '@/lib/utils'

/**
 * The chat pane as a drop target: files dropped anywhere in it attach to the
 * message being composed, with a full-pane hint while they are dragged over.
 * The composer box and the code panel keep their own zones.
 */
export function ChatPaneDropZone({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}) {
  const { t } = useTranslation()
  const { active, handlers } = useChatPaneDrop()
  return (
    <div
      className={cn('relative', className)}
      data-testid="chat-pane-drop-zone"
      {...handlers}
    >
      {children}
      {active && (
        <div
          data-testid="chat-pane-drop-overlay"
          aria-hidden="true"
          className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-xl border-2 border-dashed border-primary/60 bg-background/70 backdrop-blur-sm motion-safe:animate-dd-in"
        >
          <span className="flex items-center gap-2 rounded-full bg-popover px-4 py-2 text-sm font-medium shadow-pop">
            <Paperclip className="size-4" />
            {t('common:chatPaneDrop.overlay')}
          </span>
        </div>
      )}
    </div>
  )
}
