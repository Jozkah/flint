import { useState } from 'react'
import {
  Check,
  ChevronDown,
  FolderLock,
  FolderPen,
  GitBranch,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  ACCESS_MODES,
  accessDescriptionKey,
  accessLabelKey,
  type AccessMode,
  type EffectiveAccess,
} from '@/lib/coworkAccess'
import type { CapabilityState } from '@/hooks/useDirectEditGrants'
import type { WorkKind } from '@/hooks/useCoworkActiveWork'

/**
 * Where this session's changes go — the choice that "Autonomous" used to
 * answer by accident.
 *
 * The selector reports what is *in force*, not what was last preferred. A
 * session that remembers "edit this folder" but holds no live grant shows
 * Review only, because that is what would actually happen if the agent tried
 * to write. Choosing the editing mode opens a confirmation rather than
 * switching: the switch happens after the backend has issued a grant, never
 * before, so the control cannot promise access that does not exist.
 */

const ICONS: Record<AccessMode, typeof FolderLock> = {
  'review-only': FolderLock,
  'managed-worktree': GitBranch,
  'edit-folder': FolderPen,
}

export type AccessSelectorProps = {
  /** What is in force, including any downgrade from the stored preference. */
  effective: EffectiveAccess
  capability: CapabilityState
  /** False when there is no folder to edit. */
  hasFolder: boolean
  /**
   * Work is running, so authority must not change underneath it. The selector
   * says why rather than silently refusing.
   */
  busyReason?: WorkKind | null
  /** Opens the confirmation. Selecting is not confirming. */
  onRequestDirectEdit: () => void
  /**
   * Creates or finds the worktree and authorizes it.
   *
   * No separate confirmation: unlike direct editing, this cannot alter the
   * user's checkout, so there is nothing to warn about that the mode's own
   * description does not already say.
   */
  onRequestWorktree: () => void
  /** Revokes first, then downgrades — the caller owns that ordering. */
  onReviewOnly: () => void
}

/** Why an option cannot be chosen, or null when it can. */
function blockedReason(
  option: AccessMode,
  props: AccessSelectorProps
): string | null {
  if (props.busyReason) return `common:coworkAccess.busy.${props.busyReason}`
  if (option === 'review-only') return null
  if (!props.hasFolder) return 'common:coworkAccess.needsFolder'
  if (!props.capability.known) {
    return props.capability.reason === 'failed'
      ? 'common:coworkAccess.capabilityFailed'
      : 'common:coworkAccess.capabilityLoading'
  }
  // Each write mode asks its own question: on Windows a Flint-owned worktree can
  // be confined while the user's own folder cannot.
  const supported =
    option === 'managed-worktree'
      ? props.capability.managedWorktree
      : props.capability.directEdit
  if (!supported) {
    return 'common:coworkAccess.unsupportedPlatform'
  }
  return null
}

export function CoworkAccessSelector(props: AccessSelectorProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const active = props.effective.access
  const Icon = ICONS[active]

  const choose = (option: AccessMode) => {
    if (blockedReason(option, props)) return
    setOpen(false)
    if (option === 'edit-folder') props.onRequestDirectEdit()
    else if (option === 'managed-worktree') props.onRequestWorktree()
    else if (option === 'review-only') props.onReviewOnly()
  }

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="xs"
            aria-label={t('common:coworkAccess.label')}
            className={cn(
              // 30px, the height of every context control in the top header.
              'h-[30px] shrink-0 gap-1.5 px-2.5 text-xs font-medium pointer-coarse:h-11',
              // Editing the user's own checkout is the state worth noticing.
              active === 'edit-folder'
                ? 'border-warning/35 bg-warning-tint text-warning'
                : 'text-secondary-foreground'
            )}
          >
            <Icon aria-hidden className="size-3.5 shrink-0" />
            <span>{t(accessLabelKey(active))}</span>
            <ChevronDown
              aria-hidden
              className="size-3 shrink-0 text-muted-foreground"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[340px] p-1.5">
          <DropdownMenuLabel>
            {t('common:coworkAccess.label')}
          </DropdownMenuLabel>
          {ACCESS_MODES.map((option) => {
            const OptionIcon = ICONS[option]
            const blocked = blockedReason(option, props)
            return (
              <DropdownMenuItem
                key={option}
                role="menuitemradio"
                aria-checked={option === active}
                aria-disabled={blocked != null}
                disabled={blocked != null}
                onSelect={(event) => {
                  // Keep the menu open when the choice cannot be made, so the
                  // reason stays on screen instead of flashing past.
                  if (blocked) event.preventDefault()
                  else choose(option)
                }}
                className={cn(
                  'items-start gap-2.5 px-2.5 py-2',
                  option === active && 'bg-accent'
                )}
              >
                <OptionIcon
                  aria-hidden
                  className={cn(
                    'mt-px size-4 shrink-0',
                    option === 'edit-folder'
                      ? 'text-warning'
                      : 'text-secondary-foreground'
                  )}
                />
                <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                  <span className="text-[13px] font-medium">
                    {t(accessLabelKey(option))}
                  </span>
                  <span className="text-xs leading-[1.4] text-muted-foreground">
                    {t(accessDescriptionKey(option))}
                  </span>
                  {blocked && (
                    <span className="text-xs leading-[1.4] text-subtle-foreground">
                      {t(blocked)}
                    </span>
                  )}
                </span>
                {option === active ? (
                  <Check
                    aria-hidden
                    className="size-4 shrink-0 text-foreground"
                  />
                ) : null}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* The stored preference is not in force. Saying which, and why, is the
          difference between a downgrade and a silent lie. */}
      <span aria-live="polite" className="sr-only">
        {props.effective.downgradedFrom && props.effective.reason
          ? t(`common:coworkAccess.downgrade.${props.effective.reason}`)
          : t(accessLabelKey(active))}
      </span>
    </>
  )
}
