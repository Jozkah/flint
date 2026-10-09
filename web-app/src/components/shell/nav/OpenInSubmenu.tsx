import { AppWindow, Columns2, PanelTop } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { openInSplit, reportSplitResult } from '@/lib/splitView'
import { openChatWindow } from '@/lib/chatWindow'
import type { SplitTarget } from '@/hooks/useSplitConversation'

/** "Open in >" on a conversation row's menu: split view or a new window. */
export function OpenInSubmenu({
  target,
  testIdPrefix,
}: {
  target: SplitTarget
  testIdPrefix: string
}) {
  const { t } = useTranslation()
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-testid={`${testIdPrefix}-open-in`}>
        <PanelTop />
        <span>{t('chat:split.openIn')}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-44">
        <DropdownMenuItem
          data-testid={`${testIdPrefix}-in-split`}
          onSelect={() => reportSplitResult(openInSplit(target), t)}
        >
          <Columns2 />
          <span>{t('chat:split.label')}</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid={`${testIdPrefix}-in-window`}
          onSelect={() => void openChatWindow(target)}
        >
          <AppWindow />
          <span>{t('chat:split.openInNewWindow')}</span>
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
