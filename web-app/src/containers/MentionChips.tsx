/**
 * The conversations a draft mentions, as chips above the composer, with what
 * will be included from each (docs/CHAT_MENTIONS.md). Each chip names the
 * conversation once, switches between the latest messages (Excerpt) and a
 * model-written Summary, and can be taken out. One line under the chips says
 * how much is included in all, and warns when that is a large share of the
 * model's window. Shown only while the draft has a mention.
 */
import { useState } from 'react'
import { AlertTriangle, AtSign, ChevronDown, ChevronUp, Info, X } from 'lucide-react'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { useMentionPreview } from '@/hooks/useMentionPreview'
import {
  MENTION_LIMITS,
  parseMention,
} from '@/lib/chatMentions'
import {
  removeMention,
  toggleSummary,
  type MentionPreview,
} from '@/lib/chatMentionPreview'
import { parsePromptForReferences } from '@/lib/path-references'
import {
  MENTION_ICON,
  compactCount,
  mentionTokens,
  mentionTotals,
  mentionsTooLarge,
} from '@/lib/mentionDisplay'
import { slugTitle } from '@/lib/mentionPills'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

/** What the folded row says is included: all excerpts, all summaries, or both. */
function compactMode(
  previews: readonly MentionPreview[],
  t: (key: string) => string
): string {
  const ok = previews.filter((p) => p.status === 'ok')
  const summaries = ok.filter((p) => p.summary).length
  if (summaries === 0) return t('common:mentions.excerpt')
  if (summaries === ok.length) return t('common:mentions.summary')
  return t('common:mentions.mixed')
}

const focusRing =
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-ring'

