import { useId } from 'react'
import { Globe } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  getProviderMeta,
  useWebSearchConfig,
} from '@/hooks/useWebSearchConfig'
import { cn } from '@/lib/utils'

export type WebSearchToggle = {
  enabled: boolean
  onChange: (on: boolean) => void
}

/**
 * Web search for this chat, as a row in the composer's parameters panel: the
 * globe button it replaces lived beside the parameters button. The switch is
 * the control; the whole row toggles it, and the provider names where the
 * searches go.
 */
export function WebSearchToggleRow({
  enabled,
  onChange,
  className,
}: WebSearchToggle & { className?: string }) {
  const { t } = useTranslation()
  const id = useId()
  const provider = useWebSearchConfig((s) => getProviderMeta(s.searchProvider))
  return (
    <div
      data-testid="composer-web-search-row"
      className={cn(
        'flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent',
        className
      )}
    >
      <Globe
        aria-hidden
        className={cn(
          'size-4 shrink-0',
          enabled ? 'text-foreground' : 'text-muted-foreground'
        )}
      />
      <label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer flex-col">
        <span className="truncate text-sm font-medium">
          {t('common:web_search')}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {provider.label}
        </span>
      </label>
      <Switch
        id={id}
        data-testid="composer-web-search"
        checked={enabled}
        onCheckedChange={(on) => onChange(on)}
        aria-label={t('common:web_search')}
      />
    </div>
  )
}
