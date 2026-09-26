import { FolderIcon, FolderPlus, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { useThreads } from '@/hooks/useThreads'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { chatFoldersOf, setChatFolders } from '@/lib/chatFolders'
import { basename } from '@/lib/groups/domain'

/**
 * The chat header's folder chip: how many folders the chat's tools can read,
 * with a popover to add and remove them.
 */
export function ChatFoldersChip({ threadId }: { threadId: string }) {
  const { t } = useTranslation()
  const thread = useThreads((s) => s.threads[threadId])
  const folders = chatFoldersOf(thread)
  if (!thread) return null

  const add = async () => {
    const picked = await getServiceHub().dialog().open({ directory: true })
    const path = Array.isArray(picked) ? picked[0] : picked
    if (typeof path === 'string' && path)
      setChatFolders(threadId, [...chatFoldersOf(useThreads.getState().threads[threadId]), path])
  }
  const remove = (path: string) =>
    setChatFolders(
      threadId,
      chatFoldersOf(useThreads.getState().threads[threadId]).filter((f) => f !== path)
    )

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="chat-folders-chip"
          aria-label={t('common:groups.chatFolders')}
          title={t('common:groups.chatFolders')}
          className="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors outline-hidden hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 data-[state=open]:bg-accent"
        >
          <FolderIcon aria-hidden className="size-3.5" />
          {folders.length > 0 && (
            <span className="tabular-nums">
              {folders.length === 1
                ? basename(folders[0])
                : t('common:groups.chatFolderCount', { count: folders.length })}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-3">
        <div className="mb-1 text-sm font-medium">{t('common:groups.chatFoldersTitle')}</div>
        <p className="mb-2 text-xs text-muted-foreground">
          {t('common:groups.chatFoldersBody')}
        </p>
        {folders.length === 0 ? (
          <p className="mb-2 text-xs text-muted-foreground">
            {t('common:groups.chatFoldersEmpty')}
          </p>
        ) : (
          <ul className="mb-2 flex flex-col gap-1" data-testid="chat-folders-list">
            {folders.map((f) => (
              <li key={f} className="flex items-center gap-1.5 text-xs">
                <FolderIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono" title={f}>
                  {f}
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('common:groups.removeFolder', { name: basename(f) })}
                  onClick={() => remove(f)}
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <Button size="sm" variant="ghost" onClick={() => void add()}>
          <FolderPlus /> {t('common:groups.addFolder')}
        </Button>
      </PopoverContent>
    </Popover>
  )
}
