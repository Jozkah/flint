/**
 * The card a mention pill in the composer shows on hover: which conversation
 * it names, how much of it goes with the message, and its last few messages
 * (docs/CHAT_MENTIONS.md). Read-only and pointer-transparent to the editor.
 */
import { RichSnippet } from '@/components/RichSnippet'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { MENTION_LIMITS, parseMention } from '@/lib/chatMentions'
import type { MentionPreview } from '@/lib/chatMentionPreview'
import { MENTION_ICON, compactCount, mentionTokens } from '@/lib/mentionDisplay'
import { slugTitle } from '@/lib/mentionPills'

export function MentionHoverCard({
  token,
  preview,
  style,
  onPointerEnter,
  onPointerLeave,
}: {
  token: string
  preview?: MentionPreview
  style: React.CSSProperties
  onPointerEnter: () => void
  onPointerLeave: () => void
}) {
  const { t, i18n } = useTranslation()
  const kind = preview?.kind ?? parseMention(token)?.kind ?? 'chat'
  const Icon = MENTION_ICON[kind]
  const title = preview?.title ?? slugTitle(token)
  const ok = preview?.status === 'ok'
  return (
    <div
      role="tooltip"
      data-testid="mention-hover-card"
      style={style}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className="absolute z-30 w-72 max-w-[calc(100%-1rem)] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-muted">
          <Icon aria-hidden className="size-3.5 text-muted-foreground" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold">{title}</div>
          <div className="text-[length:calc(var(--ui-font-base)*0.6875)] text-muted-foreground">
            {t(`common:mentions.kind.${kind}`)}
            {ok && (
              <>
                {' · '}
                {t('common:mentions.messagesCount', { count: preview.messages ?? 0 })}
                {' · ~'}
                {compactCount(
                  mentionTokens(preview.chars ?? 0, preview.summary),
                  i18n?.language
                )}{' '}
                ·{' '}
                {t(`common:mentions.${preview.summary ? 'summary' : 'excerpt'}`)}
              </>
            )}
          </div>
        </div>
      </div>
      {!preview && (
        <div className="mt-2.5 space-y-1.5" aria-hidden>
          <div className="h-2.5 w-11/12 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          <div className="h-2.5 w-2/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
        </div>
      )}
      {preview && !ok && (
        <p
          className={cn(
            'mt-2 text-[length:calc(var(--ui-font-base)*0.6875)]',
            preview.status === 'missing' ? 'text-destructive' : 'text-warning'
          )}
        >
          {t(`common:mentions.status.${preview.status}`, {
            title,
            max: MENTION_LIMITS.maxMentions,
          })}
        </p>
      )}
      {ok && (
        <ul className="m-0 mt-2.5 list-none space-y-1.5 border-t border-border p-0 pt-2.5">
          {(preview.recent ?? []).length === 0 && (
            <li className="text-[length:calc(var(--ui-font-base)*0.6875)] text-muted-foreground">
              {t('common:mentions.preview.empty')}
            </li>
          )}
          {(preview.recent ?? []).map((m, i) => (
            <li key={i} className="line-clamp-2 text-[length:calc(var(--ui-font-base)*0.6875)] leading-snug">
              <span className="font-medium text-muted-foreground">
                {m.speaker ??
                  t(`common:mentions.preview.${m.role === 'user' ? 'you' : 'assistant'}`)}
                :
              </span>{' '}
              <RichSnippet text={m.text} query="" className="line-clamp-none inline" />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
