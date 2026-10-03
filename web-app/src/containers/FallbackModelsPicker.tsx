import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useAppTranslation } from '@/i18n'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { fallbackRef, moveFallback, parseFallbackRef } from '@/lib/fallbackChain'

/** The ordered models a chat falls back to when the chosen one fails to answer. */
export default function FallbackModelsPicker() {
  const { t } = useAppTranslation()
  const refs = useGeneralSetting((s) => s.fallbackModels)
  const setRefs = useGeneralSetting((s) => s.setFallbackModels)
  const providers = useModelProvider((s) => s.providers)
  const options = providers
    .filter((p) => p.active)
    .flatMap((p) =>
      p.models.map((m) => ({ ref: fallbackRef(p.provider, m.id), label: `${p.provider} / ${m.id}` }))
    )
    .filter((o) => !refs.includes(o.ref))

  return (
    <div className="flex flex-col items-end gap-2">
      {refs.map((ref, i) => (
        <div key={ref} className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{i + 1}.</span>
          <span>{parseFallbackRef(ref)?.modelId ?? ref}</span>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('settings:general.fallbackModelsMoveUp')}
            title={t('settings:general.fallbackModelsMoveUp')}
            disabled={i === 0}
            onClick={() => setRefs(moveFallback(refs, i, -1))}
          >
            <Icon name="arrow-up" size={12} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('settings:general.fallbackModelsMoveDown')}
            title={t('settings:general.fallbackModelsMoveDown')}
            disabled={i === refs.length - 1}
            onClick={() => setRefs(moveFallback(refs, i, 1))}
          >
            <Icon name="arrow-down" size={12} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRefs(refs.filter((r) => r !== ref))}
          >
            {t('settings:general.fallbackModelsRemove')}
          </Button>
        </div>
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            disabled={options.length === 0}
            className="min-w-[140px] justify-between"
          >
            {t('settings:general.fallbackModelsAdd')}
            <Icon name="arrow-down" size={12} className="ml-2 opacity-70" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
          {options.map((o) => (
            <DropdownMenuItem
              key={o.ref}
              className="my-0.5 cursor-pointer"
              onClick={() => setRefs([...refs, o.ref])}
            >
              {o.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
