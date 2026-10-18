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
 * Web search for this chat, as one compact row in the composer's parameters
 * panel (the globe button it replaces sat beside that button). The switch is
 * the control; the whole row is its label, so a click anywhere toggles it,
 * and the provider is named quietly on the same line.
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
    <label
      htmlFor={id}
      data-testid="composer-web-search-row"
      title={provider.label}
      className={cn(
        'flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-xs',
        className
      )}
    >
      <Globe
        aria-hidden
        className={cn(
          'size-3.5 shrink-0',
          enabled ? 'text-foreground' : 'text-muted-foreground'
        )}
      />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground">
          {t('common:web_search')}
        </span>
        <span className="ml-1.5 text-muted-foreground">{provider.label}</span>
      </span>
      <Switch
        id={id}
        data-testid="composer-web-search"
        checked={enabled}
        onCheckedChange={(on) => onChange(on)}
        aria-label={t('common:web_search')}
      />
    </label>
  )
}
