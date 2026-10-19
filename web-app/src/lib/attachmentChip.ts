import type { Attachment } from '@/types/attachment'

/**
 * Whether an attachment alone is enough to send (empty prompt): media with
 * bytes, or a finished document carrying content (a large paste becomes a
 * pasted-text-N.txt chip with the text inline).
 */
export function isSendableAttachment(a: Attachment): boolean {
  if (a.processing || a.error) return false
  if (a.type === 'document') {
    return !!a.inlineContent?.trim() || !!a.id || (!!a.processed && !!a.path)
  }
  return !!a.dataUrl
}

export type ChipIcon =
  | 'image'
  | 'audio'
  | 'video'
  | 'pdf'
  | 'code'
  | 'sheet'
  | 'archive'
  | 'text'
  | 'file'

const CODE = new Set(['js', 'jsx', 'ts', 'tsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'cs', 'json', 'yaml', 'yml', 'toml', 'html', 'css', 'sh', 'ps1', 'sql', 'xml'])
const SHEET = new Set(['csv', 'tsv', 'xls', 'xlsx', 'ods'])
const ARCHIVE = new Set(['zip', 'tar', 'gz', '7z', 'rar'])
const TEXT = new Set(['txt', 'md', 'markdown', 'log', 'rtf', 'doc', 'docx'])

/** Middle-truncate a file name to `max` characters, keeping the extension. */
export function truncateMiddle(name: string, max = 28): string {
  if (name.length <= max || max < 8) return name
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 && name.length - dot <= 8 ? name.slice(dot) : ''
  const stem = name.slice(0, name.length - ext.length)
  const keep = Math.max(2, max - ext.length - 1)
  const head = Math.ceil(keep * 0.65)
  const tail = keep - head
  return `${stem.slice(0, head)}…${tail > 0 ? stem.slice(-tail) : ''}${ext}`
}

/** `1.4 MB`, `812 B`; empty for an unknown size. */
export function formatChipSize(bytes?: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`
}

export function chipIcon(
  att: Pick<Attachment, 'type' | 'fileType' | 'name'>
): ChipIcon {
  if (att.type === 'image') return 'image'
  if (att.type === 'audio') return 'audio'
  if (att.type === 'video') return 'video'
  const ext = (att.fileType || (att.name ?? '').split('.').pop() || '').toLowerCase()
  if (ext === 'pdf') return 'pdf'
  if (CODE.has(ext)) return 'code'
  if (SHEET.has(ext)) return 'sheet'
  if (ARCHIVE.has(ext)) return 'archive'
  if (TEXT.has(ext)) return 'text'
  return 'file'
}

const PASTED = /^(image|pasted-image(-\d+)?|screenshot)\.\w+$/i

/**
 * Display names: a clipboard image carries a generic blob name, so it shows as
 * "Pasted image N". Only the label changes; the attachment keeps its name.
 */
export function chipLabels(
  atts: readonly Attachment[],
  pastedLabel: (n: number) => string
): string[] {
  let n = 0
  return atts.map((a) =>
    a.type === 'image' && PASTED.test(a.name ?? '')
      ? pastedLabel(++n)
      : (a.name ?? '')
  )
}

/** An image the model cannot see: the chip warns, with remove as the action. */
export function imageNeedsVision(
  att: Pick<Attachment, 'type'>,
  canSeeImages: boolean
): boolean {
  return att.type === 'image' && !canSeeImages
}

/** How many files a drag carries, when the browser exposes it. */
export function dragFileCount(transfer: DataTransfer | null): number {
  const items = transfer?.items
  if (!items) return 0
  let n = 0
  for (const it of Array.from(items)) if (it.kind === 'file') n++
  return n
}
