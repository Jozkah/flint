import type { ReactNode } from 'react'
import { GitCompare } from 'lucide-react'
import {
  openInBackground,
  useCodeOpen,
  useCodeOpenTools,
} from '@/lib/codeOpen'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

/**
 * A file path from a tool call, clickable where there is a Code panel.
 *
 * Click opens it (at `line` when given); Ctrl/Cmd+click and middle-click add
 * the tab without switching to it; Enter and Space do what click does. A path
 * the surface cannot resolve stays text, with the reason as its tooltip.
 * With `diffable`, a second control opens the change in Changes.
 *
 * Where there is no opener (the chat surface), it is plain text.
 */
export function OpenablePath({
  path,
  line,
  diffable = false,
  className,
  children,
}: {
  path: string
  line?: number
  /** The call changed this file: offer its diff as well. */
  diffable?: boolean
  className?: string
  children?: ReactNode
}) {
  const { t } = useTranslation()
  const open = useCodeOpen()
  const { check, openDiff } = useCodeOpenTools()
  const label = children ?? path

  if (!open || !path.trim()) {
    return <span className={className}>{label}</span>
  }
  const verdict = check ? check(path) : { ok: true as const }
  if (!verdict.ok) {
    return (
      <span
        className={cn('cursor-help', className)}
        title={verdict.reason}
        data-testid="openable-path-unresolved"
      >
        {label}
      </span>
    )
  }

  const where = line ? `${path}:${line}` : path
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1">
      <span
        role="link"
        tabIndex={0}
        data-testid="openable-path"
        title={t('common:codePanel.openPathHint', { path: where })}
        aria-label={t('common:codePanel.openPath', { path: where })}
        className={cn(
          'min-w-0 cursor-pointer truncate rounded-sm underline decoration-dotted underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring',
          className
        )}
        onClick={(e) => {
          // Inside a collapsible header: open the file, not the card.
          e.stopPropagation()
          e.preventDefault()
          open(path, { line, background: openInBackground(e) })
        }}
        onAuxClick={(e) => {
          if (e.button !== 1) return
          e.stopPropagation()
          e.preventDefault()
          open(path, { line, background: true })
        }}
        onMouseDown={(e) => {
          // Middle-click would otherwise start autoscroll.
          if (e.button === 1) e.preventDefault()
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.stopPropagation()
          e.preventDefault()
          open(path, { line, background: openInBackground(e) })
        }}
      >
        {label}
      </span>
      {diffable && openDiff && (
        <button
          type="button"
          data-testid="open-diff"
          aria-label={t('common:codePanel.openDiff', { path })}
          title={t('common:codePanel.openDiff', { path })}
          className="grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-hover-row hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
          onClick={(e) => {
            e.stopPropagation()
            e.preventDefault()
            openDiff(path)
          }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <GitCompare className="size-3" aria-hidden />
        </button>
      )}
    </span>
  )
}
