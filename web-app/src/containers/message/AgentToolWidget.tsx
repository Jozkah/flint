import { memo, useMemo } from 'react'
import type { ToolUIPart } from 'ai'
import {
  BookOpen,
  File as FileIcon,
  FilePen,
  Folder,
  Lock,
  NotebookText,
  Search,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  isToolRunning,
  parseBashOutput,
  type ToolCallBar,
} from '@/lib/toolPresentation'
import { cn } from '@/lib/utils'
import { useToolCallRuntime } from '@/hooks/useToolCallRuntime'
import { Caret, ToolBar } from './ToolBar'
import { useCodeOpen, toolTargetIsPath } from '@/lib/codeOpen'
import { ChangeDiff } from '@/components/ChangeDiff'
import { TermOutput } from '@/components/TermOutput'

const asText = (output: unknown): string =>
  typeof output === 'string'
    ? output
    : typeof (output as { content?: unknown })?.content === 'string'
      ? (output as { content: string }).content
      : ''

const OutputBlock = ({ children }: { children: React.ReactNode }) => (
  <pre className="m-0 max-h-56 overflow-auto whitespace-pre-wrap wrap-break-word rounded-lg bg-code-bg px-2.5 py-2 font-mono text-xs leading-normal text-fg-2 shadow-[inset_0_0_0_0.8px_var(--border)]">
    {children}
  </pre>
)

/**
 * A `write`/`edit` diff. Kept out of the model-facing tool output on purpose (it
 * would just repeat the file), so it arrives through the runtime store instead.
 * The same component shows the change in its approval prompt.
 */
const DiffBlock = ChangeDiff

export type TerminalWidgetProps = {
  bar: Extract<ToolCallBar, { variant: 'terminal' }>
  state: ToolUIPart['state']
  output?: ToolUIPart['output']
  errorText?: string
  /**
   * Inside a tool card, whose header already carries the exit status: the
   * terminal shows just the prompt line and the scrollback.
   */
  embedded?: boolean
}

/**
 * `bash` rendered as a terminal: the command streams in after a prompt, then its
 * output fills the scrollback below. The trailing `[exit N]` marker becomes a
 * status chip rather than staying in the text.
 *
 * The command streams; the output does not. `execute_tool` is one round trip, so
 * stdout arrives whole when the run finishes. Incremental output would need the
 * Rust side to emit events per chunk.
 */
export const TerminalWidget = memo(
  ({ bar, state, output, errorText, embedded = false }: TerminalWidgetProps) => {
    const { t } = useTranslation()
    const running = isToolRunning(state)
    const result = useMemo(
      () => (output ? parseBashOutput(output) : undefined),
      [output]
    )
    // A non-zero exit is reported in-band, so the body is the failure detail and
    // the chip is the failure signal; there is no separate error banner to show.
    const failed = errorText !== undefined || (result?.exit ?? 0) !== 0
    const body = result?.text || (errorText ? asText(errorText) : '')

    return (
      // The terminal is always dark, in either theme: it reads as a terminal,
      // and command output is written for one.
      <div
        className="term overflow-hidden bg-term-bg font-mono text-xs leading-[1.6] text-term-fg"
        data-testid="tool-activity-item"
        data-tool-state={state}
      >
        <div className="flex items-start gap-2 px-3 pt-2.5">
          {!embedded && (
            <SquareTerminal
              aria-label={t('tools:toolCall.terminal')}
              className="mt-0.5 size-3.5 shrink-0 text-term-fg/60"
            />
          )}
          <span className="term-pr shrink-0 select-none">$</span>
          <span className="term-w min-w-0 flex-1 whitespace-pre-wrap wrap-break-word">
            {bar.jobId && !bar.command
              ? t('tools:toolCall.pollingJob', { id: bar.jobId })
              : bar.command}
            {running && <Caret />}
          </span>
          {!embedded && result?.exit !== undefined && (
            <span
              className={cn(
                'shrink-0 rounded-[5px] px-1.5 py-px text-[11px] tabular-nums',
                failed
                  ? 'bg-[#f85149]/15 text-[#f85149]'
                  : 'bg-[#3fb950]/15 text-[#3fb950]'
              )}
            >
              {t('tools:toolCall.exitCode', { code: result.exit })}
            </span>
          )}
          {result?.signaled && (
            <span className="shrink-0 rounded-[5px] bg-[#f85149]/15 px-1.5 py-px text-[11px] text-[#f85149]">
              {t('tools:toolCall.terminated')}
            </span>
          )}
        </div>
        <div className="px-3 pb-2.5">
          {running && (
            <div className="mt-1 [--color-muted-foreground:var(--term-fg)]">
              {/* The command is already on screen above, so the tool-named
                  `running` string would just repeat it. */}
              <Shimmer duration={1}>{t('tools:toolCall.working')}</Shimmer>
            </div>
          )}
          {!running && body && (
            <pre className="m-0 max-h-72 overflow-auto whitespace-pre-wrap wrap-break-word">
              <TermOutput text={body} />
            </pre>
          )}
          {result?.truncated && (
            <p className="term-d mt-1">
              {t('tools:toolCall.outputTruncated')}
            </p>
          )}
          {/* Surfaced rather than dropped: when the sandbox is what failed the
              command, the limits are the actual explanation for the exit code. */}
          {result?.sandboxNote && (
            <p className="term-y mt-1 flex items-start gap-1.5">
              <Lock className="mt-0.5 size-3.5 shrink-0" />
              <span>{result.sandboxNote}</span>
            </p>
          )}
        </div>
      </div>
    )
  }
)

