/* eslint-disable react-refresh/only-export-components */
import { cn } from '@/lib/utils'
import type { ToolUIPart } from 'ai'
import type { ComponentProps, ReactNode } from 'react'
import { isValidElement, memo, useMemo, useState } from 'react'
import { CodeBlock } from '../code-block'
import { CopyButton } from '@/containers/CopyButton'
import { stringifyToolInput } from '@/lib/toolInputSummary'
import { summarizeToolOutput } from '@/lib/toolOutputSummary'
import { classifyPermissionOutcome } from '@/lib/permissionOutcome'
import { formatPermissionMessage } from '@/containers/PermissionRequestDetails'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { Citations } from '@/components/Citations'
import { parseCitationsFromToolOutput } from '@/lib/citation-parser'
import { TOOL_SECTION, OUTPUT_EXPAND_THRESHOLD, useTool } from './shared'
import { ToolImage } from './image'

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

ToolOutput.displayName = 'ToolOutput'

