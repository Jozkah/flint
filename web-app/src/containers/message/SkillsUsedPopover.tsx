import { Sparkles } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { useTranslation } from '@/i18n/react-i18next-compat'

/** "N skills used" under a reply, opening the list of skill names. */
export function SkillsUsedPopover({ skills }: { skills: string[] }) {
  const { t } = useTranslation()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="skills-used"
          aria-label={t('common:skillsUsedLabel')}
          className="ml-2 inline-flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground"
        >
          <Sparkles className="size-3.5" aria-hidden />
          {t('common:skillsUsedCount', { count: skills.length })}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 max-w-[calc(100vw-2rem)] p-3 text-xs"
        data-testid="skills-used-list"
      >
        <div className="mb-1.5 font-medium text-foreground">
          {t('common:skillsUsedLabel')}
        </div>
        <ul className="flex flex-col gap-1">
          {skills.map((name) => {
            // A plugin's skill is named plugin:skill; the plugin reads as
            // context, the skill as the point.
            const at = name.indexOf(':')
            return (
              <li key={name} className="break-all text-foreground">
                {at > 0 && (
                  <span className="text-muted-foreground">
                    {name.slice(0, at + 1)}
                  </span>
                )}
                {at > 0 ? name.slice(at + 1) : name}
              </li>
            )
          })}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
