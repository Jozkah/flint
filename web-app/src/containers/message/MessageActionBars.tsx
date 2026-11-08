import type { ChatStatus } from 'ai'
import { GitFork, Play, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { useTranslation } from '@/i18n/react-i18next-compat'
import { formatMessageTime } from '@/utils/formatMessageTime'
import { EditMessageDialog } from '@/containers/dialogs/EditMessageDialog'
import { DeleteMessageDialog } from '@/containers/dialogs/DeleteMessageDialog'
import TokenSpeedIndicator from '@/containers/TokenSpeedIndicator'
import { CopyButton } from '@/containers/CopyButton'
import { ReadAloudButton } from '@/containers/ReadAloudButton'
import { SkillsUsedPopover } from './SkillsUsedPopover'
import { CHAT_STATUS } from './types'


/**
 * Message actions appear on hover or keyboard focus, and stay visible on a
 * touch screen, which has no hover to reveal them.
 */
const REVEAL_ACTIONS =
  'opacity-0 motion-safe:transition-opacity group-hover/message:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100'

/** Icon actions: compact with a mouse, 44px with a finger. */
const ACTION_BUTTON =
  'size-7 text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent data-[state=open]:bg-transparent pointer-coarse:size-11'

type TranslateFn = ReturnType<typeof useTranslation>['t']

/** The row of actions under a user message. */
export function UserMessageActions({
  createdAt,
  versionNav,
  getFullTextContent,
  onEdit,
  onDelete,
  status,
  imageUrls,
  handleEdit,
  handleDelete,
  selectedModel,
  onRegenerate,
  isLastMessage,
  handleRegenerate,
  t,
}: {
  createdAt: number | undefined
  versionNav: React.ReactNode
  getFullTextContent: () => string
  onEdit?: (messageId: string, newText: string) => void
  onDelete?: (messageId: string) => void
  status: ChatStatus
  imageUrls: string[]
  handleEdit: (newText: string) => void
  handleDelete: () => void
  selectedModel: Model | null | undefined
  onRegenerate?: (messageId: string) => void
  isLastMessage: boolean
  handleRegenerate: () => void
  t: TranslateFn
}) {
  return (
    <div
      className={cn(
        'mt-1 flex flex-wrap items-center justify-end gap-0.5 text-muted-foreground text-xs',
        REVEAL_ACTIONS
      )}
    >
      {createdAt !== undefined && (
        <span
          className="mr-1 text-muted-foreground tabular-nums"
          title={new Date(createdAt).toLocaleString()}
        >
          {formatMessageTime(createdAt)}
        </span>
      )}
      {versionNav}
      <span className="inline-flex pointer-coarse:[&_button]:size-11">
        <CopyButton text={getFullTextContent()} />
      </span>

      {onEdit &&
        status !== CHAT_STATUS.STREAMING &&
        status !== CHAT_STATUS.SUBMITTED && (
          <EditMessageDialog
            message={getFullTextContent()}
            imageUrls={imageUrls.length > 0 ? imageUrls : undefined}
            onSave={handleEdit}
          />
        )}

      {onDelete &&
        status !== CHAT_STATUS.STREAMING &&
        status !== CHAT_STATUS.SUBMITTED && (
          <DeleteMessageDialog onDelete={handleDelete} />
        )}

      {/* Last with no reply (the reply was deleted, or never came):
          ask for one (C092). */}
      {selectedModel &&
        onRegenerate &&
        isLastMessage &&
        status !== CHAT_STATUS.STREAMING &&
        status !== CHAT_STATUS.SUBMITTED && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className={ACTION_BUTTON}
                onClick={handleRegenerate}
                aria-label={t('chat:actions.regenerate')}
              >
                <RefreshCw className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('chat:actions.regenerate')}</TooltipContent>
          </Tooltip>
        )}
    </div>
  )
}

