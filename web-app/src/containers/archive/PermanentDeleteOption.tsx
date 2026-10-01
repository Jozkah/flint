import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * The "delete permanently" choice in a delete dialog. Unchecked by default:
 * deleting moves the item to the Archive, and this skips it.
 */
export function PermanentDeleteOption({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  const { t } = useTranslation()
  return (
    <label
      className="flex items-start gap-2 text-sm"
      data-testid="delete-permanently-option"
    >
      <input
        type="checkbox"
        className="mt-1"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="flex flex-col">
        <span>{t('archive:permanentLabel')}</span>
        <span className="text-xs text-muted-foreground">
          {t('archive:permanentHint')}
        </span>
      </span>
    </label>
  )
}
