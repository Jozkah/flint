/**
 * What a handed-off session could not bring with it. AH-210.
 *
 * Shown on the imported session until dismissed, item by item, in plain
 * words: the folder to attach (and, once one is attached, whether it is the
 * one the session was on), a provider not set up here, a model not offered
 * here. Nothing is resumed behind the user's back: the session is theirs to
 * continue once they have seen this.
 */
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  compareFolder,
  describeRestoreItem,
  folderIdentity,
  type FolderMatch,
  type HandoffRecord,
} from '@/lib/sessionHandoff'
import { errorText } from '@/lib/errorText'
import { useTranslation } from '@/i18n/react-i18next-compat'

export function CoworkHandoffNotice({
  handoff,
  folder,
  onDismiss,
}: {
  handoff: HandoffRecord | undefined
  /** The folder attached to the session on this machine, if any. */
  folder: string | null
  onDismiss: () => void
}) {
  const { t } = useTranslation()
  const expected = handoff?.info.folder ?? null
  const [match, setMatch] = useState<FolderMatch | { error: string } | null>(
    null
  )

  useEffect(() => {
    setMatch(null)
    if (!expected || !folder) return
    let alive = true
    folderIdentity(folder)
      .then((actual) => {
        if (alive) setMatch(compareFolder(expected, actual))
      })
      .catch((e) => {
        if (alive) setMatch({ error: errorText(e) })
      })
    return () => {
      alive = false
    }
  }, [expected, folder])

  if (!handoff || handoff.dismissed) return null
  const items = handoff.unrestored.filter(
    // Once a folder is attached, the check below replaces the request.
    (item) => !(item.kind === 'folder' && folder)
  )
  if (items.length === 0 && !(expected && folder)) return null

  return (
    <section
      className="mb-2 rounded-[10px] bg-warning-tint px-3 py-2 text-xs text-fg-2 shadow-[inset_0_0_0_0.8px_color-mix(in_oklab,var(--warning)_30%,transparent)]"
      aria-label={t('common:handoff.label')}
      data-testid="handoff-notice"
    >
      <p className="mb-1 font-medium text-foreground">
        {t('common:handoff.title')}
      </p>
      {/* The live region wraps the list: role=status on the ul took away its list semantics (CTA-030). */}
      <div role="status" aria-live="polite">
        <ul className="list-disc pl-4">
          {items.map((item, i) => (
            <li key={`${item.kind}-${i}`} data-testid={`handoff-item-${item.kind}`}>
              {describeRestoreItem(item)}
            </li>
          ))}
          {expected && folder && match && (
            <li data-testid="handoff-folder-check">
              {'error' in match
                ? t('common:handoff.checkFailed', { error: match.error })
                : match.matches
                  ? t('common:handoff.folderMatches', { name: expected.name })
                  : t('common:handoff.folderDiffers', {
                      differences: match.differences.join('; '),
                    })}
            </li>
          )}
        </ul>
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="mt-1"
        onClick={onDismiss}
        data-testid="handoff-dismiss"
      >
        {t('common:handoff.dismiss')}
      </Button>
    </section>
  )
}