TerminalWidget.displayName = 'TerminalWidget'

const TOOL_ICONS: Record<string, LucideIcon> = {
  read: FileIcon,
  ls: Folder,
  find: Search,
  grep: Search,
  write: FilePen,
  edit: FilePen,
  memory_list: NotebookText,
  memory_read: NotebookText,
  memory_write: NotebookText,
  skill_list: BookOpen,
  skill_read: BookOpen,
  skill_write: BookOpen,
}

/** Tools whose whole call is the verb: there is no argument worth a bar. */
const LISTING_TOOLS = new Set(['memory_list', 'skill_list', 'ls'])

export type AgentToolWidgetProps = {
  bar: Extract<ToolCallBar, { variant: 'workspace' }>
  state: ToolUIPart['state']
  output?: ToolUIPart['output']
  errorText?: string
  /** Needed to look up this call's display-only diff. */
  toolCallId?: string
  /**
   * Inside a tool card whose header names the path: the bar is left out,
   * unless it is the way to open the file in the code panel.
   */
  embedded?: boolean
}

/**
 * The workspace tools rendered as the thing they act on -- a path, a glob, a
 * memory name -- followed by the result, mirroring how the web tools present a
 * query or a URL.
 */
export const AgentToolWidget = memo(
  ({
    bar,
    state,
    output,
    errorText,
    toolCallId,
    embedded = false,
  }: AgentToolWidgetProps) => {
    const { t } = useTranslation()
    const running = isToolRunning(state)
    const diff = useToolCallRuntime((s) =>
      toolCallId ? s.diffs[toolCallId] : undefined
    )
    const Icon = TOOL_ICONS[bar.tool] ?? FileIcon
    const body = asText(output)
    // `ls` with no path lists the workspace root; show that rather than a bar
    // that reads as though an argument failed to stream.
    const value =
      bar.target || (LISTING_TOOLS.has(bar.tool) ? t('tools:toolCall.workspaceRoot') : '')
    // The path the tool was called with is structured data, so opening it in
    // the code panel needs no parsing of the model's prose. Only once the call
    // has finished streaming: a half-written path opens the wrong file.
    const openCode = useCodeOpen()
    const openable =
      openCode && !running && bar.target && toolTargetIsPath(bar.tool)
        ? () => openCode(bar.target)
        : undefined

    return (
      <div
        className={embedded ? 'space-y-2' : 'space-y-2 px-2.5 py-2'}
        data-testid="tool-activity-item"
        data-tool-state={state}
      >
        {(!embedded || openable) && (
        <ToolBar
          icon={<Icon size={16} />}
          value={value}
          placeholder={t('tools:toolCall.pathPlaceholder')}
          typing={running}
          mono
          onActivate={openable}
          activateLabel={t('common:codePanel.openInCode')}
          trailing={
            bar.detail ? (
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {bar.detail}
              </span>
            ) : undefined
          }
        />
        )}

        {errorText && (
          <div className="rounded-lg border-[0.8px] border-destructive/30 bg-destructive-tint px-2.5 py-2 font-mono text-xs text-destructive">
            {errorText}
          </div>
        )}

        {running && !errorText && (
          <div className="px-2 text-sm">
            <Shimmer duration={1}>{t('tools:toolCall.reading')}</Shimmer>
          </div>
        )}

        {!running &&
          !errorText &&
          // A diff supersedes the body: `Applied 2 edit(s) to a.txt` says less
          // than the change itself.
          (diff ? (
            // Full-bleed inside the card, like the mockup's edit cards.
            <DiffBlock diff={diff} bleed className="-mx-2.5 -mb-2" />
          ) : body ? (
            <OutputBlock>{body}</OutputBlock>
          ) : (
            <p className="px-2 text-sm text-muted-foreground">
              {t('tools:toolCall.noResults')}
            </p>
          ))}
      </div>
    )
  }
)

AgentToolWidget.displayName = 'AgentToolWidget'
