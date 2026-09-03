/**
 * What may be attached to a message, and why not.
 *
 * Two rules shape this. First, extension beats MIME: a desktop drag routinely
 * arrives with an empty or generic `application/octet-stream` type, so
 * trusting MIME alone rejects perfectly ordinary files. Second, a text or code
 * file has nothing to do with whether the model can see pictures — those were
 * conflated, which is how attaching a `.json` came to be refused by a model
 * that reads text all day.
 *
 * Nothing here ever hands raw bytes to a model: text and code are decoded to
 * text, documents go through the local parser, and only images travel as
 * encoded data, and then only to a model that can accept them.
 */

export type AttachmentKind =
  /** Plain text and data formats: read directly. */
  | 'text'
  /** Source code: read directly, highlighted where shown. */
  | 'code'
  /** PDF/DOCX/PPTX/XLSX: extracted locally by the existing parser. */
  | 'document'
  | 'image'
  | 'audio'
  | 'video'

export type ModelCapabilities = {
  vision?: boolean
  audio?: boolean
  video?: boolean
}

export type AttachmentLimits = {
  /** Per file. */
  maxBytes: number
  /** Per draft. */
  maxCount: number
}

export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
  maxBytes: 20 * 1024 * 1024,
  maxCount: 10,
}

/** Extension to kind. The list is the contract; MIME only breaks ties. */
const EXTENSIONS: Record<string, AttachmentKind> = {}
const register = (kind: AttachmentKind, exts: string[]) => {
  for (const ext of exts) EXTENSIONS[ext] = kind
}

register('text', [
  'txt', 'md', 'markdown', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'xml',
  'csv', 'tsv', 'log', 'diff', 'patch', 'ini', 'env', 'properties', 'rst',
])
register('code', [
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'css', 'scss', 'less', 'html',
  'vue', 'svelte', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h',
  'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'fish', 'sql', 'r',
  'lua', 'pl', 'ex', 'exs', 'erl', 'hs', 'scala', 'dart', 'm', 'mm', 'zig',
  'gradle', 'cmake', 'dockerfile', 'makefile', 'graphql', 'proto',
])
register('document', ['pdf', 'docx', 'pptx', 'xlsx'])
register('image', ['png', 'jpg', 'jpeg', 'webp', 'gif'])
register('audio', ['mp3', 'wav', 'm4a', 'ogg', 'flac'])
register('video', ['mp4', 'webm', 'mov', 'mkv'])

/** MIME prefixes, used only when the extension says nothing. */
const MIME_KINDS: [RegExp, AttachmentKind][] = [
  [/^text\//, 'text'],
  [/^image\//, 'image'],
  [/^audio\//, 'audio'],
  [/^video\//, 'video'],
  [/^application\/(json|xml|yaml|x-yaml|toml)/, 'text'],
  [/^application\/pdf/, 'document'],
  [/officedocument|msword|ms-excel|ms-powerpoint/, 'document'],
]

/** A MIME type too vague to classify by, which desktop drops often supply. */
const GENERIC_MIME = /^(application\/octet-stream)?$/i

export const extensionOf = (name: string): string => {
  const base = name.toLowerCase().split(/[\\/]/).pop() ?? ''
  // `Makefile` and `Dockerfile` carry their name as their type.
  if (!base.includes('.')) return base
  return base.split('.').pop() ?? ''
}

/**
 * The kind of file this is, or null when nothing recognises it.
 *
 * Extension first: it survives the desktop drag path, where MIME frequently
 * does not.
 */
export function classifyAttachment(input: {
  name: string
  mimeType?: string
}): AttachmentKind | null {
  const byExtension = EXTENSIONS[extensionOf(input.name)]
  if (byExtension) return byExtension

  const mime = (input.mimeType ?? '').toLowerCase()
  if (GENERIC_MIME.test(mime)) return null
  for (const [pattern, kind] of MIME_KINDS) {
    if (pattern.test(mime)) return kind
  }
  return null
}

/** Kinds read as text, so they need nothing of the model but a context window. */
export const isTextual = (kind: AttachmentKind): boolean =>
  kind === 'text' || kind === 'code'

export type RejectionReason =
  | 'unsupported'
  | 'too-large'
  | 'duplicate'
  | 'too-many'
  | 'needs-vision'
  | 'needs-audio'
  | 'needs-video'
  | 'parser-unavailable'
  | 'empty'

export type AttachmentDecision =
  | { ok: true; kind: AttachmentKind }
  | { ok: false; reason: RejectionReason; kind?: AttachmentKind }

export type ValidationContext = {
  capabilities: ModelCapabilities
  limits?: AttachmentLimits
  /** Names already attached to this draft, for de-duplication. */
  existingNames?: readonly string[]
  /** The local document parser is available. */
  parserAvailable?: boolean
}

/**
 * Whether this file can be attached right now.
 *
 * Ordering is deliberate: cheap structural facts first, then capability, so a
 * file that is both too large and unreadable is reported as too large — the
 * thing the user can act on.
 */
export function validateAttachment(
  file: { name: string; size: number; type?: string },
  context: ValidationContext
): AttachmentDecision {
  const limits = context.limits ?? DEFAULT_ATTACHMENT_LIMITS

  if ((context.existingNames?.length ?? 0) >= limits.maxCount) {
    return { ok: false, reason: 'too-many' }
  }
  if (context.existingNames?.includes(file.name)) {
    return { ok: false, reason: 'duplicate' }
  }
  if (file.size === 0) return { ok: false, reason: 'empty' }
  if (file.size > limits.maxBytes) return { ok: false, reason: 'too-large' }

  const kind = classifyAttachment({ name: file.name, mimeType: file.type })
  if (!kind) return { ok: false, reason: 'unsupported' }

  // Text and code need nothing of the model: they are just words.
  if (isTextual(kind)) return { ok: true, kind }

  if (kind === 'document') {
    return context.parserAvailable === false
      ? { ok: false, reason: 'parser-unavailable', kind }
      : { ok: true, kind }
  }

  if (kind === 'image' && !context.capabilities.vision)
    return { ok: false, reason: 'needs-vision', kind }
  if (kind === 'audio' && !context.capabilities.audio)
    return { ok: false, reason: 'needs-audio', kind }
  if (kind === 'video' && !context.capabilities.video)
    return { ok: false, reason: 'needs-video', kind }

  return { ok: true, kind }
}

/** The i18n key describing a rejection, so the message can be specific. */
export const reasonMessageKey = (reason: RejectionReason): string =>
  `common:attachFiles.reject.${reason}`

/** Everything the picker should offer, as an `accept` attribute. */
export function acceptAttribute(capabilities: ModelCapabilities): string {
  const kinds: AttachmentKind[] = ['text', 'code', 'document']
  if (capabilities.vision) kinds.push('image')
  if (capabilities.audio) kinds.push('audio')
  if (capabilities.video) kinds.push('video')
  const allowed = new Set(kinds)
  return Object.entries(EXTENSIONS)
    .filter(([, kind]) => allowed.has(kind))
    .map(([ext]) => `.${ext}`)
    .sort()
    .join(',')
}
