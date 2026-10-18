/**
 * The conversations a sent message mentioned, as chips like the composer's
 * (docs/CHAT_MENTIONS.md): icon, title, and what was included. Each
 * opens the conversation it names; one that has since been deleted is shown
 * dimmed and does nothing. The title is the one at send time, so a rename
 * does not rewrite what was said.
 */
import { useNavigate } from '@tanstack/react-router'
import { ArrowUpRight } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { route } from '@/constants/routes'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { listConversations } from '@/lib/chatMentionSources'
import type { MentionRecord } from '@/lib/chatMentions'
import { MENTION_ICON as ICON } from '@/lib/mentionDisplay'

export function SentMentions({ mentions }: { mentions: MentionRecord[] }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  if (mentions.length === 0) return null
  const live = new Set(listConversations().map((e) => `${e.kind}:${e.id}`))
  const open = (m: MentionRecord) => {
    if (m.kind === 'chat') {
      void navigate({ to: route.threadsDetail, params: { threadId: m.id } })
    } else if (m.kind === 'session') {
      useCoworkSessions.getState().selectSession(m.id)
      void navigate({ to: route.cowork })
    } else {
      void navigate({ to: route.roomDetail, params: { roomId: m.id } })
    }
  }
  return (
    <div
      className="mb-2 flex flex-wrap gap-1.5"
      data-testid="sent-mentions"
      role="group"
      aria-label={t('common:mentions.group')}
    >
      {mentions.map((m) => {
        const Icon = ICON[m.kind]
        const exists = live.has(`${m.kind}:${m.id}`)
        return (
          <button
            key={`${m.kind}:${m.id}`}
            type="button"
            data-testid="sent-mention-chip"
            data-exists={exists}
            disabled={!exists}
            aria-label={t('common:mentions.open', { title: m.titleAtSend })}
            onClick={() => open(m)}
            title={m.titleAtSend}
            className={cn(
              'group/mention inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-xs text-foreground shadow-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-ring',
              exists ? 'hover:bg-accent' : 'cursor-default border-dashed opacity-60 shadow-none'
            )}
          >
            <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span
              className={cn(
                'max-w-[16rem] min-w-0 truncate font-medium',
                !exists && 'line-through decoration-1'
              )}
            >
              {m.titleAtSend}
            </span>
            {(m.summary || m.messages !== undefined) && (
              <span className="shrink-0 text-[11px] text-muted-foreground">
                ·{' '}
                {m.summary
                  ? t('common:mentions.summary')
                  : t('common:mentions.messagesCount', { count: m.messages })}
              </span>
            )}
            {exists && (
              <ArrowUpRight
                aria-hidden
                className="-mr-0.5 size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/mention:opacity-100 group-focus-visible/mention:opacity-100"
              />
            )}
          </button>
        )
      })}
    </div>
  )
}
