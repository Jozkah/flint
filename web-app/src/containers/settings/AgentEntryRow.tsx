import { CardItem } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { SkillWarning } from './SkillWarning'

/** True when `query` (already trimmed and lower-cased) is empty or in the name or description. */
export function entryMatches(
  query: string,
  name: string,
  description?: string
): boolean {
  return (
    !query ||
    name.toLowerCase().includes(query) ||
    (description ?? '').toLowerCase().includes(query)
  )
}

/**
 * One skill in the Agent tools list. A plugin's skill shows the plugin name
 * and cannot be edited here; the user's own show edit and delete.
 */
export function AgentEntryRow({
  name,
  description,
  plugin,
  warning,
  onEdit,
  onDelete,
}: {
  name: string
  description?: string
  plugin?: string
  /** What was wrong with the skill's front matter, when something was. */
  warning?: string
  onEdit: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  return (
    <CardItem
      title={name}
      description={
        description || warning ? (
          <span className="flex min-w-0 flex-col gap-1">
            {description && (
              <span className="line-clamp-2 break-words">{description}</span>
            )}
            <SkillWarning warning={warning} />
          </span>
        ) : undefined
      }
      actions={
        plugin ? (
          <Chip>{plugin}</Chip>
        ) : (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground pointer-coarse:size-11"
              title={t('common:edit')}
              aria-label={`${t('common:edit')} ${name}`}
              onClick={onEdit}
            >
              <Icon name="x-edit" size={16} />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-destructive pointer-coarse:size-11"
              title={t('common:delete')}
              aria-label={`${t('common:delete')} ${name}`}
              onClick={onDelete}
            >
              <Icon name="x-trash" size={16} />
            </Button>
          </div>
        )
      }
    />
  )
}
