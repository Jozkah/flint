import type { Attachment } from '@/types/attachment'

/** The draft entry an image being ingested is: by content when known, else by name. */
export const sameImage =
  (img: Attachment) =>
  (a: Attachment): boolean =>
    a.type === 'image' &&
    (img.contentHash ? a.contentHash === img.contentHash : a.name === img.name)

/**
 * Ingest images one after another. Each chip shows as processing while its
 * upload runs, gets the backend id when it lands, and is taken off the draft
 * when it fails (the caller is told, to say so). One failure does not stop
 * the rest.
 */
export async function ingestImagesInOrder(
  images: Attachment[],
  {
    ingest,
    update,
    onFailed,
  }: {
    ingest: (img: Attachment) => Promise<{ id?: string } | null | undefined>
    update: (fn: (prev: Attachment[]) => Attachment[]) => void
    onFailed: (img: Attachment, error: unknown) => void
  }
): Promise<void> {
  for (const img of images) {
    const match = sameImage(img)
    try {
      update((prev) => prev.map((a) => (match(a) ? { ...a, processing: true } : a)))
      const result = await ingest(img)
      if (!result?.id) throw new Error('No ID returned from image ingestion')
      const id = result.id
      update((prev) =>
        prev.map((a) =>
          match(a) ? { ...a, processing: false, processed: true, id } : a
        )
      )
    } catch (error) {
      console.error('Failed to ingest image:', error)
      update((prev) => prev.filter((a) => !match(a)))
      onFailed(img, error)
    }
  }
}
