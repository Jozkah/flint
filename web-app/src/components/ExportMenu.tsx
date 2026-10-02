/**
 * Export entries for a dropdown menu, shared by the thread row, the thread
 * header, the Cowork row and the per-message menu so each offers the same
 * formats. `build` is called when an entry is chosen, not on render, so a long
 * conversation is only turned into a document when someone asks for it.
 */
import type { ReactNode } from 'react'
import { Download } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { EXPORT_CHOICES, runExport, type BuildDoc } from '@/lib/exportAction'

/** The format entries on their own, for a menu that already has its heading. */
export function ExportItems({
  build,
  versions = false,
  extra,
}: {
  build: BuildDoc
  /** Offer the "all versions" entries; for a chat, which can have them. */
  versions?: boolean
  /** Further entries after the formats (a Cowork row's importable bundle). */
  extra?: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <>
      {EXPORT_CHOICES.filter((c) => versions || !c.allVersions).map((choice) => (
        <DropdownMenuItem
          key={choice.id}
          data-testid={`export-${choice.id}`}
          onSelect={() => {
            void runExport(build, choice, t)
          }}
        >
          <span>{t(choice.labelKey)}</span>
        </DropdownMenuItem>
      ))}
      {extra ? (
        <>
          <DropdownMenuSeparator />
          {extra}
        </>
      ) : null}
    </>
  )
}

/** "Export" with the formats in a submenu. */
export function ExportSubmenu({
  build,
  versions = false,
  extra,
}: {
  build: BuildDoc
  versions?: boolean
  extra?: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="gap-2" data-testid="export-submenu">
        <Download className="size-4" />
        <span>{t('common:export.menu')}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <ExportItems build={build} versions={versions} extra={extra} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
