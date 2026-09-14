import type { ReactNode } from 'react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

export const GLOSSARY_TERMS = [
  'worktree',
  'context',
  'mcpServer',
  'checkpoint',
  'agent',
] as const
export type GlossaryTerm = (typeof GLOSSARY_TERMS)[number]

/**
 * A technical term with its plain-language meaning one click or keypress away.
 * The term itself stays on screen, so experienced users and documentation
 * searches still find it; the explanation is not hover-only.
 */
export function TermHint({
  term,
  children,
  className,
}: {
  term: GlossaryTerm
  /** Visible text; defaults to the glossary's name for the term. */
  children?: ReactNode
  className?: string
}) {
  const { t } = useTranslation()
  const name = t(`glossary:${term}.term`)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline cursor-help rounded-sm underline decoration-muted-foreground decoration-dotted underline-offset-2 hover:decoration-brand focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring',
            className
          )}
          aria-label={t('glossary:explain', { term: name })}
        >
          {children ?? name}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-72 max-w-[90vw] rounded-lg border-border bg-popover p-3 text-sm"
        align="start"
      >
        <p className="font-semibold text-foreground">{name}</p>
        <p className="mt-1 leading-relaxed text-ink-2">
          {t(`glossary:${term}.definition`)}
        </p>
      </PopoverContent>
    </Popover>
  )
}
