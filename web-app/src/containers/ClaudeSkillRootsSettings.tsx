import { useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { OctagonAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { addRoot, removeRoot, type RootRejection } from '@/lib/claudeSkillRoots'

/**
 * Choosing which of your own folders Jan may read Claude skills from.
 *
 * The list arrives through the native directory picker, one folder at a time.
 * There is deliberately no text field: a path someone can type is a path
 * something else can suggest, and the one property that makes this safe is
 * that every entry was chosen by the person sitting there. A repository can
 * never add one.
 *
 * Approving a folder grants nothing beyond reading it. Jan parses `SKILL.md`
 * and the resources beside it; a script bundled in a skill is listed, never
 * run. That is said here, next to the button, rather than in documentation
 * nobody opens.
 */
export function ClaudeSkillRootsSettings({
  roots,
  onChange,
  pickFolder,
  confirmDirectory,
  janData,
  discovered,
  onRescan,
}: {
  roots: readonly string[]
  onChange: (roots: string[]) => void
  pickFolder: () => Promise<string | null>
  /** Asks the backend whether a picked path is a directory that exists. */
  confirmDirectory: (path: string) => Promise<boolean>
  janData?: string | null
  /** What the last scan found under each root, when a scan has run. */
  discovered?: Record<string, { skills: string[]; error?: string }>
  onRescan?: () => void
}) {
  const { t } = useTranslation()
  const [rejected, setRejected] = useState<RootRejection | null>(null)
  const [busy, setBusy] = useState(false)

  const add = async () => {
    setRejected(null)
    setBusy(true)
    try {
      const picked = await pickFolder()
      // Cancelling the picker is not a failure and says nothing.
      if (!picked) return
      const exists = await confirmDirectory(picked)
      const result = addRoot(roots, picked, { janData, exists })
      if (result.rejected) setRejected(result.rejected)
      else onChange(result.roots)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      aria-label={t('common:claudeCompat.roots.title')}
      data-testid="claude-skill-roots"
      className="flex flex-col gap-2 text-xs"
    >
      <header className="flex flex-col gap-0.5">
        <h3 className="font-medium text-foreground">
          {t('common:claudeCompat.roots.title')}
        </h3>
        <p className="text-muted-foreground">
          {t('common:claudeCompat.roots.description')}
        </p>
      </header>

      {roots.length === 0 ? (
        <p className="text-ink-2">
          {t('common:claudeCompat.roots.none')}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {roots.map((root) => {
            const found = discovered?.[root]
            return (
              <li key={root} className="flex items-start justify-between gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-foreground">
                    {root}
                  </span>
                  <span className="block text-muted-foreground">
                    {found?.error
                      ? `${t('common:claudeCompat.roots.unreadable')}: ${found.error}`
                      : found
                        ? found.skills.length > 0
                          ? `${t('common:claudeCompat.roots.discovered')}: ${found.skills.join(', ')}`
                          : t('common:claudeCompat.roots.noneFound')
                        : null}
                  </span>
                </span>
                {/* Withdrawing affects the next run. A run already going keeps
                    the manifest it froze. */}
                <Button
                  size="sm"
                  variant="link"
                  className="h-auto shrink-0 p-0 text-xs"
                  onClick={() => onChange(removeRoot(roots, root))}
                >
                  {t('common:claudeCompat.roots.remove')}
                </Button>
              </li>
            )
          })}
        </ul>
      )}

      {rejected ? (
        <p role="alert" className="flex items-start gap-1.5 text-destructive">
          <OctagonAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          {t(`common:claudeCompat.roots.reject.${rejected}`)}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          className="pointer-coarse:h-11"
          disabled={busy}
          onClick={() => void add()}
        >
          {t('common:claudeCompat.roots.add')}
        </Button>
        {onRescan ? (
          <Button size="sm" variant="link" onClick={onRescan}>
            {t('common:claudeCompat.roots.rescan')}
          </Button>
        ) : null}
      </div>
    </section>
  )
}
