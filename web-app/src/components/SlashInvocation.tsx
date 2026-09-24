/**
 * How a sent slash command reads in a transcript: the `/command args` the user
 * typed, marked as a command or skill, with the expanded prompt the model
 * received folded away underneath. Used by the Home/Cowork message bubble and
 * the Rooms transcript.
 */
import { Puzzle, Sparkles } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { slashDisplay, type SlashInvocation as Invocation } from '@/lib/slashCommands'

export function SlashInvocation({
  invocation,
  body,
}: {
  invocation: Invocation
  body: string
}) {
  const { t } = useTranslation()
  const Icon = invocation.kind === 'skill' ? Sparkles : Puzzle
  return (
    <div className="flex flex-col gap-1" data-testid="slash-invocation">
      <div className="flex items-center gap-1.5">
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="sr-only">
          {t(invocation.kind === 'skill' ? 'slash:sent.skill' : 'slash:sent.command')}
        </span>
        <span dir="auto" className="font-mono whitespace-pre-wrap">
          {slashDisplay(invocation)}
        </span>
      </div>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none">
          {t(invocation.kind === 'skill' ? 'slash:sent.showSkill' : 'slash:sent.showCommand')}
        </summary>
        <div className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap select-text">
          {body}
        </div>
      </details>
    </div>
  )
}
