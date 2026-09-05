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
// File origins and tab identity
// ---------------------------------------------------------------------------

/**
 * Where a file lives, and therefore what may be done with it.
 *
 * Explicit rather than inferred: a readable path is NOT evidence that it
 * belongs to the attached project. A sandbox file, a generated artifact and an
 * external read-only file are all readable, and treating any of them as
 * project-owned would claim a write capability the app does not have and would
 * label the wrong workspace to the model.
 */
export type FileOrigin =
  /** Inside the attached project. Read-only in Cowork today. */
  | { kind: 'project'; projectKey: string }
  /** Inside one session's writable sandbox. */
  | { kind: 'sandbox'; sessionKey: string }
  /** A file the agent generated, which lives in that session's sandbox. */
  | { kind: 'artifact'; sessionKey: string }
  /**
   * Readable, but outside every root. Always read-only.
   *
   * Session-scoped like the sandbox origins: a file dropped into one session
   * is that session's, and must not appear in the next one. The key is absent
   * on tabs persisted before external files could be opened.
   */
  | { kind: 'external'; sessionKey?: string }

/**
 * The identity a tab is scoped to: the project for a project file, the session
 * for anything in a sandbox.
 *
 * Sandbox paths are relative to a per-session directory, so the same
 * `out.ts` exists in every session. Without the session in the identity, two
 * sessions' tabs share a cache key and one session's bytes can be shown under
 * the other.
 */
export function originScope(origin: FileOrigin): string {
  switch (origin.kind) {
    case 'project':
      // Persisted tabs predate these fields, and a migration has to be able to
      // identify a tab it has not stamped yet. The `?? ''` covers that case;
      // the types hold everywhere else.
      return origin.projectKey ?? ''
    case 'sandbox':
    case 'artifact':
      return origin.sessionKey ?? ''
    case 'external':
      return origin.sessionKey ?? ''
  }
}

/** Nothing in Cowork may write through the code surface; the project itself is
 * mounted read-only and the other origins are not ours to edit. Kept as a
 * function so a future writable origin is a compile error here, not a silent
 * capability change. */
export function isWritableOrigin(origin: FileOrigin): boolean {
  switch (origin.kind) {
    // The project is mounted read-only; the rest are not ours to edit. Listing
    // every case means a new origin is a compile error here rather than a
    // silent write capability.
    case 'project':
    case 'sandbox':
    case 'artifact':
    case 'external':
      return false
  }
}

/**
 * Stable identity for an attached project.
 *
 * Derived from the folder path, normalized the way containment is checked
 * (separators unified, trailing slash dropped, case folded) so the same folder
 * always produces the same key on macOS and Windows alike. It is an identity,
 * not a path: never use it to read a file.
 */
export function projectKeyOf(folder: string | null | undefined): string | null {
  if (!folder) return null
  const normalized = folder.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized ? normalized.toLowerCase() : null
}

/** One open file in the code panel. */
export type CodeTab = {
  /** Path relative to the origin's own root, `/`-separated. */
  path: string
  origin: FileOrigin
}

/**
 * Stable id for a tab, unique across origins and projects.
 *
 * Two projects can both contain `src/index.ts`; without the project key in the
 * id, switching projects would silently retarget the open tab at a different
 * file of the same name.
 */
export function tabId(tab: CodeTab): string {
  return `${tab.origin.kind}:${originScope(tab.origin)}:${tab.path}`
}

export const projectTab = (path: string, projectKey: string): CodeTab => ({
  path,
  origin: { kind: 'project', projectKey },
})

export const sandboxTab = (path: string, sessionKey: string): CodeTab => ({
  path,
  origin: { kind: 'sandbox', sessionKey },
})

export const artifactTab = (path: string, sessionKey: string): CodeTab => ({
  path,
  origin: { kind: 'artifact', sessionKey },
})

/**
 * A file opened from outside every root — dropped in, or chosen from the
 * picker. Read-only, and scoped to the session it was opened in.
 */
export const externalTab = (path: string, sessionKey: string): CodeTab => ({
  path,
  origin: { kind: 'external', sessionKey },
})

/**
 * Does this tab belong to `sessionKey`?
 *
 * Project and external tabs are not session-scoped; a sandbox or artifact tab
 * is, and must never be rendered or read under another session.
 */
export function tabBelongsToSession(
  tab: CodeTab,
  sessionKey: string | null
): boolean {
  const origin = tab.origin
  switch (origin.kind) {
    case 'project':
      // Not session-scoped: a project file is the same file in every session.
      return true
    case 'sandbox':
    case 'artifact':
      return origin.sessionKey === sessionKey
    case 'external':
      // Tabs persisted before external files carried a session are shown
      // rather than hidden; anything stamped since belongs to its session.
      return origin.sessionKey === undefined || origin.sessionKey === sessionKey
  }
}

/** Does this tab belong to the project currently attached? */
export function tabBelongsToProject(
  tab: CodeTab,
  projectKey: string | null
): boolean {
  return tab.origin.kind !== 'project' || tab.origin.projectKey === projectKey
}