export function MentionChips({
  prompt,
  currentId,
  onChange,
  canSummarize,
  previews: given,
  contextWindow,
}: {
  prompt: string
  currentId?: string
  onChange: (next: string) => void
  /** A model is loaded to write the summary. */
  canSummarize: boolean
  /** Already looked up by the composer; when absent the chips look up themselves. */
  previews?: MentionPreview[]
  /** The model's window in tokens, when known; drives the size warning. */
  contextWindow?: number | null
}) {
  const { t, i18n } = useTranslation()
  const own = useMentionPreview(given ? '' : prompt, currentId)
  const previews = given ?? own
  // Tokens typed but not looked up yet (the lookup waits for typing to stop).
  const typed = parsePromptForReferences(prompt).filter((r) => parseMention(r))
  const known = new Set(previews.map((p) => p.token))
  const pending = typed.filter((tok) => !known.has(tok))
  // On a narrow composer the chips repeat the editor's pills and eat the
  // height, so they fold into one line that opens on tap.
  const narrow = useMediaQuery('(max-width: 520px)')
  const [expanded, setExpanded] = useState(false)
  if (previews.length === 0 && pending.length === 0) return null
  const compact = narrow && !expanded

  const totals = mentionTotals(previews)
  const tooLarge = mentionsTooLarge(totals.tokens, contextWindow)
  const overCap = previews.find((p) => p.status === 'over-cap')
  const lang = i18n?.language

  const summarizeAll = () => {
    let next = prompt
    for (const p of previews) {
      if (p.status === 'ok' && !p.summary) next = toggleSummary(next, p.token)
    }
    onChange(next)
  }

  return (
    <TooltipProvider>
    <div
      className="mb-1 flex flex-col gap-2 px-3 pt-3"
      data-testid="mention-chips"
      role="group"
      aria-label={t('common:mentions.group')}
    >
      {compact ? (
        <button
          type="button"
          data-testid="mention-chips-compact"
          aria-expanded={false}
          onClick={() => setExpanded(true)}
          className={cn(
            'flex h-7 min-w-0 items-center gap-1.5 self-start rounded-full border border-border bg-card px-2.5 text-xs text-foreground shadow-xs hover:bg-accent',
            focusRing
          )}
        >
          <AtSign aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">
            {t('common:mentions.compact', {
              count: previews.length + pending.length,
              mode: compactMode(previews, t),
            })}
          </span>
          <ChevronDown aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        </button>
      ) : null}
      {narrow && expanded ? (
        <button
          type="button"
          data-testid="mention-chips-collapse"
          aria-expanded
          onClick={() => setExpanded(false)}
          className={cn(
            'flex items-center gap-1 self-start rounded px-1 text-[length:calc(var(--ui-font-base)*0.6875)] text-muted-foreground hover:text-foreground',
            focusRing
          )}
        >
          <ChevronUp aria-hidden className="size-3" />
          {t('common:collapse')}
        </button>
      ) : null}
      {/* Two whole rows at most (chips are h-7 with a gap-2: 2 * 1.75rem +
          0.5rem), scrolling a row at a time so no half row ever shows. */}
      <ul
        hidden={compact}
        className="m-0 flex max-h-[4rem] snap-y snap-mandatory list-none flex-wrap gap-2 overflow-y-auto p-0 [scrollbar-width:thin] [&>li]:snap-start"
      >
        {previews.map((p) => {
          const Icon = MENTION_ICON[p.kind]
          const title = p.title ?? slugTitle(p.token)
          const ok = p.status === 'ok'
          const longStatus = ok
            ? title
            : t(`common:mentions.status.${p.status}`, {
                title,
                max: MENTION_LIMITS.maxMentions,
              })
          const excerptTokens = mentionTokens(p.chars ?? 0, false)
          const summaryTokens = mentionTokens(p.chars ?? 0, true)
          return (
            <li
              key={p.token}
              data-testid="mention-chip"
              data-status={p.status}
              data-mode={p.summary ? 'summary' : 'excerpt'}
              className={cn(
                'inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full border pr-0.5 pl-2 text-xs shadow-xs transition-colors',
                ok && 'border-border bg-card text-foreground',
                p.status === 'missing' &&
                  'border-dashed border-destructive/50 bg-destructive/5 text-destructive',
                p.status === 'self' &&
                  'border-dashed border-border bg-transparent text-muted-foreground',
                p.status === 'over-cap' &&
                  'border-dashed border-warning/60 bg-warning/5 text-warning'
              )}
            >
              <Icon
                aria-hidden
                className={cn(
                  'size-3.5 shrink-0',
                  ok ? 'text-muted-foreground' : 'opacity-80'
                )}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={cn(
                      'max-w-[9rem] min-w-0 truncate font-medium sm:max-w-[16rem]',
                      !ok && p.status !== 'over-cap' && 'line-through decoration-1'
                    )}
                  >
                    {title}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-64 leading-snug">
                  {longStatus}
                </TooltipContent>
              </Tooltip>
              {!ok && (
                <span className="shrink-0 text-[length:calc(var(--ui-font-base)*0.6875)] opacity-90">
                  · {t(`common:mentions.chipStatus.${p.status}`)}
                  <span className="sr-only">: {longStatus}</span>
                </span>
              )}
              {ok && canSummarize && (
                <span
                  role="radiogroup"
                  aria-label={t('common:mentions.modeGroup', { title })}
                  className="ml-0.5 inline-flex h-5 shrink-0 items-center rounded-full bg-muted p-0.5"
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                    event.preventDefault()
                    onChange(toggleSummary(prompt, p.token))
                  }}
                >
                  {(
                    [
                      ['excerpt', false, excerptTokens, 'mention-excerpt'],
                      ['summary', true, summaryTokens, 'mention-summarize'],
                    ] as const
                  ).map(([mode, summary, tokens, testId]) => {
                    const on = p.summary === summary
                    const hint = t(`common:mentions.${mode}Hint`, {
                      tokens: compactCount(tokens, lang),
                    })
                    return (
                      <Tooltip key={mode}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            role="radio"
                            aria-checked={on}
                            aria-description={hint}
                            data-testid={testId}
                            className={cn(
                              'h-4 rounded-full px-1.5 text-[length:calc(var(--ui-font-base)*0.625)] leading-none font-medium transition-colors',
                              focusRing,
                              on
                                ? 'bg-background text-foreground shadow-xs'
                                : 'text-muted-foreground hover:text-foreground'
                            )}
                            onClick={() => {
                              if (!on) onChange(toggleSummary(prompt, p.token))
                            }}
                          >
                            {t(`common:mentions.${mode}`)}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-64 leading-snug">
                          {hint}
                        </TooltipContent>
                      </Tooltip>
                    )
                  })}
                </span>
              )}
              <button
                type="button"
                data-testid="mention-remove"
                aria-label={t('common:mentions.remove', { title })}
                className={cn(
                  'grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground',
                  focusRing
                )}
                onClick={() => onChange(removeMention(prompt, p.token))}
              >
                <X aria-hidden className="size-3" />
              </button>
            </li>
          )
        })}
        {pending.map((tok) => {
          const parsed = parseMention(tok)
          const Icon = MENTION_ICON[parsed?.kind ?? 'chat']
          return (
            <li
              key={`pending:${tok}`}
              data-testid="mention-chip-loading"
              className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-xs text-muted-foreground"
            >
              <Icon aria-hidden className="size-3.5 shrink-0 opacity-60" />
              <span
                aria-hidden
                className="h-2.5 w-24 animate-pulse rounded-full bg-muted motion-reduce:animate-none"
              />
              <span className="sr-only">
                {t('common:mentions.resolving', { title: slugTitle(tok) })}
              </span>
            </li>
          )
        })}
      </ul>
      {(totals.messages > 0 || overCap) && (
        <div
          data-testid="mention-status"
          data-warn={tooLarge}
          aria-live="polite"
          className={cn(
            'flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 px-1 pb-1 text-[length:calc(var(--ui-font-base)*0.6875)] leading-4',
            tooLarge ? 'text-warning' : 'text-muted-foreground'
          )}
        >
          {totals.messages > 0 && (
            <>
              {tooLarge && <AlertTriangle aria-hidden className="size-3 shrink-0" />}
              <span>
                {t('common:mentions.totals', {
                  count: totals.messages,
                  tokens: compactCount(totals.tokens, lang),
                })}
              </span>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      data-testid="mention-info"
                      aria-label={t('common:mentions.readOnly')}
                      className={cn(
                        'grid size-4 place-items-center rounded-full opacity-70 hover:opacity-100',
                        focusRing
                      )}
                    >
                      <Info aria-hidden className="size-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-64 leading-snug">
                    {t('common:mentions.readOnly')}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              {tooLarge && (
                <>
                  <span>{t('common:mentions.tooLarge')}</span>
                  {canSummarize && totals.excerpts > 0 && (
                    <button
                      type="button"
                      data-testid="mention-use-summary"
                      className={cn(
                        'rounded font-medium underline underline-offset-2 hover:no-underline',
                        focusRing
                      )}
                      onClick={summarizeAll}
                    >
                      {t('common:mentions.useSummary')}
                    </button>
                  )}
                </>
              )}
            </>
          )}
          {overCap && (
            <span className="basis-full text-warning" data-testid="mention-over-cap">
              {t('common:mentions.status.over-cap', {
                title: overCap.title ?? slugTitle(overCap.token),
                max: MENTION_LIMITS.maxMentions,
              })}
            </span>
          )}
        </div>
      )}
    </div>
    </TooltipProvider>
  )
}
