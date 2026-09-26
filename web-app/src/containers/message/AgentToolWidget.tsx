import { memo, useMemo, useState } from 'react'
import type { ToolUIPart } from 'ai'
import {
  BookOpen,
  ChevronRight,
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
  grepHighlightRegex,
  isToolRunning,
  parseBashOutput,
  parseGrepOutput,
  splitGrepMatches,
  type GrepGroup,
  type ToolCallBar,
} from '@/lib/toolPresentation'
import { cn } from '@/lib/utils'
import { useToolCallRuntime } from '@/hooks/useToolCallRuntime'
import { Caret, ToolBar } from './ToolBar'
import { useCodeOpen, toolTargetIsPath } from '@/lib/codeOpen'
import { ChangeDiff } from '@/components/ChangeDiff'
import { TermOutput } from '@/components/TermOutput'
import { parseAnsi, stripAnsi, type AnsiStyle } from '@/lib/ansi'

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
  /** Looks up the call's live (streamed, colour-preserving) output. */
  toolCallId?: string
  /**
   * Looks up the sandboxed first attempt of a call that was then run again
   * outside the sandbox. Separate from `toolCallId`, which also turns on the
   * live output.
   */
  attemptCallId?: string
}

const segmentStyle = (s: AnsiStyle): React.CSSProperties | undefined => {
  const fg = s.inverse ? (s.bg ?? 'var(--card)') : s.fg
  const bg = s.inverse ? (s.fg ?? 'var(--foreground)') : s.bg
  if (!fg && !bg && !s.bold && !s.dim && !s.italic && !s.underline) {
    return undefined
  }
  return {
    color: fg,
    backgroundColor: bg,
    fontWeight: s.bold ? 600 : undefined,
    opacity: s.dim ? 0.7 : undefined,
    fontStyle: s.italic ? 'italic' : undefined,
    textDecoration: s.underline ? 'underline' : undefined,
  }
}

/** Command output with its ANSI colours rendered; other escapes are dropped. */
export const AnsiText = memo(({ text }: { text: string }) => {
  const segments = useMemo(() => parseAnsi(text), [text])
  return (
    <>
      {segments.map((seg, i) => {
        const style = segmentStyle(seg.style)
        return style ? (
          <span key={i} style={style}>
            {seg.text}
          </span>
        ) : (
          seg.text
        )
      })}
    </>
  )
})
AnsiText.displayName = 'AnsiText'

/**
 * `bash` rendered as a terminal: the command streams in after a prompt, then its
 * output fills the scrollback below. The trailing `[exit N]` marker becomes a
 * status chip rather than staying in the text.
 *
 * Output streams too when the call was run with a live-output sink: chunks land
 * in the runtime store raw, so colours render. The model-facing result has its
 * escapes stripped by the backend; a failed command is shown plain, since the
 * failure text is what matters there.
 */
export const TerminalWidget = memo(
  ({
    bar,
    state,
    output,
    errorText,
    toolCallId,
    attemptCallId,
    embedded = false,
  }: TerminalWidgetProps) => {
    const { t } = useTranslation()
    const running = isToolRunning(state)
    const live = useToolCallRuntime((s) =>
      toolCallId ? s.output[toolCallId] : undefined
    )
    const firstAttempt = useToolCallRuntime((s) => {
      const id = attemptCallId ?? toolCallId
      return id ? s.firstAttempts[id] : undefined
    })
    const result = useMemo(
      () => (output ? parseBashOutput(output) : undefined),
      [output]
    )
    // A failed rerun arrives as the error, still led by the model's note.
    const errorResult = useMemo(
      () => (errorText ? parseBashOutput(asText(errorText)) : undefined),
      [errorText]
    )
    const firstAttemptText = useMemo(
      () =>
        firstAttempt
          ? stripAnsi(parseBashOutput(firstAttempt.output).text)
          : undefined,
      [firstAttempt]
    )
    const ranUnsandboxed =
      !!result?.ranUnsandboxed || !!errorResult?.ranUnsandboxed
    // A non-zero exit is reported in-band, so the body is the failure detail and
    // the chip is the failure signal; there is no separate error banner to show.
    const failed = errorText !== undefined || (result?.exit ?? 0) !== 0
    const finalText = result?.text || (errorResult?.text ?? '')
    // The streamed text keeps colours, but is only complete for a finished call
    // that was not truncated; otherwise the result is the full account.
    const coloured =
      !failed && live && !result?.truncated && live.trim() ? live : undefined
    const body = failed ? stripAnsi(finalText) : finalText

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
              role="img"
              aria-label={t('tools:toolCall.exitCode', { code: result.exit })}
              title={t('tools:toolCall.exitCode', { code: result.exit })}
              data-testid="terminal-status-dot"
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
          {!running && ranUnsandboxed && (
            <span
              data-testid="terminal-ran-unsandboxed"
              className="shrink-0 rounded-[5px] bg-[#d29922]/15 px-1.5 py-px text-[11px] text-[#d29922]"
            >
              {t('tools:toolCall.ranUnsandboxed')}
            </span>
          )}
          {result?.signaled && (
            <span className="shrink-0 rounded-[5px] bg-[#f85149]/15 px-1.5 py-px text-[11px] text-[#f85149]">
              {t('tools:toolCall.terminated')}
            </span>
          )}
        </div>
        <div className="px-3 pb-2.5">
          {running && live && (
            <pre
              className="m-0 max-h-72 overflow-auto whitespace-pre-wrap wrap-break-word"
              data-testid="terminal-live-output"
            >
              <TermOutput text={live} />
            </pre>
          )}
          {running && (
            <div className="mt-1 [--color-muted-foreground:var(--term-fg)]">
              {/* The command is already on screen above, so the tool-named
                  `running` string would just repeat it. */}
              <Shimmer duration={1}>{t('tools:toolCall.working')}</Shimmer>
            </div>
          )}
          {!running && (coloured || body) && (
            <pre className="m-0 max-h-72 overflow-auto whitespace-pre-wrap wrap-break-word">
              <TermOutput text={coloured ?? body} />
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
          {/* The sandboxed run the rerun replaced: kept for the record, out of
              the way of the result that counts. */}
          {!running && firstAttempt && (
            <details className="mt-2" data-testid="terminal-first-attempt">
              <summary className="term-d cursor-pointer select-none">
                {t('tools:toolCall.firstAttempt')}
              </summary>
              <pre className="m-0 mt-1 max-h-56 overflow-auto whitespace-pre-wrap wrap-break-word opacity-80">
                <TermOutput text={firstAttemptText ?? ''} />
              </pre>
            </details>
          )}
        </div>
      </div>
    )
  }
)

TerminalWidget.displayName = 'TerminalWidget'

const HighlightedLine = ({ text, re }: { text: string; re?: RegExp }) => {
  const parts = useMemo(() => splitGrepMatches(text, re), [text, re])
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark
            key={i}
            className="rounded-sm bg-warning-tint px-px text-foreground"
            data-testid="grep-match"
          >
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </>
  )
}

