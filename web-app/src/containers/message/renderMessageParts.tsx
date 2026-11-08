import type { UIMessage } from 'ai'
import { SlashInvocation } from '@/components/SlashInvocation'
import { parseSlashMarker } from '@/lib/slashCommands'
import { RenderMarkdown } from '@/containers/RenderMarkdown'
import { explainRawToolCall } from '@/lib/rawToolCallText'
import { cn } from '@/lib/utils'
import { SentFileChips } from './SentFileChips'
import type { MessagePartLike } from './types'
import type { useTranslation } from '@/i18n/react-i18next-compat'
import { tidySummaryMarkdown } from '@/lib/continueFromSummary'
import { AgentMessageHeader, agentMessageOf } from '@/containers/AgentMessageHeader'
import { unwrapForDisplay } from '@/lib/sessionMailbox'
import { extractFilesFromPrompt, type FileMetadata } from '@/lib/fileMetadata'
import { nameMentions, splitMentionBlocks } from '@/lib/chatMentions'
import { SentMentions } from '@/containers/SentMentions'
import { injectCitationMarkers, type GroundingResult } from '@/lib/grounding'
import type { ViewerImage } from '@/components/ImageViewer'

/*
 * How `MessageItem` draws a text part and a file part. Plain render
 * functions, not components, so the rendered tree is the one the message
 * built inline before they were split out.
 */

type TranslateFn = ReturnType<typeof useTranslation>['t']

type TextPartContext = {
  message: UIMessage
  metadata: Record<string, unknown> | undefined
  attachedFiles: FileMetadata[]
  coloredUserBubble: boolean
  renderUserMarkdown: boolean
  grounding: GroundingResult | undefined
  isStreaming: boolean
  isAnimating: boolean | undefined
  t: TranslateFn
}

type FilePartContext = {
  message: UIMessage
  t: TranslateFn
  setViewer: (viewer: { images: ViewerImage[]; index: number } | null) => void
}

