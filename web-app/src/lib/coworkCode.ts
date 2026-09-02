// Pure helpers for the Cowork code workspace: language detection, source-file
// classification, tab state and prompt code references. Kept store-free and
// DOM-free, like coworkPreview.ts, so everything here is testable directly.

import { extensionOf, basenameOf, previewKindFor } from '@/lib/coworkPreview'
import type { CoworkTurn } from '@/types/coworkSession'

/** Matches the Rust backend's `MAX_READ_BYTES`: files above this are shown as
 * an oversized notice, never loaded into the renderer. */
export const MAX_CODE_FILE_BYTES = 1024 * 1024

/** Extension → Shiki bundled-language id. Anything absent renders as plaintext. */
const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'jsonc',
  rs: 'rust',
  py: 'python',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  m: 'objective-c',
  mm: 'objective-c',
  scala: 'scala',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  ps1: 'powershell',
  sql: 'sql',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  svg: 'xml',
  vue: 'vue',
  svelte: 'svelte',
  astro: 'astro',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'proto',
  lua: 'lua',
  r: 'r',
  dart: 'dart',
  zig: 'zig',
  ex: 'elixir',
  exs: 'elixir',
  hs: 'haskell',
  clj: 'clojure',
  erl: 'erlang',
  pl: 'perl',
  tf: 'hcl',
  hcl: 'hcl',
  prisma: 'prisma',
  diff: 'diff',
  patch: 'diff',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  bat: 'bat',
  cmake: 'cmake',
}

/** Extensionless-or-special file names with a well-known language. */
const NAME_LANG: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  'cmakelists.txt': 'cmake',
}

/** Text formats worth opening in the viewer even without highlighting. */
const PLAIN_TEXT_EXTS = new Set(['txt', 'text', 'log', 'csv', 'tsv', 'lock'])

export type DetectedLanguage = {
  /** Shiki bundled-language id, or `'text'` for plaintext fallback. */
  lang: string
  /** Human label for the status area, e.g. `TypeScript`. */
  label: string
}

const LANG_LABELS: Record<string, string> = {
  typescript: 'TypeScript',
  tsx: 'TSX',
  javascript: 'JavaScript',
  jsx: 'JSX',
  json: 'JSON',
  jsonc: 'JSONC',
  rust: 'Rust',
  python: 'Python',
  go: 'Go',
  java: 'Java',
  kotlin: 'Kotlin',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  ruby: 'Ruby',
  php: 'PHP',
  swift: 'Swift',
  'objective-c': 'Objective-C',
  scala: 'Scala',
  shellscript: 'Shell',
  powershell: 'PowerShell',
  sql: 'SQL',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  markdown: 'Markdown',
  yaml: 'YAML',
  toml: 'TOML',
  xml: 'XML',
  vue: 'Vue',
  svelte: 'Svelte',
  astro: 'Astro',
  graphql: 'GraphQL',
  proto: 'Protobuf',
  lua: 'Lua',
  r: 'R',
  dart: 'Dart',
  zig: 'Zig',
  elixir: 'Elixir',
  haskell: 'Haskell',
  clojure: 'Clojure',
  erlang: 'Erlang',
  perl: 'Perl',
  hcl: 'HCL',
  prisma: 'Prisma',
  diff: 'Diff',
  ini: 'INI',
  bat: 'Batch',
  cmake: 'CMake',
  dockerfile: 'Dockerfile',
  makefile: 'Makefile',
  text: 'Plain text',
}

/** Language for a path, plaintext when unknown. Extension first, then the
 * special-name table (`Dockerfile`, `Makefile`). */
export function detectLanguage(path: string): DetectedLanguage {
  const ext = extensionOf(path)
  const byExt = EXT_LANG[ext]
  if (byExt) return { lang: byExt, label: LANG_LABELS[byExt] ?? byExt }
  const byName = NAME_LANG[basenameOf(path).toLowerCase()]
  if (byName) return { lang: byName, label: LANG_LABELS[byName] ?? byName }
  return { lang: 'text', label: LANG_LABELS.text }
}

/** Would this path be at home in the code viewer? True for anything with a
 * detected language and for the plain-text formats; false for binaries and
 * unknown extensions. */
