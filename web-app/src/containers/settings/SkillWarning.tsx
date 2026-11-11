import { Chip } from '@/components/ui/chip'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * What was wrong with a skill's front matter, when the backend read it
 * leniently or ignored part of it: a small badge and the backend's own words,
 * so a skill that behaves oddly says why.
 */
export function SkillWarning({ warning }: { warning?: string }) {
  const { t } = useTranslation()
  const text = warning?.trim()
  if (!text) return null
  return (
    <span
      className="flex min-w-0 items-start gap-1.5 text-xs text-warning"
      data-testid="skill-warning"
      role="note"
    >
      <Chip tone="warn" className="shrink-0">
        {t('settings:agentTools.skillWarning')}
      </Chip>
      <span className="min-w-0 line-clamp-2 break-words">{text}</span>
    </span>
  )
}
