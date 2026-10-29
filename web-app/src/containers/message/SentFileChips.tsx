import { Paperclip } from 'lucide-react'
import type { FileMetadata } from '@/lib/fileMetadata'
import { displayNameOf } from '@/lib/displayName'
import { formatChipSize } from '@/lib/attachmentChip'
import {
  FilePreviewPopover,
  previewLoader,
  sentAttachment,
  viewerSpec,
} from '@/containers/FilePreviewPopover'

/** The files a user sent with a message, each opening its preview. */
export function SentFileChips({
  files,
  metadata,
}: {
  files: FileMetadata[]
  metadata: Record<string, unknown> | undefined
}) {
  return (
    <div className="flex flex-wrap gap-2 mb-2">
      {files.map((file, idx) => {
        const sent = sentAttachment(file, metadata)
        return (
          <div
            key={`file-${idx}-${file.id}`}
            data-testid="sent-file-chip"
            className="flex min-w-0 max-w-full items-center rounded-md bg-card text-foreground border-[0.8px] border-border text-xs"
          >
            <FilePreviewPopover
              name={file.name}
              meta={formatChipSize(file.size)}
              load={previewLoader(sent)}
              viewer={viewerSpec(sent)}
              className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-start focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
            >
              <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate font-medium">
                {displayNameOf(file.name)}
              </span>
              {file.injectionMode && (
                <span className="text-muted-foreground">
                  ({file.injectionMode})
                </span>
              )}
            </FilePreviewPopover>
          </div>
        )
      })}
    </div>
  )
}
