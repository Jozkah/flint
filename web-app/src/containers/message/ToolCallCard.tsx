import { memo, useMemo, type ReactNode } from 'react'
import {
  Tool,
  ToolApprovalActions,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool'
import { ToolProgressRow } from '@/components/ai-elements/tool-runtime'
import { Chip } from '@/components/ui/chip'
import { ChangeDiff, diffStat } from '@/components/ChangeDiff'
import { useToolOrigin } from '@/hooks/useToolOrigin'
import { useToolCallRuntime } from '@/hooks/useToolCallRuntime'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
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
import { RagToolWidget } from './RagToolWidget'
import { WebToolWidget } from './WebToolWidget'
import { AgentToolWidget, TerminalWidget } from './AgentToolWidget'

const identityResolver = (input: string) => Promise.resolve(input)

export type ToolCallCardProps = {
  part: MessagePartLike
  messageId: string
  /** Citation count from earlier tool calls in this turn, for continuous numbering. */
  citationOffset?: number
  className?: string
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

const textOf = (output: unknown): string =>
  typeof output === 'string'
    ? output
    : typeof (output as { content?: unknown })?.content === 'string'
      ? (output as { content: string }).content
      : ''

/** "5 passed" from a test runner's summary line, when the output has one. */
const PASSED = /\b(\d+) passed\b/

/** One section of an open card, headed like the mockup's "Result"/"Error". */
const ResultSection = ({
  label,
  failed,
  children,
}: {
  label: string
  failed?: boolean
  children: ReactNode
}) => (
  <div
    data-slot="tool-result"
    className="flex min-w-0 flex-col gap-2 border-t border-dashed border-border px-2.5 py-2"
  >
    <h4
      data-failed={failed || undefined}
      className="flex min-h-6 items-center text-xs font-medium text-fg-2"
    >
      {label}
    </h4>
    {children}
  </div>
)

/** Five small squares, filled by the share of added against removed lines. */
const DiffBlocks = ({ add, del }: { add: number; del: number }) => {
  const total = add + del
  const green = total === 0 ? 0 : Math.round((add / total) * 5)
  return (
    <span aria-hidden className="inline-flex gap-0.5">
      {Array.from({ length: 5 }, (_, i) => (
        <i
          key={i}
          className={cn(
            'size-[7px] rounded-[2px]',
            total === 0 ? 'bg-border' : i < green ? 'bg-success' : 'bg-destructive'
          )}
        />
      ))}
    </span>
  )
}

export const ToolCallCard = memo(
  ({ part, messageId, citationOffset = 0, className }: ToolCallCardProps) => {
    const { t } = useTranslation()
    const toolName = part.type.split('-').slice(1).join('-')
    const origin = useToolOrigin(toolName)
    const diff = useToolCallRuntime((s) =>
      part.toolCallId ? s.diffs[part.toolCallId] : undefined
    )
    // Nothing has run yet while the call waits for an answer: the prompt is
    // the card's content, not an empty result.
    const awaitingApproval = useToolApprovalRequests((s) =>
      part.toolCallId ? Boolean(s.pending[part.toolCallId]) : false
    )

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

    const bash = useMemo(
      () =>
        bar?.variant === 'terminal' && part.output
          ? parseBashOutput(part.output)
          : undefined,
      [bar?.variant, part.output]
    )

    if (!isToolPart(part)) return null

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

    // A short outcome beside the argument, from the call's own result.
    let badge: ReactNode = null
    if (bash && done) {
      const passed = PASSED.exec(bash.text)?.[1]
      if (exitFailed) {
        badge = bash.signaled ? (
          <Chip tone="err" dot>
            {t('tools:toolCall.terminated')}
          </Chip>
        ) : (
          <Chip tone="warn" dot className="tabular-nums">
            {t('tools:toolCall.exitCode', { code: bash.exit })}
          </Chip>
        )
      } else if (passed) {
        badge = (
          <Chip tone="ok" dot className="tabular-nums">
            {t('tools:toolCall.testsPassed', { count: Number(passed) })}
          </Chip>
        )
      }
    } else if (
      done &&
      bar?.variant === 'workspace' &&
      (bar.tool === 'grep' || bar.tool === 'find')
    ) {
      const lines = textOf(part.output)
        .split('\n')
        .filter((l) => l.trim()).length
      if (lines > 0) {
        badge = (
          <span className="text-[11px] text-subtle-foreground tabular-nums">
            {t('tools:toolCall.matches', { count: lines })}
          </span>
        )
      }
    } else if (showDiff && diff) {
      const { add, del } = diffStat(diff)
      badge = (
        <>
          <span className="inline-flex gap-1.5 font-mono text-[11.5px] font-medium tabular-nums">
            <span className="text-success">+{add}</span>
            <span className="text-destructive">−{del}</span>
          </span>
          <DiffBlocks add={add} del={del} />
        </>
      )
    }

    const resultLabel = failed
      ? t('tools:toolCall.error')
      : t('tools:toolCall.result')

    const widget = !bar ? null : bar.variant === 'documents' ? (
      <ResultSection label={resultLabel} failed={failed}>
        <RagToolWidget
          embedded
          bar={bar}
          state={part.state}
          output={part.output}
          errorText={errorText}
          messageId={messageId}
          citationOffset={citationOffset}
        />
      </ResultSection>
    ) : bar.variant === 'terminal' ? (
      <ResultSection label={resultLabel} failed={failed}>
        <div className="overflow-hidden">
          <TerminalWidget
            embedded
            bar={bar}
            state={part.state}
            output={part.output}
            errorText={errorText}
          />
        </div>
      </ResultSection>
    ) : bar.variant === 'workspace' ? (
      showDiff && diff ? (
        // The change itself is the result: edge to edge, under a dashed rule.
        <ChangeDiff diff={diff} bleed />
      ) : (
        <ResultSection label={resultLabel} failed={failed}>
          <AgentToolWidget
            embedded
            bar={bar}
            state={part.state}
            output={part.output}
            errorText={errorText}
            toolCallId={part.toolCallId}
          />
        </ResultSection>
      )
    ) : (
      <ResultSection label={resultLabel} failed={failed}>
        <WebToolWidget
          embedded
          bar={bar}
          state={part.state}
          output={part.output}
          errorText={errorText}
        />
      </ResultSection>
    )

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
        autoOpen={running || failed || showDiff}
        className={className}
      >
        <ToolHeader
          title={title}
          type={`tool-${toolName}` as `tool-${string}`}
          state={part.state}
          origin={originLabel}
          arg={bar ? headerArg(bar) : undefined}
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
          {awaitingApproval
            ? null
            : bar
            ? widget
            : isError
              ? (
                  <ToolOutput
                    output={undefined}
                    errorText={errorText}
                    resolver={identityResolver}
                  />
                )
              : Boolean(part.output) && (
                  <ToolOutput
                    output={part.output}
                    errorText={undefined}
                    resolver={identityResolver}
                    citationOffset={citationOffset}
                  />
                )}
        </ToolContent>
      </Tool>
    )
  }
)

ToolCallCard.displayName = 'ToolCallCard'
