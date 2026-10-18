import { Sparkles } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useSkills, effectiveEnabled, storedEnabled } from '@/hooks/useSkills'
import { cn } from '@/lib/utils'
import { isPluginSkill } from '@/lib/skillStore'

/**
 * Top-of-input control showing which skills will be advertised to the agent this
 * run, with per-skill on/off toggles. Backed by the project's `[skills].enabled`
 * whitelist — an empty whitelist means every skill is enabled.
 */
export default function SkillSelector({ folder }: { folder: string | null }) {
  const { t } = useTranslation()
  const { skills, enabled, setEnabled } = useSkills(folder)

  if (skills.length === 0) return null

  const allNames = skills.map((s) => s.name)
  const effective = effectiveEnabled(enabled, allNames)
  // #8878: the global store is what the Cowork agent actually reads, so its
  // skills are shown and active even with no folder. The `[skills].enabled`
  // whitelist lives in a project's agent.toml, so with no folder it has nowhere
  // to persist -- every global skill is active and the toggle is informational.
  const scoped = folder !== null

  const toggle = (name: string) => {
    if (!scoped) return
    const next = new Set(effective)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    setEnabled(storedEnabled(next, allNames))
  }

  // No count on the button: a dot says some skill is on; the numbers are in
  // the accessible name and the tooltip.
  const summary = t('connections:skills.summary', {
    enabled: effective.size,
    installed: allNames.length,
  })
  const label = `${t('common:skillsInContext')}: ${summary}`
  const anyOn = effective.size > 0
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          // The size, radius and icon of the plus and options buttons beside it.
          className="relative size-7 shrink-0 rounded-[7px] text-muted-foreground pointer-coarse:size-11"
          title={label}
          aria-label={label}
          data-testid="skill-selector"
          data-active={anyOn ? 'true' : undefined}
        >
          <Sparkles
            aria-hidden
            className={cn('size-4 shrink-0', anyOn && 'text-foreground')}
          />
          {anyOn && (
            <span
              aria-hidden
              data-testid="skill-selector-dot"
              className="absolute top-1 right-1 size-[5px] rounded-full bg-primary"
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1">
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          <div>{t('common:skillsInContext')}</div>
          <div>{summary}</div>
        </div>
        {!scoped && (
          <div className="px-2 pb-1.5 text-xs text-muted-foreground">
            {t('common:skillsScopeGlobal')}
          </div>
        )}
        <div className="max-h-64 overflow-y-auto">
          {skills.map((s) => (
            <label
              key={s.name}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
            >
              <div className="flex-1 min-w-0">
                <div className="truncate text-sm font-medium">{s.name}</div>
                {isPluginSkill(s) && (
                  <div className="truncate text-xs text-muted-foreground">
                    {t('connections:skills.fromPlugin', { plugin: s.plugin })}
                  </div>
                )}
                {s.description && (
                  <div className="truncate text-xs text-muted-foreground">
                    {s.description}
                  </div>
                )}
              </div>
              <Switch
                checked={effective.has(s.name)}
                disabled={!scoped}
                onCheckedChange={() => toggle(s.name)}
                aria-label={s.name}
              />
            </label>
          ))}
        </div>
        {/* Enabling here only changes what the agent is offered; it grants no
            tool access (skill tools are always-allowed workspace tools). */}
        <p className="border-t px-2 py-1.5 text-xs text-muted-foreground">
          {t('connections:skills.toolAccess')}
        </p>
      </PopoverContent>
    </Popover>
  )
}
