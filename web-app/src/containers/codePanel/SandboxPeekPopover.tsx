import { Check, CopyCheck, FileSymlink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HunkPopover } from '@/containers/CodeGitOverlays'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { ChangeHunk } from '@/lib/codeGutter'

/** What the sandbox peek says under its header, if anything. */
export type PeekNote =
  | null
  | 'confirm-whole'
  | 'conflict'
  | 'dirty'
  | 'applied'
  | { error: string }

type Props = {
  hunk: ChangeHunk
  /** The real file the sandbox change would land in. */
  path: string
  note: PeekNote
  /** Absent hides Apply change. */
  onApplyHunk?: () => void
  onOpenCopy: () => void
  /** Absent hides Apply whole file. */
  onApplyWhole?: () => void
  onNote: (note: PeekNote) => void
  onClose: () => void
}

/** The peek over one change a Review only run made in its sandbox copy. */
export function SandboxPeekPopover({
  hunk,
  path,
  note,
  onApplyHunk,
  onOpenCopy,
  onApplyWhole,
  onNote,
  onClose,
}: Props): React.ReactElement {
  const { t } = useTranslation()
  return (
    <HunkPopover
      hunk={hunk}
      title={t('common:codePanel.sandboxChange', { line: hunk.start })}
      onClose={onClose}
      actions={[
        ...(onApplyHunk
          ? [
              {
                label: t('common:codePanel.applyHunk'),
                icon: <Check className="size-3" />,
                onSelect: onApplyHunk,
                testId: 'peek-apply-hunk',
              },
            ]
          : []),
        {
          label: t('common:codePanel.openSandboxCopy'),
          icon: <FileSymlink className="size-3" />,
          onSelect: onOpenCopy,
          testId: 'peek-open-sandbox-copy',
        },
        ...(onApplyWhole
          ? [
              {
                label: t('common:codePanel.applyWholeFile'),
                icon: <CopyCheck className="size-3" />,
                onSelect: () => onNote('confirm-whole'),
                testId: 'peek-apply-whole',
              },
            ]
          : []),
      ]}
      note={
        note === 'confirm-whole' ? (
          <span className="flex flex-wrap items-center gap-2">
            {t('common:codePanel.applyWholeConfirm', { path })}
            <Button
              size="xs"
              variant="outline"
              data-testid="peek-apply-whole-confirm"
              onClick={() => {
                onApplyWhole?.()
                onClose()
              }}
            >
              {t('common:changes.applyReplace')}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => onNote(null)}>
              {t('common:cancel')}
            </Button>
          </span>
        ) : note === 'conflict' ? (
          t('common:codePanel.hunkConflict')
        ) : note === 'dirty' ? (
          t('common:codePanel.hunkDirty')
        ) : note && typeof note === 'object' ? (
          t('common:changes.applyFailed', { message: note.error })
        ) : null
      }
    />
  )
}