export function isSourcePath(path: string): boolean {
  const ext = extensionOf(path)
  if (EXT_LANG[ext]) return true
  if (NAME_LANG[basenameOf(path).toLowerCase()]) return true
  return PLAIN_TEXT_EXTS.has(ext)
}

/**
 * Should this path open in the Code panel instead of the preview pane?
 *
 * The preview keeps everything it *renders* — HTML, SVG and Markdown are shown
 * as pages, media streams from disk. What it cannot render it either dumps in a
 * plain `<pre>` (its `text` kind) or refuses (`file`); those are exactly the
 * paths the code viewer serves better, when they are source at all.
 */
export function shouldOpenInCode(path: string): boolean {
  const kind = previewKindFor(path)
  if (kind === 'text' || kind === 'file') return isSourcePath(path)
  return false
}

/** Display path relative to `root` when the path lives under it; otherwise the
 * path unchanged. Compared with normalized separators, case-insensitively, the
 * same way `resolveInRoot` treats containment. */
export function relativeToRoot(root: string | null, path: string): string {
  if (!root) return path
  const slash = (p: string) => p.replace(/\\/g, '/')
  const r = slash(root).replace(/\/+$/, '')
  const p = slash(path)
  if (p.toLowerCase() === r.toLowerCase()) return ''
  if (p.toLowerCase().startsWith(`${r.toLowerCase()}/`)) return p.slice(r.length + 1)
  return path
}

// ---------------------------------------------------------------------------
// Tab paths
// ---------------------------------------------------------------------------

/**
 * Tabs can show two roots: the attached project (plain relative paths) and the
 * session's writable sandbox, where agent-written source artifacts live. A
 * sandbox tab is marked with this prefix so the loader picks the right root —
 * the prefix never reaches the backend or the model.
 */
export const SANDBOX_TAB_PREFIX = 'sandbox:'

export function sandboxTabPath(rel: string): string {
  return `${SANDBOX_TAB_PREFIX}${rel}`
}

export function isSandboxTabPath(path: string): boolean {
  return path.startsWith(SANDBOX_TAB_PREFIX)
}

/** The path without its sandbox marker — what headers, tooltips, copy-path and
 * code references should show. */
