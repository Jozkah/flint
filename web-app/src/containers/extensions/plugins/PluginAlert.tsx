import { OctagonAlert } from 'lucide-react'
import { cn } from '@/lib/utils'

const ALERT = 'flex items-start gap-1.5 text-xs text-destructive break-words'

/** An inline error line, as every plugin pane shows them. */
export function PluginAlert({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}): React.ReactElement {
  return (
    <p role="alert" className={className ? cn(ALERT, className) : ALERT}>
      <OctagonAlert className="mt-px size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  )
}
