import { useEffect, useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useCoworkWorktrees } from '@/hooks/useCoworkWorktrees'
import { describePending } from '@/lib/coworkWorktrees'

/**
 * The "keep or remove its worktree" question inside the delete-session
 * dialog. Keeping is the default: deleting a session never removes its branch
 * or worktree unless the user picks that here, having seen what it holds.
 */
export function SessionWorktreeDeleteChoice(props: {
  sessionId: string | null
  remove: boolean
  onChange: (remove: boolean) => void
}) {
  const { t } = useTranslation()
  const record = useCoworkWorktrees((s) =>
    props.sessionId ? s.bySession[props.sessionId] : undefined
  )
  const [loses, setLoses] = useState<string[] | null>(null)

  useEffect(() => {
    setLoses(null)
    if (!record) return
    let cancelled = false
    void (async () => {
      const store = useCoworkWorktrees.getState()
      const [pending, unmerged] = await Promise.all([
        store.pending(record),
        store.unmerged(record),
      ])
      if (!cancelled) setLoses([...pending, ...unmerged])
    })()
    return () => {
      cancelled = true
    }
  }, [record])

  if (!record) return null
  const name = record.kind === 'copy' ? record.path : record.branch
  return (
    <fieldset className="space-y-1 text-sm" data-testid="delete-worktree-choice">
      <label className="flex items-center gap-2">
        <input
          type="radio"
          checked={!props.remove}
          onChange={() => props.onChange(false)}
        />
        {t('common:coworkParallel.deleteKeep', { name })}
      </label>
      <label className="flex items-center gap-2">
        <input
          type="radio"
          checked={props.remove}
          onChange={() => props.onChange(true)}
        />
        {t('common:coworkParallel.deleteRemove', { name })}
      </label>
      {props.remove && loses && loses.length > 0 ? (
        <p className="text-destructive text-xs">
          {t('common:coworkParallel.discardLoses')} {describePending(loses)}
        </p>
      ) : null}
    </fieldset>
  )
}
