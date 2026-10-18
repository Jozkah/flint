import { FolderOpen, Handshake } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useObsidianVault } from '@/lib/obsidianVault'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { basenameOf } from '@/lib/coworkPreview'
import { isServedByFlint } from '@/lib/platform/utils'

type Props = {
  /** Attached project folder, or null when nothing is attached. */
  folder: string | null
  /** Loads an example into the composer. Never sends it: an example is a
   * starting point the user is expected to edit. */
  onPick: (text: string) => void
  /** Opens the folder chooser; offered while nothing is attached, so an
   * Obsidian vault (just a folder) can be added from here. */
  onAttachFolder?: () => void
  /**
   * What the session may do to the folder. The subtitle says the same thing
   * the composer's access chip does (C-010); read-only when absent.
   */
  access?: 'review-only' | 'managed-worktree' | 'edit-folder'
}

const EXAMPLE_KEYS = ['first', 'second', 'third'] as const

/**
 * The first thing a new session shows: an invitation centred in the
 * conversation frame, with a few starting points laid out as cards so each one
 * reads as something to pick up rather than a line of help text.
 *
 * The examples name the attached folder when there is one. That is the whole
 * point of them -- a fixed list of suggestions is wallpaper, but "Find every
 * TODO in jan-app" is a task you might actually run next.
 */
const SUBTITLE_FOLDER = {
  'review-only': 'common:coworkEmpty.subtitleFolder',
  'edit-folder': 'common:coworkEmpty.subtitleFolderEdit',
  'managed-worktree': 'common:coworkEmpty.subtitleFolderWorktree',
} as const

export function CoworkEmptyState({
  folder,
  onPick,
  onAttachFolder,
  access = 'review-only',
}: Props) {
  const { t } = useTranslation()
  const isVault = useObsidianVault(folder)
  const name = folder ? basenameOf(folder) : null
  const scope = name ? 'folder' : 'sandbox'

  return (
    <div className="absolute inset-0 flex overflow-y-auto px-[18px]">
      <div className="m-auto flex w-full max-w-[520px] flex-col items-center gap-2.5 py-10 text-center motion-safe:animate-rise-in">
        <Handshake className="size-9 text-muted-foreground" aria-hidden />
        <h1 className="text-[22px] font-medium tracking-[-0.01em] text-foreground">
          {t('common:coworkEmpty.title')}
        </h1>
        <p className="mb-2.5 text-[13.5px] leading-normal text-muted-foreground">
          {name
            ? t(SUBTITLE_FOLDER[access], { folder: name })
            : t('common:coworkEmpty.subtitleSandbox')}
        </p>

        {isVault && (
          <p
            data-testid="obsidian-vault-badge"
            className="mb-1 rounded-full border-[0.8px] border-border bg-card px-2.5 py-0.5 text-[11.5px] text-secondary-foreground"
            title={t('common:coworkEmpty.vault.hint')}
          >
            {t('common:coworkEmpty.vault.badge')}
          </p>
        )}
        {/* A browser picks server folders from the session bar instead. */}
        {!folder && onAttachFolder && !isServedByFlint() && (
          <Button
            variant="outline"
            size="sm"
            data-testid="cowork-add-vault"
            onClick={onAttachFolder}
            title={t('common:coworkEmpty.vault.addHint')}
          >
            <FolderOpen aria-hidden />
            {t('common:coworkEmpty.vault.add')}
          </Button>
        )}

        <p className="text-[11px] font-medium tracking-[0.025em] text-subtle-foreground uppercase">
          {t('common:coworkEmpty.try')}
        </p>
        <div className="flex w-full flex-col gap-2">
          {EXAMPLE_KEYS.map((key) => {
            const text = t(`common:coworkEmpty.${scope}.${key}`, {
              folder: name,
            })
            return (
              <button
                key={key}
                type="button"
                onClick={() => onPick(text)}
                className="w-full rounded-[10px] border-[0.8px] border-border bg-card px-3.5 py-2.5 text-left text-[13px] text-secondary-foreground outline-none transition-[box-shadow,color,transform] duration-150 ease-expo hover:-translate-y-px hover:text-foreground hover:shadow-lift focus-visible:ring-[3px] focus-visible:ring-ring/40 pointer-coarse:min-h-11"
              >
                {text}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