export function renderMessageTextPart(
  part: { type: 'text'; text: string },
  partIndex: number,
  {
    message,
    metadata,
    attachedFiles,
    coloredUserBubble,
    renderUserMarkdown,
    grounding,
    isStreaming,
    isAnimating,
    t,
  }: TextPartContext
) {
  if (!part.text || part.text.trim() === '') {
    return null
  }

  const isLastPart = partIndex === message.parts.length - 1

  // For user messages, extract and clean the text from file metadata, and
  // fold the mentioned-conversation blocks into chips.
  const mentioned =
    message.role === 'user'
      ? splitMentionBlocks(part.text)
      : { clean: part.text, mentions: [] }
  // Mail from another session reaches the model fenced; the bubble shows
  // only its text, under the "Message from <name>" header (live test 1b).
  const displayText =
    message.role === 'user'
      ? agentMessageOf(metadata)
        ? unwrapForDisplay(part.text)
        : nameMentions(
            extractFilesFromPrompt(mentioned.clean).cleanPrompt,
            mentioned.mentions
          )
      : part.text

  // A `/command` the user sent reads as typed; the expansion folds away.
  const slashInvocation =
    message.role === 'user' ? parseSlashMarker(displayText) : null

  if (
    !displayText.trim() &&
    message.role === 'user' &&
    attachedFiles.length === 0
  ) {
    return null
  }

  return (
    <div key={`${message.id}-${partIndex}`} data-message-id={message.id} className="w-full">
      {message.role === 'user' ? (
        <div className="flex justify-end w-full h-full text-start wrap-break-word whitespace-normal">
          <div
            data-slot="user-bubble"
            className={cn(
              'relative inline-block max-w-[min(85%,36rem)] rounded-[14px] rounded-br-[4px] px-3 py-2.5 text-[calc(var(--text-base)*0.8125)] leading-normal text-foreground shadow-[inset_0_0_0_0.8px_var(--border)]',
              coloredUserBubble
                ? // The accent tint, only when the setting asks for it.
                  'bg-acc-tint'
                : // A neutral block otherwise: the right-aligned column
                  // and the tone are enough to find the user's own turns.
                  'bg-muted'
            )}
          >
            {/* janhq/jan#8864: typed while the agent worked and handed to
                it mid-run, not the start of a run of its own. */}
            {metadata?.steered === true && partIndex === 0 && (
              <div
                data-testid="steered-label"
                className="mb-1 text-[length:calc(var(--ui-font-base)*0.6875)] text-muted-foreground"
              >
                {t('common:steering.delivered')}
              </div>
            )}
            {partIndex === 0 && <AgentMessageHeader metadata={metadata} />}
            {mentioned.mentions.length > 0 && (
              <SentMentions mentions={mentioned.mentions} />
            )}
            {/* Show attached files if any */}
            {attachedFiles.length > 0 && (
              <SentFileChips files={attachedFiles} metadata={metadata} />
            )}
            {displayText &&
              (slashInvocation ? (
                <SlashInvocation
                  invocation={slashInvocation.invocation}
                  body={slashInvocation.body}
                />
              ) : renderUserMarkdown || metadata?.continuedFrom ? (
                // The continue-from-summary seed is model-written Markdown;
                // other messages only when the user opted in, since pasted
                // logs and code read better exactly as typed.
                <div dir="auto" className="select-text" data-testid="user-markdown">
                  <RenderMarkdown
                    content={
                      // Seeds written before the summary was tidied still
                      // read well.
                      metadata?.continuedFrom
                        ? tidySummaryMarkdown(displayText)
                        : displayText
                    }
                    isUser
                    isAnimating={false}
                    messageId={message.id}
                  />
                </div>
              ) : (
                <div dir="auto" className="select-text whitespace-pre-wrap">
                  {displayText}
                </div>
              ))}
          </div>
        </div>
      ) : (
        <>
          <RenderMarkdown
            content={
              grounding && !isStreaming
                ? injectCitationMarkers(
                    explainRawToolCall(part.text, t('chat:rawToolCallNotice')),
                    grounding.sentenceCitations,
                    `cite-${message.id}`
                  )
                : message.role === 'assistant'
                  ? explainRawToolCall(part.text, t('chat:rawToolCallNotice'))
                  : part.text
            }
            isStreaming={isStreaming && isLastPart}
            messageId={message.id}
            isAnimating={isAnimating}
          />
        </>
      )}
    </div>
  )
}

export function renderMessageFilePart(
  part: MessagePartLike,
  partIndex: number,
  { message, t, setViewer }: FilePartContext
) {
  const isImage = part.mediaType?.startsWith('image/')
  const isAudio =
    part.mediaType === 'audio/wav' || part.mediaType === 'audio/mpeg'
  const isVideo = part.mediaType?.startsWith('video/')

  if (isAudio && part.url) {
    const justify =
      message.role === 'user' ? 'justify-end' : 'justify-start'
    return (
      <div
        key={`${message.id}-${partIndex}`}
        className={`flex ${justify} w-full my-2`}
      >
        <audio controls src={part.url} className="max-w-[80%] rounded-md" />
      </div>
    )
  }

  if (isVideo && part.url) {
    const justify =
      message.role === 'user' ? 'justify-end' : 'justify-start'
    return (
      <div
        key={`${message.id}-${partIndex}`}
        className={`flex ${justify} w-full my-2`}
      >
        <video
          controls
          src={part.url}
          className="max-w-[80%] max-h-80 rounded-md border border-border"
        />
      </div>
    )
  }

  // A user's images are shown together, above their text (see `userImages`).
  if (message.role === 'user' && isImage && part.url) return null

  if (message.role === 'assistant' && isImage && part.url) {
    return (
      <div key={`${message.id}-${partIndex}`} className="my-2">
        <img
          src={part.url}
          alt={part.filename || t('chat:messageItem.generatedImage')}
          className="max-w-full rounded-md cursor-pointer"
          onClick={() =>
            setViewer({
              images: [{ url: part.url!, name: part.filename }],
              index: 0,
            })
          }
        />
      </div>
    )
  }

  return null
}
