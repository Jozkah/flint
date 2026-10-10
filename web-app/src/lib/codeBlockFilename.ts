/**
 * Recovering the real filename of a generated code block.
 *
 * Streamdown's download button saves every block as `file.<ext>`, whatever the
 * model called it. A model that writes out a project does name its files: in
 * the fence info string (```css styles.css) or in a leading comment
 * (`// js/main.js`). These helpers recover that name from the markdown source.
 */

export type FencedBlock = {
  /** First word of the info string. */
  language: string
  /** The rest of the info string. */
  meta: string
  code: string
}

/**
 * A plausible filename: optional directories, then a stem and a short
 * extension. Strict on purpose; anything looser matches prose like
 * "see example.com".
 */
const FILENAME_PATTERN = /^[\w@~.+-]+(?:[/\\][\w@~.+-]+)*\.[A-Za-z0-9]{1,10}$/

/** `title="x"` / `filename='x'` / `file=x` / `name=x`, quotes optional. */
const META_KEY_VALUE_PATTERN =
  /\b(?:title|filename|file|name)\s*=\s*(?:"([^"]+)"|'([^']+)'|(\S+))/i

/** Line comment openers (`//`, `#`, `--`, `;`) and block comment openers. */
const LEADING_COMMENT_PATTERN =
  /^\s*(?:\/\/+|#+|--|;+|\/\*+|<!--)\s*(.*?)\s*(?:\*\/|-->)?\s*$/

const MAX_FILE_NAME_LENGTH = 120

/** Fence language to the extensions a file of that language may carry. */
const LANGUAGE_EXTENSIONS: Record<string, string[]> = {
  javascript: ['js', 'mjs', 'cjs'],
  js: ['js', 'mjs', 'cjs'],
  jsx: ['jsx'],
  typescript: ['ts', 'mts', 'cts'],
  ts: ['ts', 'mts', 'cts'],
  tsx: ['tsx'],
  python: ['py'],
  py: ['py'],
  bash: ['sh'],
  sh: ['sh'],
  shell: ['sh'],
  html: ['html', 'htm'],
  css: ['css'],
  scss: ['scss'],
  json: ['json'],
  yaml: ['yaml', 'yml'],
  yml: ['yaml', 'yml'],
  rust: ['rs'],
  rs: ['rs'],
  go: ['go'],
  java: ['java'],
  c: ['c', 'h'],
  cpp: ['cpp', 'cc', 'cxx', 'hpp', 'h'],
  markdown: ['md'],
  md: ['md'],
  sql: ['sql'],
}

export const looksLikeFileName = (value: string): boolean =>
  FILENAME_PATTERN.test(value)

/** The extension of `name`, lowercased, without the dot (`''` when absent). */
export const fileNameExtension = (name: string): string => {
  const base = name.split(/[/\\]/).pop() ?? name
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/** Whether a guessed `name` agrees with the block's language. Unknown languages never veto. */
const matchesLanguage = (name: string, language: string): boolean => {
  const lang = language.trim().toLowerCase()
  const allowed = LANGUAGE_EXTENSIONS[lang]
  if (!allowed) return true
  return allowed.includes(fileNameExtension(name))
}

/** The filename declared in a fence info string, or `null`. */
export const parseFenceFilename = (meta?: string | null): string | null => {
  if (!meta) return null
  const keyValue = meta.match(META_KEY_VALUE_PATTERN)
  const named = keyValue?.[1] ?? keyValue?.[2] ?? keyValue?.[3]
  if (named && looksLikeFileName(named)) return named
  // A bare first token, optionally bracketed: ```js [js/main.js]
  const bare = meta.trim().split(/\s+/)[0]?.replace(/^[[(]|[\])]$/g, '')
  return bare && looksLikeFileName(bare) ? bare : null
}

/** The filename from a comment on the code's first line, or `null`. */
export const parseLeadingCommentFilename = (code: string): string | null => {
  const firstLine = code.split('\n', 1)[0]
  if (!firstLine) return null
  const comment = firstLine.match(LEADING_COMMENT_PATTERN)?.[1]
  if (!comment) return null
  // Last token, so `// File: src/main.js` works as well as `// src/main.js`.
  const candidate = comment.split(/\s+/).pop()
  return candidate && looksLikeFileName(candidate) ? candidate : null
}

/**
 * The filename for a block, or `null` when nothing trustworthy is found. A name
 * from a comment is only accepted when its extension fits the block's language.
 */
export const resolveCodeBlockFileName = (block: FencedBlock): string | null => {
  const fromFence = parseFenceFilename(block.meta)
  if (fromFence) return fromFence
  const guessed = parseLeadingCommentFilename(block.code)
  return guessed && matchesLanguage(guessed, block.language) ? guessed : null
}

/**
 * A name safe to hand to a download: the basename only, with control characters
 * and characters illegal on common filesystems removed. `null` when nothing is
 * left.
 */
export const toDownloadFileName = (raw: string): string | null => {
  const basename = raw.split(/[/\\]/).pop() ?? raw
  const cleaned = basename
    .split('')
    .map((character) => (character.charCodeAt(0) <= 31 ? ' ' : character))
    .join('')
    .replace(/[:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .trim()
  return cleaned.length > 0 ? cleaned.slice(0, MAX_FILE_NAME_LENGTH) : null
}

const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[ \t]*(.*)$/

/** The fenced code blocks of a markdown source, in order. Unclosed fences are skipped. */
export const extractFencedBlocks = (markdown: string): FencedBlock[] => {
  const blocks: FencedBlock[] = []
  const lines = markdown.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(OPEN_FENCE)
    if (!open) continue
    const fence = open[1]
    // A backtick fence's info string cannot itself contain a backtick.
    if (fence[0] === '`' && open[3].includes('`')) continue
    const body: string[] = []
    let closed = false
    for (let j = i + 1; j < lines.length; j++) {
      const close = lines[j].match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
        closed = true
        i = j
        break
      }
      body.push(lines[j])
    }
    if (!closed) break
    blocks.push({ language: open[2], meta: open[3].trim(), code: body.join('\n') })
  }
  return blocks
}

const stripWhitespace = (value: string): string => value.replace(/\s+/g, '')

/**
 * The block of `markdown` whose code is `renderedCode` (compared ignoring
 * whitespace, since the rendered text is split into lines), with the filename
 * it declares. `null` when no block matches or none names its file.
 */
export const findNamedBlock = (
  markdown: string,
  renderedCode: string
): { fileName: string; code: string } | null => {
  const target = stripWhitespace(renderedCode)
  if (!target) return null
  for (const block of extractFencedBlocks(markdown)) {
    if (stripWhitespace(block.code) !== target) continue
    const fileName = resolveCodeBlockFileName(block)
    const safe = fileName ? toDownloadFileName(fileName) : null
    return safe ? { fileName: safe, code: block.code } : null
  }
  return null
}
