/* eslint-disable react-refresh/only-export-components */
import { useControllableState } from '@radix-ui/react-use-controllable-state'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import type { ToolUIPart } from 'ai'
import {
  ChevronDownIcon,
  FileDiffIcon,
  FileTextIcon,
  GlobeIcon,
  ListTodoIcon,
  Loader2Icon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
} from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import {
  createContext,
  Fragment,
  isValidElement,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { CodeBlock } from './code-block'
import { CopyButton } from '@/containers/CopyButton'
import {
  isPlainObject,
  parseToolInput,
  stringifyToolInput,
  summarizeToolInput,
} from '@/lib/toolInputSummary'
import { summarizeToolOutput } from '@/lib/toolOutputSummary'
import {
  useToolApprovalRequests,
  usePendingApprovalCount,
} from '@/hooks/useToolApprovalRequests'
import { useArmedAfterChange } from '@/hooks/useArmedAfterChange'
import { describePermissionRequest } from '@/lib/permissionRequest'
import { classifyPermissionOutcome } from '@/lib/permissionOutcome'
import {
  PermissionRequestDetails,
  PermissionScopeChoices,
  formatPermissionMessage,
} from '@/containers/PermissionRequestDetails'
import { useToolCallRuntime } from '@/hooks/useToolCallRuntime'
import { ToolElapsed } from './tool-runtime'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { ShieldAlertIcon } from 'lucide-react'
import { Citations } from '@/components/Citations'
import { parseCitationsFromToolOutput } from '@/lib/citation-parser'
import { toolKind } from '@/lib/toolKind'
import { Chip } from '@/components/ui/chip'
import { ChangeDiff } from '@/components/ChangeDiff'
import type { WorkState } from '@/containers/StatusChip'

/** One section of an open tool card, under a dashed rule. */
const TOOL_SECTION =
  'min-w-0 border-t border-dashed border-border px-2.5 py-2'

/** The mockup's small "Table | Raw" switch: two options on a muted track. */
const MINI_TRACK = 'inline-flex rounded-md bg-accent p-0.5'
const miniOption = (on: boolean) =>
  cn(
    'rounded px-[7px] py-0.5 text-[11px] leading-4 transition-colors outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:min-h-11',
    on
      ? 'bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,.08)]'
      : 'text-muted-foreground hover:text-foreground'
  )

/** Payloads shorter than this fit the collapsed box, so no expand control. */
const OUTPUT_EXPAND_THRESHOLD = 600

type ToolContextValue = {
  isOpen: boolean
  setIsOpen: (open: boolean) => void
  state: ToolUIPart['state']
  toolCallId?: string
  messageId?: string
}

const ToolContext = createContext<ToolContextValue | null>(null)

export const useTool = () => {
  const context = useContext(ToolContext)
  if (!context) {
    throw new Error('Tool components must be used within Tool')
  }
  return context
}

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
    autoOpen,
    open,
    defaultOpen = false,
    onOpenChange,
    children,
    ...props
  }: ToolProps) => {
    const isPending = useToolApprovalRequests((s) =>
      toolCallId ? Boolean(s.pending[toolCallId]) : false
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
  /** A short outcome beside the argument: an exit code, a match count, +/-. */
  badge?: ReactNode
  /** The call failed in-band (see `Tool`). */
  failed?: boolean
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
    badge,
    failed = false,
  }: ToolHeaderProps) => {
    const { t } = useTranslation()
    const { isOpen, toolCallId } = useTool()
    const awaitingApproval = useToolApprovalRequests((s) =>
      toolCallId ? Boolean(s.pending[toolCallId]) : false
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
      toolCallId ? s.timings[toolCallId]?.startedAt : undefined
    )
    const endedAt = useToolCallRuntime((s) =>
      toolCallId ? s.timings[toolCallId]?.endedAt : undefined
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
          className="grid size-[22px] shrink-0 place-items-center rounded-md bg-[color-mix(in_oklab,var(--tk)_14%,transparent)] text-(--tk) [&_svg]:size-[13px]"
        >
          <ToolKindIcon
            name={toolName}
            awaitingApproval={awaitingApproval}
            running={workState === 'running'}
          />
        </span>
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
          <span className="hidden shrink-0 rounded-[5px] bg-[color-mix(in_oklab,var(--tk)_10%,transparent)] px-1.5 py-px text-[10.5px] text-[color-mix(in_oklab,var(--tk)_80%,var(--foreground))] sm:inline">
            {origin}
          </span>
        )}
        {summary ? (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {summary}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {badge && (
          <span className="hidden shrink-0 items-center gap-2 sm:inline-flex">
            {badge}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[11.5px] text-muted-foreground">
          {queuePosition > 0 && (
            <span>
              {t('tools:toolCall.queuedPosition', { count: queuePosition })}
            </span>
          )}
          <ToolElapsed
            startedAt={startedAt}
            endedAt={endedAt}
            className="font-mono text-[11px] font-medium text-muted-foreground"
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

/** The card's icon: its kind, or a shield while it waits for the user. */
const ToolKindIcon = ({
  name,
  awaitingApproval,
  running,
}: {
  name: string
  awaitingApproval: boolean
  running: boolean
}) => {
  if (awaitingApproval) return <ShieldAlertIcon />
  if (running) return <Loader2Icon className="motion-safe:animate-spin" />
  switch (toolKind({ name })) {
    case 'web':
      return name === 'web_fetch' ? <GlobeIcon /> : <SearchIcon />
    case 'search':
      return <SearchIcon />
    case 'bash':
      return <TerminalIcon />
    case 'edit':
      return <FileDiffIcon />
    case 'read':
      return <FileTextIcon />
    case 'todo':
      return <ListTodoIcon />
    default:
      return <WrenchIcon />
  }
}

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>

export const ToolContent = memo(
  ({ className, children, ...props }: ToolContentProps) => (
    <CollapsibleContent
      className={cn(
        'relative overflow-hidden text-sm',
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

export type ToolInputProps = ComponentProps<'div'> & {
  input: ToolUIPart['input']
}

/** Table cells keep nested values readable rather than collapsing them. */
const formatParamValue = (value: unknown): string =>
  typeof value === 'string' ? value : stringifyToolInput(value)

export const ToolInput = memo(
  ({ className, input, ...props }: ToolInputProps) => {
    const { t } = useTranslation()
    const [showRaw, setShowRaw] = useState(false)

    const parsed = useMemo(() => parseToolInput(input), [input])
    const formatted = useMemo(() => stringifyToolInput(parsed), [parsed])
    const rows = useMemo(
      () => (isPlainObject(parsed) ? Object.entries(parsed) : []),
      [parsed]
    )
    const asTable = rows.length > 0 && !showRaw

    return (
      <div className={cn(TOOL_SECTION, 'space-y-2', className)} {...props}>
        <div className="flex min-h-6 items-center gap-2">
          <h4 className="flex-1 text-xs font-medium text-fg-2">
            {t('tools:toolCall.parameters')}
          </h4>
          {rows.length > 0 && (
            <span className={MINI_TRACK}>
              <button
                type="button"
                aria-pressed={!showRaw}
                className={miniOption(!showRaw)}
                onClick={() => setShowRaw(false)}
              >
                {t('tools:toolCall.viewTable')}
              </button>
              <button
                type="button"
                aria-pressed={showRaw}
                className={miniOption(showRaw)}
                onClick={() => setShowRaw(true)}
              >
                {t('tools:toolCall.viewRaw')}
              </button>
            </span>
          )}
          <CopyButton text={formatted} />
        </div>
        {asTable ? (
          <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] items-baseline gap-x-3.5 gap-y-1.5 text-xs">
            {rows.map(([key, value]) => (
              <Fragment key={key}>
                <dt className="max-w-32 truncate text-muted-foreground">
                  {key}
                </dt>
                <dd className="min-w-0 max-h-24 overflow-auto">
                  <code className="block rounded-[5px] bg-accent px-[5px] py-px font-mono text-xs whitespace-pre-wrap break-all text-foreground">
                    {formatParamValue(value)}
                  </code>
                </dd>
              </Fragment>
            ))}
          </dl>
        ) : (
          <div className="max-h-40 overflow-auto rounded-lg bg-code-bg shadow-[inset_0_0_0_0.8px_var(--border)]">
            <CodeBlock code={formatted} language="json" />
          </div>
        )}
      </div>
    )
  }
)

export const ToolApprovalActions = memo(() => {
  const { t } = useTranslation()
  const { toolCallId } = useTool()
  const pending = useToolApprovalRequests((s) =>
    toolCallId ? s.pending[toolCallId] : undefined
  )
  const resolveApproval = useToolApprovalRequests((s) => s.resolveApproval)
  // When this request is answered, the next one under the same call id takes
  // its place under the same buttons. They pause first, so a double-click or a
  // repeated key cannot answer a request that was never read.
  const armed = useArmedAfterChange(pending?.requestId)
  const threadPendingCount = usePendingApprovalCount(pending?.threadId)
  // One announcement per thread, from its oldest waiting card, so several
  // pending cards do not all speak at once.
  const isFirstInThread = useToolApprovalRequests((s) =>
    pending
      ? Object.values(s.pending).find((e) => e.threadId === pending.threadId)
          ?.toolCallId === toolCallId
      : false
  )
  const request = useMemo(
    () =>
      pending
        ? describePermissionRequest({
            toolName: pending.toolName,
            input: pending.input,
            serverName: pending.serverName,
            workspaceLabel: pending.workspaceLabel,
            taskContext: pending.taskContext,
            threadIsEphemeral: pending.threadIsEphemeral,
          })
        : undefined,
    [pending]
  )

  // A subagent's request is not this card's: its call id is only unique inside
  // the child's own conversation, so it can coincide with a card here and would
  // be answered from the wrong place. It is shown on its own (see
  // `CoworkChildApprovals`).
  if (!pending || !toolCallId || pending.origin || !request) return null

  return (
    // A separate object that needs an answer: a warm band inside the card, the
    // action in plain words first, then what it touches, then the answers
    // with Deny focused first.
    <div
      data-testid="inline-approval-card"
      className="relative flex min-w-0 flex-col gap-2.5 border-t border-dashed border-border bg-[color-mix(in_oklab,var(--warning)_6%,transparent)] p-3 text-foreground"
    >
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <ShieldAlertIcon className="size-4 shrink-0 text-warning" aria-hidden />
        <b className="min-w-0 font-medium text-foreground wrap-break-word">
          {formatPermissionMessage(t, request.action)}
        </b>
        {isFirstInThread && threadPendingCount > 0 && (
          <Chip tone="warn" className="tabular-nums" aria-hidden>
            {threadPendingCount === 1
              ? t('permissions:pending.one')
              : t('permissions:pending.many', { count: threadPendingCount })}
          </Chip>
        )}
      </div>
      {isFirstInThread && (
        <p role="status" aria-live="polite" className="sr-only">
          {threadPendingCount === 1
            ? t('permissions:pending.one')
            : t('permissions:pending.many', { count: threadPendingCount })}
        </p>
      )}
      {/* What will land, before it is allowed (AH-146). */}
      {pending.preview && (
        <ChangeDiff
          diff={pending.preview}
          label={t('tools:toolApproval.proposedChange')}
          testId="approval-preview"
        />
      )}
      {/* The parameters are already shown above this card. */}
      <PermissionRequestDetails
        request={request}
        showAction={false}
        showTechnicalDetails={false}
        layout="rows"
      />
      {/* Answers name this request, so a click cannot land on the next one. */}
      <PermissionScopeChoices
        request={request}
        autoFocusDeny
        disabled={!armed}
        onDecision={(decision) =>
          resolveApproval(toolCallId, decision, pending.requestId)
        }
      />
    </div>
  )
})

type ToolImageProps = {
  data: string
  index: number
  resolver: (input: string) => Promise<string>
}

const ToolImage = memo(({ data, index }: ToolImageProps) => {
  // Prepare the URL - convert base64 to data URL if needed
  const [preparedUrl, setPreparedUrl] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (data.startsWith('data:image') || data.startsWith('http')) {
      // Already a data URL or HTTP URL
      setPreparedUrl(data)
    } else {
      // Assume it's base64 encoded
      setPreparedUrl(`data:image/png;base64,${data}`)
    }
  }, [data])

  const isLoading = !preparedUrl

  if (isLoading) {
    return (
      <div className="flex justify-center">
        <div className="flex size-24 items-center justify-center rounded-md bg-muted">
          <div className="size-4 motion-safe:animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
        </div>
      </div>
    )
  }

  if (!preparedUrl) {
    return null
  }

  return (
    <div key={index} className="inline-block">
      <img
        src={preparedUrl}
        alt="Tool output"
        className="max-w-full max-h-96 w-auto h-auto object-contain rounded-md border border-border"
      />
    </div>
  )
})

export type ToolOutputProps = ComponentProps<'div'> & {
  output: ToolUIPart['output']
  errorText: ToolUIPart['errorText']
  resolver: (input: string) => Promise<string>
  // Running count of citations from earlier tool calls in this turn, so each
  // card's numbering/anchors continue the global sequence the markers use.
  citationOffset?: number
}

export const ToolOutput = memo(
  ({
    className,
    output,
    errorText,
    resolver,
    citationOffset = 0,
    ...props
  }: ToolOutputProps) => {
    const { t } = useTranslation()
    const { messageId } = useTool()
    const [expanded, setExpanded] = useState(false)
    const [showRaw, setShowRaw] = useState(false)
    const citationPayload = useMemo(
      () => (output ? parseCitationsFromToolOutput(output) : null),
      [output]
    )

    // Generic results lead with a description of what came back; the payload
    // itself is one click away rather than dumped as JSON.
    const summary = useMemo(
      () => (citationPayload || errorText ? undefined : summarizeToolOutput(output)),
      [citationPayload, errorText, output]
    )

    const copyText = useMemo(
      () => (errorText ? errorText : stringifyToolInput(output)),
      [errorText, output]
    )
    // A refusal says what happened and what to do next, above the raw error.
    const refusal = useMemo(
      () => classifyPermissionOutcome(errorText),
      [errorText]
    )
    // Only offer expansion for payloads long enough to be clipped. Citation
    // output (native web search, RAG) renders as cards outside the scroll box,
    // so there is no height for the control to act on.
    const isLong =
      !citationPayload && copyText.length > OUTPUT_EXPAND_THRESHOLD
    // Output scrolls inside its own code-surface box, never the page.
    const boxClassName = cn(
      'max-w-full overflow-auto rounded-lg bg-code-bg shadow-[inset_0_0_0_0.8px_var(--border)]',
      expanded ? 'max-h-[32rem]' : 'max-h-40'
    )

    const Output = useMemo(() => {
      if (!(output || errorText)) {
        return null
      }

      if (citationPayload) {
        return (
          <Citations
            payload={citationPayload}
            anchorPrefix={messageId ? `cite-${messageId}` : undefined}
            indexOffset={citationOffset}
          />
        )
      }

      // Handle string output
      if (typeof output === 'string') {
        return (
          <div className={boxClassName}>
            <CodeBlock code={output} language="json" />
          </div>
        )
      }

      if (typeof output === 'object' && !isValidElement(output)) {
        // Check if output has content array (new structure: {content: [{text, type}, {data, type: image}]})
        if (
          output &&
          typeof output === 'object' &&
          'content' in output &&
          Array.isArray(output.content)
        ) {
          const content = output.content as Array<{
            type: string
            text?: string
            data?: string
            mimeType?: string
          }>

          const textItems = content.filter((item) => item.type === 'text')
          const imageItems = content.filter((item) => item.type === 'image')

          return (
            <div className="space-y-4">
              {textItems.length > 0 && (
                <div className="space-y-2">
                  {textItems.map((item, index) => (
                    <div key={index} className={boxClassName}>
                      <CodeBlock code={item.text || ''} language="markdown" />
                    </div>
                  ))}
                </div>
              )}
              {imageItems.length > 0 && (
                <div className="space-y-2">
                  {imageItems.map((item, index) => (
                    <ToolImage
                      key={index}
                      data={item.data || ''}
                      index={index}
                      resolver={resolver}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        }

        // Handle old array format for backward compatibility
        if (Array.isArray(output)) {
          const hasImages = output.some(
            (item) => item?.type === 'image' && (item?.data || item?.image)
          )

          if (hasImages) {
            // Filter out images from JSON and render images separately
            const nonImageOutput = output.filter(
              (item) => item?.type !== 'image'
            )

            return (
              <div className="space-y-4">
                {nonImageOutput.length > 0 && (
                  <div className={boxClassName}>
                    <CodeBlock
                      code={JSON.stringify(nonImageOutput, null, 2)}
                      language="json"
                    />
                  </div>
                )}
                {output
                  .filter(
                    (item) =>
                      item?.type === 'image' && (item?.data || item?.image?.url)
                  )
                  .map((item, index) => (
                    <ToolImage
                      key={index}
                      data={item.data ?? item.image?.url}
                      index={index}
                      resolver={resolver}
                    />
                  ))}
              </div>
            )
          }

          return (
            <div className={boxClassName}>
              <CodeBlock
                code={JSON.stringify(output, null, 2)}
                language="json"
              />
            </div>
          )
        }

        // Handle regular object
        return (
          <div className={boxClassName}>
            <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
          </div>
        )
      }

      return <div>{output as ReactNode}</div>
    }, [
      output,
      errorText,
      resolver,
      citationPayload,
      messageId,
      citationOffset,
      boxClassName,
    ])

    if (!(output || errorText)) {
      return null
    }

    return (
      <div className={cn(TOOL_SECTION, 'space-y-2', className)} {...props}>
        <div className="flex min-h-6 items-center gap-1">
          <h4
            className={cn(
              'text-xs font-medium',
              errorText ? 'text-destructive' : 'text-foreground'
            )}
          >
            {errorText ? t('tools:toolCall.error') : t('tools:toolCall.result')}
          </h4>
          <div className="ml-auto flex items-center gap-0.5">
            {summary && (
              <Button
                variant="ghost"
                size="xs"
                type="button"
                className="text-muted-foreground pointer-coarse:h-11"
                onClick={() => setShowRaw((raw) => !raw)}
              >
                {showRaw
                  ? t('tools:toolCall.hideRaw')
                  : t('tools:toolCall.viewRaw')}
              </Button>
            )}
            {isLong && (!summary || showRaw) && (
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => setExpanded((open) => !open)}
              >
                {expanded
                  ? t('tools:toolCall.showLess')
                  : t('tools:toolCall.showMore')}
              </Button>
            )}
            <CopyButton text={copyText} />
          </div>
        </div>
        {summary && (
          <p className="text-sm text-muted-foreground">
            {t(summary.key, summary.values)}
          </p>
        )}
        <div className="rounded-md overflow-hidden">
          {refusal && (
            <div data-testid="permission-outcome" className="mb-2 space-y-1">
              <p className="text-foreground">
                {formatPermissionMessage(t, refusal.message)}
              </p>
              {refusal.nextStep && (
                <p className="text-muted-foreground">
                  {formatPermissionMessage(t, refusal.nextStep)}
                </p>
              )}
            </div>
          )}
          {errorText && (
            <div className="rounded-lg border-[0.8px] border-destructive/30 bg-destructive-tint px-2.5 py-2 font-mono text-xs text-destructive wrap-break-word">
              {errorText}
            </div>
          )}
          {(!summary || showRaw) && Output}
        </div>
      </div>
    )
  }
)

Tool.displayName = 'Tool'
ToolHeader.displayName = 'ToolHeader'
ToolContent.displayName = 'ToolContent'
ToolInput.displayName = 'ToolInput'
ToolOutput.displayName = 'ToolOutput'
ToolApprovalActions.displayName = 'ToolApprovalActions'