const GrepFileGroup = ({ group, re }: { group: GrepGroup; re?: RegExp }) => {
  const [open, setOpen] = useState(true)
  const hits = group.lines.filter((l) => l.match).length
  return (
    <div data-testid="grep-file-group">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1 py-0.5 text-left text-foreground hover:text-foreground/80"
      >
        <ChevronRight
          className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')}
        />
        <span className="min-w-0 flex-1 truncate">{group.file}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{hits}</span>
      </button>
      {open && (
        <div className="pl-4">
          {group.lines.map((l, i) => (
            <div key={`${l.line}-${i}`}>
              {group.gaps.includes(i) && (
                <div className="select-none text-muted-foreground/50">⋯</div>
              )}
              <div className="flex gap-2">
                <span className="w-8 shrink-0 select-none text-right tabular-nums text-muted-foreground/60">
                  {l.line}
                </span>
                <span
                  className={cn(
                    'min-w-0 flex-1 whitespace-pre-wrap wrap-break-word',
                    l.match ? 'text-muted-foreground' : 'text-muted-foreground/60'
                  )}
                >
                  {l.match ? <HighlightedLine text={l.text} re={re} /> : l.text}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** `grep` results grouped per file, collapsible, with the matches highlighted. */
export const GrepResults = memo(
  ({ groups, notes, re }: { groups: GrepGroup[]; notes: string[]; re?: RegExp }) => (
    <div
      className="mt-1.5 max-h-80 space-y-1 overflow-auto rounded-md border border-border bg-muted px-2 py-1.5 font-mono text-xs"
      data-testid="grep-results"
    >
      {groups.map((g, i) => (
        <GrepFileGroup key={`${g.file}-${i}`} group={g} re={re} />
      ))}
      {notes.map((n, i) => (
        <p key={i} className="text-muted-foreground">
          {n}
        </p>
      ))}
    </div>
  )
)
GrepResults.displayName = 'GrepResults'

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
    const grep = useMemo(
      () => (bar.tool === 'grep' && body ? parseGrepOutput(body) : undefined),
      [bar.tool, body]
    )
    const highlight = useMemo(
      () =>
        grep && bar.grep ? grepHighlightRegex(bar.target, bar.grep) : undefined,
      [grep, bar.target, bar.grep]
    )
    // `ls` with no path lists the workspace root; show that rather than a bar
    // that reads as though an argument failed to stream.
    const value =
      bar.target ||
      (LISTING_TOOLS.has(bar.tool) ? t('tools:toolCall.workspaceRoot') : '')
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
              // The detail is often an absolute search root (a managed
              // worktree path runs past 100 characters), so it must shrink
              // and truncate rather than push the transcript sideways.
              <span
                data-testid="tool-bar-detail"
                title={bar.detail}
                className="min-w-0 max-w-[45%] truncate font-mono text-xs text-muted-foreground"
              >
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
          ) : grep ? (
            <GrepResults groups={grep.groups} notes={grep.notes} re={highlight} />
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
