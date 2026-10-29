import type { ReactNode } from 'react'
import { Download } from 'lucide-react'
import { ChangeDiff } from '@/components/ChangeDiff'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { ToolCallBar } from '@/lib/toolPresentation'
import type { imagesOfOutput } from '@/lib/toolOutputImages'
import { canSaveToolImage, saveToolImageWithToast } from '@/lib/exportImage'
import { lineOfToolInput, toolChangesFile } from '@/lib/codeOpen'
import type { ToolPartLike } from './types'
import { RagToolWidget } from './RagToolWidget'
import { WebToolWidget } from './WebToolWidget'
import { AgentToolWidget, TerminalWidget } from './AgentToolWidget'
import { OpenablePath } from './OpenablePath'

// The parts of a tool call card (F8-014): its outcome badge, its result
// section and the images it returned. Split out of ToolCallCard unchanged.

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

/** What a native call returned, in the widget for its kind. */
export const ToolResult = ({
  bar,
  part,
  output,
  errorText,
  failed,
  diff,
  messageId,
  citationOffset,
}: {
  bar: ToolCallBar
  part: ToolPartLike
  output: unknown
  errorText?: string
  failed: boolean
  diff?: string
  messageId: string
  citationOffset: number
}) => {
  const { t } = useTranslation()
  const resultLabel = failed
    ? t('tools:toolCall.error')
    : t('tools:toolCall.result')

  return bar.variant === 'documents' ? (
    <ResultSection label={resultLabel} failed={failed}>
      <RagToolWidget
        embedded
        bar={bar}
        state={part.state}
        output={output}
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
          output={output}
          errorText={errorText}
          attemptCallId={part.toolCallId}
        />
      </div>
    </ResultSection>
  ) : bar.variant === 'workspace' ? (
    diff ? (
      <>
        {/* Which file, openable, with the change a click away in Changes. */}
        {bar.target && (
          <div className="flex min-w-0 items-center gap-1.5 px-2.5 pt-2 font-mono text-xs text-muted-foreground">
            <OpenablePath
              path={bar.target}
              line={lineOfToolInput(part.input)}
              diffable={toolChangesFile(bar.tool)}
            />
          </div>
        )}
        {/* The change itself is the result: edge to edge, under a dashed rule. */}
        <ChangeDiff diff={diff} bleed />
      </>
    ) : (
      <ResultSection label={resultLabel} failed={failed}>
        <AgentToolWidget
          embedded
          bar={bar}
          state={part.state}
          output={output}
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
        output={output}
        errorText={errorText}
      />
    </ResultSection>
  )
}

/** Images a call returned for the model. Display only. */
export const ToolImages = ({
  images,
}: {
  images: ReturnType<typeof imagesOfOutput>
}) => {
  const { t } = useTranslation()
  return images.length ? (
    // What a `read` of an image file showed the model. Display only.
    <div className="flex flex-wrap gap-2" data-testid="tool-images">
      {images.map((img, n) => (
        <div key={`${img.name}-${n}`} className="group relative">
          <img
            alt={img.name}
            title={img.name}
            src={img.dataUrl}
            className="max-h-32 max-w-[12rem] rounded-md border border-border bg-muted object-contain"
          />
          {canSaveToolImage(img) && (
            <button
              type="button"
              data-testid="tool-image-save"
              aria-label={t('tools:toolCall.saveImage', { name: img.name })}
              title={t('tools:toolCall.saveImage', { name: img.name })}
              onClick={() => void saveToolImageWithToast(img)}
              className="absolute right-1 top-1 flex size-6 items-center justify-center rounded-md bg-background/80 text-foreground opacity-0 transition-opacity hover:bg-background focus-visible:opacity-100 group-hover:opacity-100"
            >
              <Download className="size-3.5" />
            </button>
          )}
        </div>
      ))}
    </div>
  ) : null
}