/** The path shown in headers, tooltips, copy-path and code references. */
export function tabDisplayPath(tab: CodeTab): string {
  return tab.path
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
 * Has `tab` been written since it was loaded, when it carried `loadedCount`
 * writes at that moment?
 *
 * Only a project or sandbox file can go stale from a tool call; the tools
 * report a plain path, which is what the tab stores.
 */
export function isTabStale(
  tab: CodeTab,
  loadedCount: number | undefined,
  counts: Record<string, number>
): boolean {
  if (loadedCount == null) return false
  const key = tab.path.replace(/\\/g, '/')
  return (counts[key] ?? 0) > loadedCount
}

// ---------------------------------------------------------------------------
// Tab state
// ---------------------------------------------------------------------------

/**
 * Code-panel state persisted per Cowork session. No dirty flag on purpose: the
 * viewer is read-only, so nothing can become dirty; the open/active split
 * already leaves room for one later.
 */
export type CodePanelState = {
  /** Open tabs, in tab order. */
  tabs: CodeTab[]
  /** `tabId` of the active tab. */
  activeTabId: string | null
  /** Expanded explorer directories (project-relative). Bounded in practice:
   * only directories the user actually opened are ever in here. */
  expandedDirs: string[]
  wordWrap: boolean
}

export function emptyCodePanelState(): CodePanelState {
  return { tabs: [], activeTabId: null, expandedDirs: [], wordWrap: false }
}

export function findTab(
  state: CodePanelState,
  id: string | null
): CodeTab | undefined {
  return id == null ? undefined : state.tabs.find((t) => tabId(t) === id)
}

/** The active tab, if it is still open. */
export function activeTab(state: CodePanelState): CodeTab | undefined {
  return findTab(state, state.activeTabId)
}

/** Open `tab`, or focus it when already open: opening twice must not duplicate. */
export function openTab(state: CodePanelState, tab: CodeTab): CodePanelState {
  const id = tabId(tab)
  if (state.tabs.some((t) => tabId(t) === id)) {
    return state.activeTabId === id ? state : { ...state, activeTabId: id }
  }
  return { ...state, tabs: [...state.tabs, tab], activeTabId: id }
}

/** Close one tab. When it was active, focus the tab that takes its slot,
 * falling back leftward — or nothing when it was the last. */
export function closeTab(state: CodePanelState, id: string): CodePanelState {
  const index = state.tabs.findIndex((t) => tabId(t) === id)
  if (index < 0) return state
  const tabs = state.tabs.filter((t) => tabId(t) !== id)
  let activeTabId = state.activeTabId
  if (activeTabId === id) {
    const next = tabs[Math.min(index, tabs.length - 1)]
    activeTabId = next ? tabId(next) : null
  }
  return { ...state, tabs, activeTabId }
}

/** Close every tab except `id`, which becomes active. */
export function closeOtherTabs(
  state: CodePanelState,
  id: string
): CodePanelState {
  const keep = findTab(state, id)
  if (!keep) return state
  return { ...state, tabs: [keep], activeTabId: id }
}

export function closeAllTabs(state: CodePanelState): CodePanelState {
  if (state.tabs.length === 0) return state
  return { ...state, tabs: [], activeTabId: null }
}

export function focusTab(state: CodePanelState, id: string): CodePanelState {
  if (!state.tabs.some((t) => tabId(t) === id)) return state
  return state.activeTabId === id ? state : { ...state, activeTabId: id }
}

/** The tab before/after the active one, for keyboard switching. */
export function neighbourTabId(
  state: CodePanelState,
  step: 1 | -1
): string | null {
  if (state.tabs.length === 0) return null
  const index = state.tabs.findIndex((t) => tabId(t) === state.activeTabId)
  const from = index < 0 ? 0 : index
  const next = (from + step + state.tabs.length) % state.tabs.length
  return tabId(state.tabs[next])
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

/**
 * Drop every tab belonging to a project other than `projectKey`, and the
 * explorer expansion with them.
 *
 * Called whenever the attached folder changes, including detach
 * (`projectKey === null`). A project tab is only meaningful against the project
 * it came from: keeping it would either show project A's file while B is
 * attached, or silently re-resolve A's relative path inside B. Sandbox and
 * artifact tabs are unaffected — they belong to the session, not the project.
 */
export function pruneTabsForProject(
  state: CodePanelState,
  projectKey: string | null
): CodePanelState {
  const tabs = state.tabs.filter((t) => tabBelongsToProject(t, projectKey))
  if (tabs.length === state.tabs.length && state.expandedDirs.length === 0) {
    return state
  }
  const stillOpen = tabs.some((t) => tabId(t) === state.activeTabId)
  return {
    ...state,
    tabs,
    activeTabId: stillOpen ? state.activeTabId : (tabs[0] ? tabId(tabs[0]) : null),
    // The tree belongs to the project that is going away.
    expandedDirs: [],
  }
}

// ---------------------------------------------------------------------------
// Code references ("Add to chat")
// ---------------------------------------------------------------------------

/**
 * One selected span of a file, referenced from the prompt.
 *
 * `origin` travels with it: the model is told whether the span came from the
 * attached project, the session sandbox, a generated artifact or an external
 * read-only file, and never has to infer ownership from the path.
 */
export type CodeRef = {
  /** Path relative to the origin's root. */
  path: string
  /** Where the file lives, and therefore whether it is the user's project. */
  origin: FileOrigin
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
/** How an origin is described to the model, so it never mistakes a sandbox or
 * external file for the user's own project. */
export function originLabel(origin: FileOrigin): string {
  switch (origin.kind) {
    case 'project':
      return 'the attached project (read-only)'
    case 'sandbox':
      return 'your session workspace'
    case 'artifact':
      return 'a file you generated, in your session workspace'
    case 'external':
      return 'an external read-only file'
  }
}

export function codeRefBlock(ref: CodeRef): string {
  const lang = detectLanguage(ref.path).lang
  const range =
    ref.startLine === ref.endLine
      ? `line ${ref.startLine}`
      : `lines ${ref.startLine}-${ref.endLine}`
  return [
    `Referenced code from ${originLabel(ref.origin)} — ${ref.path} (${range}):`,
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