export function tabDisplayPath(path: string): string {
  return isSandboxTabPath(path) ? path.slice(SANDBOX_TAB_PREFIX.length) : path
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

/**
 * How many completed `write`/`edit` calls each path has received.
 *
 * Counted rather than timestamped because a `CoworkTurn` carries no clock: the
 * panel snapshots this count when it loads a file, and any later increase means
 * the bytes on disk have moved on from the ones on screen. A running or failed
 * call is not counted — neither changed the file.
 */
export function writeCountsByPath(
  turns: CoworkTurn[] | undefined
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const turn of turns ?? []) {
    if (turn.role !== 'tool') continue
    if (turn.name !== 'write' && turn.name !== 'edit') continue
    if (turn.isError || turn.status === 'running') continue
    const args = turn.args
    if (!args || typeof args !== 'object' || !('path' in args)) continue
    const path = (args as Record<string, unknown>).path
    if (typeof path !== 'string' || !path) continue
    const key = path.replace(/\\/g, '/')
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

/**
 * Has `tabPath` been written since it was loaded, when it carried
 * `loadedCount` writes at that moment?
 *
 * The tab path may carry the sandbox marker; the tools report the plain path,
 * so the comparison is on the display form.
 */
export function isTabStale(
  tabPath: string,
  loadedCount: number | undefined,
  counts: Record<string, number>
): boolean {
  if (loadedCount == null) return false
  const key = tabDisplayPath(tabPath).replace(/\\/g, '/')
  return (counts[key] ?? 0) > loadedCount
}

// ---------------------------------------------------------------------------
// Tab state
// ---------------------------------------------------------------------------

/**
 * Code-panel state persisted per Cowork session. No dirty flag on purpose: the
 * viewer is read-only in this phase, so nothing can become dirty; the
 * open/active split already leaves room for one later.
 */
export type CodePanelState = {
  /** Project-relative paths of open tabs, in tab order. */
  openPaths: string[]
  activePath: string | null
  /** Expanded explorer directories (relative paths). Bounded in practice:
   * only directories the user actually opened are ever in here. */
  expandedDirs: string[]
  wordWrap: boolean
}

export function emptyCodePanelState(): CodePanelState {
  return { openPaths: [], activePath: null, expandedDirs: [], wordWrap: false }
}

/** Open `path`, or focus its existing tab: opening twice must not duplicate. */
export function openTab(state: CodePanelState, path: string): CodePanelState {
  if (state.openPaths.includes(path)) {
    return state.activePath === path ? state : { ...state, activePath: path }
  }
  return { ...state, openPaths: [...state.openPaths, path], activePath: path }
}

/** Close `path`. When it was active, focus its nearest surviving neighbour —
 * the tab that takes its slot, falling back leftward — or nothing when it was
 * the last. */
export function closeTab(state: CodePanelState, path: string): CodePanelState {
  const index = state.openPaths.indexOf(path)
  if (index < 0) return state
  const openPaths = state.openPaths.filter((p) => p !== path)
  let activePath = state.activePath
  if (activePath === path) {
    activePath = openPaths[Math.min(index, openPaths.length - 1)] ?? null
  }
  return { ...state, openPaths, activePath }
}

export function focusTab(state: CodePanelState, path: string): CodePanelState {
  if (!state.openPaths.includes(path) || state.activePath === path) return state
  return { ...state, activePath: path }
}

export function toggleDir(state: CodePanelState, relPath: string): CodePanelState {
  const expanded = state.expandedDirs.includes(relPath)
  return {
    ...state,
    expandedDirs: expanded
      ? state.expandedDirs.filter((p) => p !== relPath)
      : [...state.expandedDirs, relPath],
  }
}

// ---------------------------------------------------------------------------
// Code references ("Add to chat")
// ---------------------------------------------------------------------------

/** One selected span of a project file, referenced from the prompt. */
export type CodeRef = {
  /** Project-relative path. */
  path: string
  /** 1-based, inclusive. */
  startLine: number
  endLine: number
  /** The selected text, verbatim. */
  code: string
}

/** The concise, visible form: `@src/example.ts:24-48`. */
export function codeRefToken(
  ref: Pick<CodeRef, 'path' | 'startLine' | 'endLine'>
): string {
  return ref.startLine === ref.endLine
    ? `@${ref.path}:${ref.startLine}`
    : `@${ref.path}:${ref.startLine}-${ref.endLine}`
}

/** 1-based line range covered by the slice `[start, end)` of `content`. */
export function lineRangeOfSlice(
  content: string,
  start: number,
  end: number
): { startLine: number; endLine: number } {
  const clamp = (n: number) => Math.max(0, Math.min(n, content.length))
  const from = clamp(Math.min(start, end))
  const to = clamp(Math.max(start, end))
  const startLine = content.slice(0, from).split('\n').length
  // An end offset sitting right after a newline belongs to the previous line:
  // the selection contains no character of the next one.
  const before = content.slice(0, to)
  const endLine =
    before.split('\n').length - (to > from && before.endsWith('\n') ? 1 : 0)
  return { startLine, endLine: Math.max(startLine, endLine) }
}

/** The structured block appended to the model's copy of the prompt. */
export function codeRefBlock(ref: CodeRef): string {
  const lang = detectLanguage(ref.path).lang
  const range =
    ref.startLine === ref.endLine
      ? `line ${ref.startLine}`
      : `lines ${ref.startLine}-${ref.endLine}`
  return [
    `Referenced code from the attached project — ${ref.path} (${range}):`,
    '```' + (lang === 'text' ? '' : lang),
    ref.code.replace(/\n$/, ''),
    '```',
  ].join('\n')
}

/**
 * The model's copy of a prompt containing code-reference tokens: the text as
 * typed, then one structured block per reference whose token survived editing.
 * References whose token the user deleted are dropped — they would reference
 * nothing visible.
 */
export function expandCodeRefs(text: string, refs: CodeRef[]): string {
  const surviving = refs.filter((ref) => text.includes(codeRefToken(ref)))
  if (surviving.length === 0) return text
  return [text, '', ...surviving.map(codeRefBlock)].join('\n')
}
