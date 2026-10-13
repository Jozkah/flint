import { ImageIcon } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { listChatImages } from '@/lib/chatImages'
import { saveChatPicturesWithToast } from '@/lib/exportImage'

/**
 * "Save pictures" for an export menu: every picture the conversation made,
 * saved as PNG files. Nothing is rendered for a conversation with no pictures.
 */
export function SaveChatPicturesItem({ threadId }: { threadId: string }) {
  const count = listChatImages(threadId).filter((p) => !p.deleted).length
  if (count === 0) return null
  return (
    <DropdownMenuItem
      data-testid="export-pictures"
      onSelect={() => {
        void saveChatPicturesWithToast(threadId)
      }}
    >
      <ImageIcon className="size-4" />
      <span>{`Save ${count} picture${count === 1 ? '' : 's'} as PNG`}</span>
    </DropdownMenuItem>
  )
}
