import { useId } from 'react'
import { Terminal } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

export type ShellToggle = {
  enabled: boolean
  onChange: (on: boolean) => void
}

/**
 * Chat's shell switch, a row in the composer's options panel next to web
 * search and built the same way: the switch is the control, the whole row is
 * its label.
 */
export function ShellToggleRow({
  enabled,
  onChange,
  className,
}: ShellToggle & { className?: string }) {
  const { t } = useTranslation()
  const id = useId()
  return (
    <label
      htmlFor={id}
      data-testid="composer-shell-row"
      title={t('common:chatShellHint')}
      className={cn(
        'flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-xs',
        className
      )}
    >
      <Terminal
        aria-hidden
        className={cn(
          'size-3.5 shrink-0',
          enabled ? 'text-foreground' : 'text-muted-foreground'
        )}
      />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground">
          {t('common:chatShell')}
        </span>
        <span className="ml-1.5 text-muted-foreground">
          {t('common:chatShellHint')}
        </span>
      </span>
      <Switch
        id={id}
        data-testid="composer-shell"
        checked={enabled}
        onCheckedChange={(on) => onChange(on)}
        aria-label={t('common:chatShell')}
      />
    </label>
  )
}
