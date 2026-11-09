import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * A session row's title, edited in place. Enter or leaving the field keeps
 * the name (an empty one changes nothing), Escape drops the edit.
 */
export function SessionTitleEditor({
  title,
  onSubmit,
  onCancel,
}: {
  title: string
  onSubmit: (title: string) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [value, setValue] = useState(title)
  const inputRef = useRef<HTMLInputElement>(null)
  // Enter and Escape end the edit before the blur that follows; only the
  // first of them counts.
  const done = useRef(false)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const finish = (keep: boolean) => {
    if (done.current) return
    done.current = true
    const name = value.trim()
    if (keep && name) onSubmit(name)
    else onCancel()
  }

  return (
    <Input
      ref={inputRef}
      value={value}
      aria-label={t('common:renameSession')}
      data-testid="rename-session-input"
      className="h-7 px-2 text-sm"
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // The row listens for keys (its menu shortcut); the input's own stay here.
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(false)
        }
      }}
      onBlur={() => finish(true)}
    />
  )
}
