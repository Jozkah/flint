import { memo, useMemo } from 'react'
import {
  Tool,
  ToolApprovalActions,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool'
import { ToolProgressRow } from '@/components/ai-elements/tool-runtime'
import { useToolOrigin } from '@/hooks/useToolOrigin'
import { useToolCallRuntime } from '@/hooks/useToolCallRuntime'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { useConversationPane } from '@/hooks/conversationPaneContext'
import { approvalForCall } from '@/lib/toolApprovalScope'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { completedToolLabel } from '@/lib/agentActivity'
import {
  describeNativeToolCall,
  isToolRunning,
  parseBashOutput,
  type ToolCallBar,
} from '@/lib/toolPresentation'
import { cn } from '@/lib/utils'
import { isToolPart, type MessagePartLike } from './types'
import {
  countOutputImages,
  imagesOfOutput,
  outputTextWithoutImages,
} from '@/lib/toolOutputImages'
import { OpenablePath } from './OpenablePath'
import { BrowserOpenedCard } from './BrowserOpenedCard'
import { WidgetCard } from './WidgetCard'
import { SHOW_WIDGET_TOOL } from '@/lib/visualize/constants'
import { parseBrowserTarget } from '@/lib/browserOpen'
import { browserCardUrl, isBrowserTool } from '@/lib/browserAgent'
import { useBrowserShots } from '@/hooks/useBrowserShots'
import { failedCommandText, toolSentence } from '@/lib/traceSummary'
import {
  lineOfToolInput,
  toolChangesFile,
  toolTargetIsPath,
  useCodeOpenTools,
} from '@/lib/codeOpen'

import { ToolImages, ToolResult } from './toolCallCardParts'
import { toolBadge } from './toolBadge'

const identityResolver = (input: string) => Promise.resolve(input)

export type ToolCallCardProps = {
  part: MessagePartLike
  messageId: string
  /** Citation count from earlier tool calls in this turn, for continuous numbering. */
  citationOffset?: number
  className?: string
  /** true: open (Verbose view). false: start closed, even when failed
   * (Thinking view's failed rows). Unset: open while running, on failure or
   * with a diff. */
  expanded?: boolean
  /** A row of a folded run: one sentence in the header, closed until clicked. */
  sentence?: boolean
}

/** The one argument a native call is about, for the card's header. */
const headerArg = (bar: ToolCallBar): string => {
  switch (bar.variant) {
    case 'terminal':
      return bar.command || (bar.jobId ?? '')
    case 'search':
    case 'documents':
      return bar.query
    case 'address':
      return bar.url
    case 'workspace':
      // A pattern reads as one: quoted, like the mockup's `"jan-sandbox-helper"`.
      return (bar.tool === 'grep' || bar.tool === 'find') && bar.target
        ? `"${bar.target}"`
        : bar.target
  }
}

/** A step's line, its verb in the call kind's colour: Read blue, Searched purple. */
const SentenceText = ({ text, tint }: { text: string; tint: boolean }) => {
  const at = text.indexOf(' ')
  if (!tint || at < 0) return <>{text}</>
  return (
    <>
      <span className="font-medium text-(--tk)">{text.slice(0, at)}</span>
      {text.slice(at)}
    </>
  )
}

export const ToolCallCard = memo(
  ({
    part,
    messageId,
    citationOffset = 0,
    className,
    expanded,
    sentence,
  }: ToolCallCardProps) => {
    const { t } = useTranslation()
    const toolName = part.type.split('-').slice(1).join('-')
    const origin = useToolOrigin(toolName)
    const diff = useToolCallRuntime((s) =>
      part.toolCallId ? s.diffs[part.toolCallId] : undefined
    )
    // Nothing has run yet while the call waits for an answer: the prompt is
    // the card's content, not an empty result.
    const paneThreadId = useConversationPane()?.threadId
    const awaitingApproval = useToolApprovalRequests((s) =>
      Boolean(approvalForCall(s, part.toolCallId, paneThreadId))
    )
    // A request of this card's own (not a subagent's that shares its id)
    // turns the whole step into the action panel.
    const ownApproval = useToolApprovalRequests((s) => {
      const entry = approvalForCall(s, part.toolCallId, paneThreadId)
      return Boolean(entry && !entry.origin)
    })

    // A page shown to the user is a card of its own, not a tool step.
    const browserTarget =
      toolName === 'open_in_browser' && part.state === 'output-available'
        ? parseBrowserTarget(part.input)
        : null

    // Native families get a fixed label; MCP names its server.
    const originLabel =
      origin === undefined
        ? undefined
        : origin.kind === 'web-fetch' || origin.kind === 'web-search'
          ? t('tools:toolCall.originWeb')
          : origin.kind === 'rag'
            ? t('tools:toolCall.originDocuments')
            : origin.kind === 'agent'
              ? t('tools:toolCall.originWorkspace')
              : origin.detail

    // Native tools name what they acted on (a command, a path, a query) in the
    // header; their widget shows the result inside the card.
    const bar = describeNativeToolCall(origin, toolName, part.input)
    // Images the call returned for the model: on the part itself (Cowork), or
    // as image blocks in a chat result, whose card then shows only the text.
    const cardImages = useMemo(
      () => part.toolImages ?? imagesOfOutput(part.output),
      [part.toolImages, part.output]
    )
    const cardOutput = useMemo(
      () =>
        countOutputImages(part.output) > 0
          ? outputTextWithoutImages(part.output)
          : part.output,
      [part.output]
    )
    const shot = useBrowserShots((s) =>
      part.toolCallId ? s.shots[part.toolCallId] : undefined
    )
    const browserArg = isBrowserTool(toolName)
      ? browserCardUrl(toolName, part.input, cardOutput)
      : ''

    const bash = useMemo(
      () =>
        bar?.variant === 'terminal' && cardOutput
          ? parseBashOutput(cardOutput)
          : undefined,
      [bar?.variant, cardOutput]
    )

    const { displayPath } = useCodeOpenTools()
    /** The header's argument, a file path in its short form. */
    const shownArg = (bar: ToolCallBar): string =>
      bar.variant === 'workspace' && bar.target && toolTargetIsPath(bar.tool)
        ? (displayPath?.(bar.target) ?? bar.target)
        : headerArg(bar)

    if (!isToolPart(part)) return null

    // A widget is the answer's content, not a step: it gets a card of its own.
    if (toolName === SHOW_WIDGET_TOOL) {
      return (
        <WidgetCard part={part} messageId={messageId} className={className} />
      )
    }

    const isError = part.state === 'output-error'
    const running = isToolRunning(part.state)
    const done = part.state === 'output-available'
    const errorText = isError
      ? part.error || part.errorText || t('tools:toolCall.executionFailed')
      : undefined
    // A command that exited non-zero failed, even though the call completed.
    const exitFailed =
      done && Boolean(bash && ((bash.exit ?? 0) !== 0 || bash.signaled))
    const failed = isError || exitFailed
    // It ran and exited non-zero: a failed check (amber), not a crash, a
    // refusal or a timeout (red).
    const checkFailed = exitFailed && !bash?.signaled
    const hardFailed = exitFailed && !checkFailed
    const showDiff = Boolean(diff) && !running && !isError

    // `skill_read` reads as a bare tool name otherwise; the label names the
    // skill actually being loaded, which is the only interesting part of it.
    const title =
      toolName === 'skill_read'
        ? completedToolLabel(toolName, part.input, part.state)
        : toolName

    const badge = toolBadge({
      bash: done ? bash : undefined,
      exitFailed,
      bar: done ? bar : undefined,
      output: cardOutput,
      diff: showDiff ? diff : undefined,
      t,
    })

    if (browserTarget) {
      return (
        <div className={className}>
          <BrowserOpenedCard target={browserTarget} />
        </div>
      )
    }

    // Waiting for the user: one expanded action panel, with no tool card
    // around it. It says what the call would do in full; the parameters table
    // and the empty result would only repeat it.
    if (ownApproval) {
      return (
        <Tool
          state={part.state}
          toolCallId={part.toolCallId}
          messageId={messageId}
          name={toolName}
          origin={originLabel}
          open
          data-approval-panel=""
          className={cn('tool-action-panel', className)}
        >
          <ToolApprovalActions />
        </Tool>
      )
    }

    return (
      <Tool
        state={part.state}
        toolCallId={part.toolCallId}
        messageId={messageId}
        name={toolName}
        origin={originLabel}
        failed={hardFailed}
        checkFailed={checkFailed}
        // Open while it runs, so the live result is in view, and for what is
        // worth reading afterwards: a failure or a change.
        autoOpen={expanded ?? (running || failed || showDiff)}
        className={className}
      >
        <ToolHeader
          title={title}
          type={`tool-${toolName}` as `tool-${string}`}
          state={part.state}
          origin={originLabel}
          sentence={
            sentence ? (
              <>
                {failed && (
                  <span className="mr-1 font-medium text-destructive">
                    {t(
                      toolName === 'bash'
                        ? 'chat:transcriptView.failedToRun'
                        : 'chat:transcriptView.failed'
                    )}
                  </span>
                )}
                <SentenceText
                  text={
                    failed && toolName === 'bash'
                      ? failedCommandText(part)
                      : toolSentence(part)
                  }
                  tint={!failed}
                />
              </>
            ) : undefined
          }
          arg={
            // The page the assistant's browser is on, from its own result.
            browserArg || (bar ? shownArg(bar) : undefined)
          }
          argNode={
            // A finished call's path opens in the Code panel from the header,
            // at the line it read when it names one.
            bar?.variant === 'workspace' &&
            !running &&
            bar.target &&
            toolTargetIsPath(bar.tool) ? (
              <OpenablePath
                path={bar.target}
                line={lineOfToolInput(part.input)}
                diffable={toolChangesFile(bar.tool) && done}
              />
            ) : undefined
          }
          input={bar ? undefined : part.input}
          badge={badge}
          failed={hardFailed}
        />
        <ToolProgressRow
          toolCallId={part.toolCallId}
          className="mt-0 px-2.5 pb-2"
        />
        <ToolContent title={title}>
          {/* A diff already says what the edit's arguments would. */}
          {Boolean(part.input) && !showDiff && <ToolInput input={part.input} />}
          <ToolApprovalActions />
          {shot && (
            // The picture the assistant took of the browser pane. Display
            // only: the model is told where it was saved, not given pixels.
            <img
              data-testid="browser-shot"
              alt={t('browser-agent:card.screenshot')}
              src={`data:image/png;base64,${shot}`}
              className="max-h-72 w-full rounded-md border border-border bg-muted object-contain"
            />
          )}
          <ToolImages images={cardImages} />
          {awaitingApproval ? null : bar ? (
            <ToolResult
              bar={bar}
              part={part}
              output={cardOutput}
              errorText={errorText}
              failed={failed}
              diff={showDiff ? diff : undefined}
              messageId={messageId}
              citationOffset={citationOffset}
            />
          ) : isError ? (
            <ToolOutput
              output={undefined}
              errorText={errorText}
              resolver={identityResolver}
            />
          ) : (
            Boolean(cardOutput) && (
              <ToolOutput
                output={cardOutput as typeof part.output}
                errorText={undefined}
                resolver={identityResolver}
                citationOffset={citationOffset}
              />
            )
          )}
        </ToolContent>
      </Tool>
    )
  }
)

ToolCallCard.displayName = 'ToolCallCard'