/** The row under an assistant message: its actions, speed and skills. */
export function AssistantMessageActions({
  isStreaming,
  hideActions,
  versionNav,
  getFullTextContent,
  messageId,
  onEdit,
  handleEdit,
  onDelete,
  handleDelete,
  onFork,
  selectedModel,
  onContinue,
  isLastMessage,
  canContinue,
  handleContinue,
  onRegenerate,
  handleRegenerate,
  midReply,
  metadata,
  usedSkills,
  t,
}: {
  isStreaming: boolean
  hideActions: boolean | undefined
  versionNav: React.ReactNode
  getFullTextContent: () => string
  messageId: string
  onEdit?: (messageId: string, newText: string) => void
  handleEdit: (newText: string) => void
  onDelete?: (messageId: string) => void
  handleDelete: () => void
  onFork?: (messageId: string) => void
  selectedModel: Model | null | undefined
  onContinue?: (messageId: string) => void
  isLastMessage: boolean
  canContinue: boolean
  handleContinue: () => void
  onRegenerate?: (messageId: string) => void
  handleRegenerate: () => void
  midReply: boolean | undefined
  metadata: Record<string, unknown> | undefined
  usedSkills: string[]
  t: TranslateFn
}) {
  return (
    <div className="mt-1.5 flex h-7 flex-nowrap items-center gap-x-0.5 overflow-hidden text-muted-foreground text-xs pointer-coarse:h-11">
      {/* The time is on the header line above. */}
      <div
        className={cn(
          'flex items-center gap-0.5',
          // Every reply shows only its speed and tokens until hovered;
          // the actions then take their room and the figures move
          // right. Touch has no hover, so it always shows them.
          isStreaming || hideActions
            ? 'hidden'
            : 'hidden group-hover/message:flex group-focus-within/message:flex pointer-coarse:flex'
        )}
      >
        {versionNav}
        <span className="inline-flex pointer-coarse:[&_button]:size-11">
          <CopyButton text={getFullTextContent()} />
        </span>
        <ReadAloudButton
          messageId={messageId}
          text={getFullTextContent()}
        />

        {onEdit && !isStreaming && (
          <EditMessageDialog
            message={getFullTextContent()}
            onSave={handleEdit}
          />
        )}

      {onDelete && !isStreaming && (
        <DeleteMessageDialog onDelete={handleDelete} />
      )}

      {onFork && !isStreaming && (
        <Tooltip>
    <TooltipTrigger asChild>
    <Button
          variant="ghost"
          size="icon-xs"
          className={ACTION_BUTTON}
          onClick={() => onFork(messageId)}
          aria-label={t('chat:actions.fork')}
        >
          <GitFork className="size-3.5" />
        </Button>
    </TooltipTrigger>
    <TooltipContent>{t('chat:actions.fork')}</TooltipContent>
    </Tooltip>
      )}

        {selectedModel &&
          onContinue &&
          !isStreaming &&
          isLastMessage &&
          canContinue && (
            <Tooltip>
    <TooltipTrigger asChild>
    <Button
              variant="ghost"
              size="icon-xs"
              className={ACTION_BUTTON}
              onClick={handleContinue}
              aria-label={t('chat:actions.continue')}
            >
              <Play className="size-3.5" />
            </Button>
    </TooltipTrigger>
    <TooltipContent>{t('chat:actions.continue')}</TooltipContent>
    </Tooltip>
          )}

      {selectedModel &&
        onRegenerate &&
        !isStreaming &&
        isLastMessage && (
          <Tooltip>
    <TooltipTrigger asChild>
    <Button
            variant="ghost"
            size="icon-xs"
            className={ACTION_BUTTON}
            onClick={handleRegenerate}
            aria-label={t('chat:actions.regenerate')}
          >
            <RefreshCw className="size-3.5" />
          </Button>
    </TooltipTrigger>
    <TooltipContent>{t('chat:actions.regenerate')}</TooltipContent>
    </Tooltip>
        )}
    </div>

    {!midReply && (
      <TokenSpeedIndicator
        streaming={isStreaming}
        metadata={metadata}
      />
    )}
    {!isStreaming && usedSkills.length > 0 && (
      <SkillsUsedPopover skills={usedSkills} />
    )}
              </div>
  )
}
