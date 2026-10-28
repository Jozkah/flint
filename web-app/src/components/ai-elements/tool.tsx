/* eslint-disable react-refresh/only-export-components */
import { useControllableState } from '@radix-ui/react-use-controllable-state'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import type { ToolUIPart } from 'ai'
import { ChevronDownIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { memo, useEffect, useMemo, useRef } from 'react'
import { summarizeToolInput } from '@/lib/toolInputSummary'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { useConversationPane } from '@/hooks/conversationPaneContext'
import { approvalForCall } from '@/lib/toolApprovalScope'
import { useToolCallRuntime } from '@/hooks/useToolCallRuntime'
import { timingFor } from '@/lib/toolTimingLog'
import { ToolElapsed } from './tool-runtime'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { ToolKindIcon, TOOL_TILE_CLASS } from '@/components/ToolKindTile'
import { toolKind } from '@/lib/toolKind'
import type { WorkState } from '@/containers/StatusChip'
import { ToolContext, useTool } from './tool/shared'
export { useTool } from './tool/shared'
export { ToolInput } from './tool/input'
export type { ToolInputProps } from './tool/input'
export { ToolApprovalActions } from './tool/approval'
export { ToolImage } from './tool/image'
export { ToolOutput } from './tool/output'
export type { ToolOutputProps } from './tool/output'

export type ToolProps = ComponentProps<typeof Collapsible> & {
  className?: string
  state: ToolUIPart['state']
  toolCallId?: string
  messageId?: string
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /** Bare tool name, for the card's kind colour. */
  name?: string
  /** Where the tool came from, for the card's kind colour. */
  origin?: string
  /**
   * The call failed in-band (e.g. a command's non-zero exit) even though the
   * part itself completed; the card then reads and colours as a failure.
   */
  failed?: boolean
  /**
   * The command ran and exited non-zero: a failed check, coloured amber
   * rather than as a failure (which stays for refusals, crashes, timeouts).
   */
  checkFailed?: boolean
  /**
   * Opens the card while true and closes it when it turns false, e.g. open
   * while the call runs and for a failure or a diff worth reading.
   */
  autoOpen?: boolean
}

export const Tool = memo(
  ({
    className,
    state,
    toolCallId,
    messageId,
    name,
    origin,
    failed = false,
    checkFailed = false,
    autoOpen,
    open,
    defaultOpen = false,
    onOpenChange,
    children,
    ...props
  }: ToolProps) => {
    const paneThreadId = useConversationPane()?.threadId
    const isPending = useToolApprovalRequests((s) =>
      Boolean(approvalForCall(s, toolCallId, paneThreadId))
    )
    const [isOpen, setIsOpen] = useControllableState({
      prop: open,
      defaultProp: defaultOpen || isPending || Boolean(autoOpen),
      onChange: onOpenChange,
    })

    // Follows `autoOpen` on change only, so a manual toggle in between holds.
    const autoOpenRef = useRef(autoOpen)
    useEffect(() => {
      if (autoOpen === undefined || autoOpen === autoOpenRef.current) return
      autoOpenRef.current = autoOpen
      setIsOpen(autoOpen)
    }, [autoOpen, setIsOpen])

    const wasPendingRef = useRef(isPending)
    useEffect(() => {
      if (isPending && !wasPendingRef.current) {
        setIsOpen(true)
      } else if (!isPending && wasPendingRef.current) {
        setIsOpen(false)
      }
      wasPendingRef.current = isPending
    }, [isPending, setIsOpen])

    const handleOpenChange = (newOpen: boolean) => {
      setIsOpen(newOpen)
    }

    const kind = toolKind({
      name: name ?? '',
      state: failed ? 'output-error' : state,
      origin,
      awaitingApproval: isPending,
      checkFailed,
    })

    return (
      <ToolContext.Provider
        value={{ isOpen, setIsOpen, state, toolCallId, messageId }}
      >
        {/* A compact card whose kind colour (styles/chat.css) marks the left
            edge, the icon tile and the status text. */}
        <Collapsible
          data-slot="tool-card"
          data-tool-kind={kind}
          className={cn(
            'tool-card not-prose min-w-0 overflow-hidden rounded-[10px] border-[0.8px] bg-card motion-safe:transition-shadow motion-safe:duration-200 hover:shadow-lift',
            className
          )}
          onOpenChange={handleOpenChange}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ToolContext.Provider>
    )
  }
)

Tool.displayName = 'Tool'

export type ToolHeaderProps = {
  title?: string
  state: ToolUIPart['state']
  type: ToolUIPart['type']
  className?: string
  /** Where the tool came from (web provider, documents, MCP server name). */
  origin?: string
  /** Arguments, previewed inline so a collapsed call still says what it did. */
  input?: ToolUIPart['input']
  /**
   * The one argument that says what the call acted on (a command, a path, a
   * query), shown instead of the generic `key: value` preview.
   */
  arg?: string
  /**
   * The argument rendered by the caller instead of as text, e.g. a path that
   * opens in the Code panel. `arg` is still the plain form.
   */
  argNode?: ReactNode
  /** A short outcome beside the argument: an exit code, a match count, +/-. */
  badge?: ReactNode
  /** The call failed in-band (see `Tool`). */
  failed?: boolean
  /**
   * One line saying what the call did, in place of the status word, origin
   * and argument. Used for the rows of a folded run.
   */
  sentence?: ReactNode
}

type TranslateFn = (key: string, options?: Record<string, unknown>) => string

const getStatusText = (
  t: TranslateFn,
  status: ToolUIPart['state'],
  toolName: string,
  awaitingApproval: boolean,
  isQueued: boolean
) => {
  const isRunning = status === 'input-streaming' || status === 'input-available'
  const hasError = status === 'output-error' || status === 'output-denied'
  // The tool's own name, as the model called it (`web_search`, `edit`).
  const tool = toolName

  if (awaitingApproval) {
    return t('tools:toolCall.awaitingApproval', { tool })
  }
  // Tools run one at a time, so a pending call is only "running" once the
  // executor has actually reached it.
  if (isQueued) {
    return t('tools:toolCall.queued', { tool })
  }
  if (isRunning) {
    return t('tools:toolCall.running', { tool })
  }
  if (hasError) {
    return t('tools:toolCall.failed', { tool })
  }
  return t('tools:toolCall.used', { tool })
}

export const ToolHeader = memo(
  ({
    className,
    title,
    state,
    type,
    origin,
    input,
    arg,
    argNode,
    badge,
    failed = false,
    sentence,
  }: ToolHeaderProps) => {
    const { t } = useTranslation()
    const { isOpen, toolCallId } = useTool()
    const paneThreadId = useConversationPane()?.threadId
    const awaitingApproval = useToolApprovalRequests((s) =>
      Boolean(approvalForCall(s, toolCallId, paneThreadId))
    )
    const toolName = title ?? type.split('-').slice(1).join('-')
    const summary = useMemo(
      () => (arg !== undefined ? arg : summarizeToolInput(input)),
      [arg, input]
    )
    // Position in the pending queue, or -1 once the executor has reached it.
    const queuePosition = useToolCallRuntime((s) =>
      toolCallId ? s.queue.indexOf(toolCallId) : -1
    )
    const startedAt = useToolCallRuntime((s) =>
      timingFor(s.timings, toolCallId)?.startedAt
    )
    const endedAt = useToolCallRuntime((s) =>
      timingFor(s.timings, toolCallId)?.endedAt
    )

    // Colour comes from the card's kind (Tool); the status text below still
    // says what happened, so colour is never the only signal.
    const isQueued = queuePosition >= 0
    const workState: WorkState = awaitingApproval
      ? 'needs-you'
      : isQueued
        ? 'queued'
        : state === 'input-streaming' || state === 'input-available'
          ? 'running'
          : failed || state === 'output-error' || state === 'output-denied'
            ? 'failed'
            : 'done'

    return (
      // A compact integrated row: kind icon, status in words (never the
      // accent for running), origin, a preview of the arguments, then how
      // long it took and the disclosure chevron.
      <CollapsibleTrigger
        data-slot="tool-header"
        className={cn(
          'group/tool-row flex min-h-[38px] w-full min-w-0 cursor-pointer items-center gap-2 px-2.5 py-2 text-left text-xs text-fg-2 transition-colors outline-hidden hover:bg-[color-mix(in_oklab,var(--tk)_4%,transparent)] focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11',
          className
        )}
      >
        <span
          aria-hidden
          data-slot="tool-icon"
          className={TOOL_TILE_CLASS}
        >
          <ToolKindIcon
            name={toolName}
            awaitingApproval={awaitingApproval}
            running={workState === 'running'}
          />
        </span>
        {sentence !== undefined ? (
          <span
            data-slot="tool-sentence"
            data-state={workState}
            className="min-w-0 flex-1 truncate text-[length:calc(var(--ui-font-base)*0.8125)] text-muted-foreground group-hover/tool-row:text-foreground"
          >
            {sentence}
          </span>
        ) : (
          <>
        <span
          data-state={workState}
          className="min-w-0 shrink-0 truncate font-medium text-(--tk)"
        >
          {getStatusText(
            t,
            failed && state === 'output-available' ? 'output-error' : state,
            toolName,
            awaitingApproval,
            isQueued
          )}
        </span>
        {origin && (
          <span className="hidden shrink-0 rounded-[5px] bg-[color-mix(in_oklab,var(--tk)_10%,transparent)] px-1.5 py-px text-[length:calc(var(--ui-font-base)*0.65625)] text-[color-mix(in_oklab,var(--tk)_80%,var(--foreground))] sm:inline">
            {origin}
          </span>
        )}
        {summary ? (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {argNode ?? summary}
          </span>
        ) : (
          <span className="flex-1" />
        )}
          </>
        )}
        {badge && (
          <span className="hidden shrink-0 items-center gap-2 sm:inline-flex">
            {badge}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[length:calc(var(--ui-font-base)*0.71875)] text-muted-foreground">
          {queuePosition > 0 && (
            <span>
              {t('tools:toolCall.queuedPosition', { count: queuePosition })}
            </span>
          )}
          <ToolElapsed
            startedAt={startedAt}
            endedAt={endedAt}
            className="font-mono text-[length:calc(var(--ui-font-base)*0.6875)] font-medium text-muted-foreground"
          />
          <ChevronDownIcon
            aria-hidden
            className={cn(
              'size-3 shrink-0 motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-expo',
              isOpen ? 'rotate-180' : 'rotate-0'
            )}
          />
        </span>
      </CollapsibleTrigger>
    )
  }
)

ToolHeader.displayName = 'ToolHeader'

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>

export const ToolContent = memo(
  ({ className, children, ...props }: ToolContentProps) => (
    <CollapsibleContent
      data-slot="tool-content"
      data-expanded-style="thin"
      className={cn(
        'tool-expanded relative overflow-hidden text-sm',
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 text-fg-2 outline-none motion-safe:data-[state=closed]:animate-out motion-safe:data-[state=open]:animate-in',
        className
      )}
      {...props}
    >
      {/* Parameters, the approval and the result: each a TOOL_SECTION. */}
      <div className="flex min-w-0 flex-col">{children}</div>
    </CollapsibleContent>
  )
)

ToolContent.displayName = 'ToolContent'
