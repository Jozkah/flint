import { useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from '@/i18n/react-i18next-compat'

/** A new skill starts with the frontmatter the catalog reads. */
export const NEW_SKILL_TEMPLATE = '---\nname: \ndescription: \n---\n\n'

/**
 * The skill editor both skill screens share (Q2-013): which skill is open or
 * whether it is a fresh draft, its name and text, and saving it.
 */
export function useSkillEditor() {
  const { t } = useTranslation()
  // `selected` is the skill being edited; null with isNew means a fresh draft.
  const [selected, setSelected] = useState<string | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)

  /** Show a skill read from its store. */
  const show = (skillName: string, body: string) => {
    setSelected(skillName)
    setIsNew(false)
    setName(skillName)
    setContent(body)
  }

  const startNew = () => {
    setSelected(null)
    setIsNew(true)
    setName('')
    setContent(NEW_SKILL_TEMPLATE)
  }

  const close = () => {
    setSelected(null)
    setIsNew(false)
    setName('')
    setContent('')
  }

  /**
   * Save the draft through `write`; a blank name is refused with a toast.
   * `onSaved` runs after the success toast, inside the same error handling.
   */
  const save = async (
    write: (name: string, content: string) => Promise<unknown>,
    onSaved?: () => Promise<unknown>
  ) => {
    const trimmed = name.trim()
    if (!trimmed) {
      toast.error(t('common:skillNameRequired'))
      return
    }
    setSaving(true)
    try {
      await write(trimmed, content)
      setSelected(trimmed)
      setIsNew(false)
      toast.success(t('common:skillSaved'))
      await onSaved?.()
    } catch (e) {
      toast.error(String(e))
    } finally {
      setSaving(false)
    }
  }

  return {
    selected,
    isNew,
    name,
    setName,
    content,
    setContent,
    saving,
    editing: isNew || selected !== null,
    show,
    startNew,
    close,
    save,
  }
}
