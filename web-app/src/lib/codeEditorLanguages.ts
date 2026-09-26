/**
 * CodeMirror language support for the Code panel's editor, keyed by the same
 * language ids the read-only viewer detects (Shiki's), so a file is
 * highlighted as the same language whether it is being read or edited.
 *
 * Every grammar is a dynamic import: opening a TypeScript file never loads
 * the SQL parser, and the editor as a whole stays out of the main bundle.
 */
import type { Extension } from '@codemirror/state'
import type { StreamParser } from '@codemirror/language'

type Loader = () => Promise<Extension>

/** A CodeMirror 5 mode, for the languages without a Lezer grammar. */
const legacy =
  (load: () => Promise<StreamParser<unknown>>): Loader =>
  async () => {
    const [{ StreamLanguage }, mode] = await Promise.all([
      import('@codemirror/language'),
      load(),
    ])
    return StreamLanguage.define(mode)
  }

const LOADERS: Record<string, Loader> = {
  typescript: async () =>
    (await import('@codemirror/lang-javascript')).javascript({
      typescript: true,
    }),
  tsx: async () =>
    (await import('@codemirror/lang-javascript')).javascript({
      typescript: true,
      jsx: true,
    }),
  javascript: async () =>
    (await import('@codemirror/lang-javascript')).javascript(),
  jsx: async () =>
    (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
  json: async () => (await import('@codemirror/lang-json')).json(),
  jsonc: async () => (await import('@codemirror/lang-json')).json(),
  rust: async () => (await import('@codemirror/lang-rust')).rust(),
  python: async () => (await import('@codemirror/lang-python')).python(),
  go: async () => (await import('@codemirror/lang-go')).go(),
  java: async () => (await import('@codemirror/lang-java')).java(),
  c: async () => (await import('@codemirror/lang-cpp')).cpp(),
  cpp: async () => (await import('@codemirror/lang-cpp')).cpp(),
  php: async () => (await import('@codemirror/lang-php')).php(),
  sql: async () => (await import('@codemirror/lang-sql')).sql(),
  html: async () => (await import('@codemirror/lang-html')).html(),
  vue: async () => (await import('@codemirror/lang-html')).html(),
  svelte: async () => (await import('@codemirror/lang-html')).html(),
  astro: async () => (await import('@codemirror/lang-html')).html(),
  xml: async () => (await import('@codemirror/lang-xml')).xml(),
  css: async () => (await import('@codemirror/lang-css')).css(),
  scss: async () => (await import('@codemirror/lang-css')).css(),
  less: async () => (await import('@codemirror/lang-css')).css(),
  markdown: async () => (await import('@codemirror/lang-markdown')).markdown(),
  yaml: async () => (await import('@codemirror/lang-yaml')).yaml(),
  shellscript: legacy(
    async () => (await import('@codemirror/legacy-modes/mode/shell')).shell
  ),
  powershell: legacy(
    async () =>
      (await import('@codemirror/legacy-modes/mode/powershell')).powerShell
  ),
  toml: legacy(
    async () => (await import('@codemirror/legacy-modes/mode/toml')).toml
  ),
  ruby: legacy(
    async () => (await import('@codemirror/legacy-modes/mode/ruby')).ruby
  ),
  swift: legacy(
    async () => (await import('@codemirror/legacy-modes/mode/swift')).swift
  ),
  lua: legacy(
    async () => (await import('@codemirror/legacy-modes/mode/lua')).lua
  ),
  r: legacy(async () => (await import('@codemirror/legacy-modes/mode/r')).r),
  perl: legacy(
    async () => (await import('@codemirror/legacy-modes/mode/perl')).perl
  ),
  haskell: legacy(
    async () => (await import('@codemirror/legacy-modes/mode/haskell')).haskell
  ),
  clojure: legacy(
    async () => (await import('@codemirror/legacy-modes/mode/clojure')).clojure
  ),
  erlang: legacy(
    async () => (await import('@codemirror/legacy-modes/mode/erlang')).erlang
  ),
  dockerfile: legacy(
    async () =>
      (await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile
  ),
  cmake: legacy(
    async () => (await import('@codemirror/legacy-modes/mode/cmake')).cmake
  ),
  diff: legacy(
    async () => (await import('@codemirror/legacy-modes/mode/diff')).diff
  ),
  ini: legacy(
    async () => (await import('@codemirror/legacy-modes/mode/properties')).properties
  ),
  kotlin: legacy(
    async () => (await import('@codemirror/legacy-modes/mode/clike')).kotlin
  ),
  scala: legacy(
    async () => (await import('@codemirror/legacy-modes/mode/clike')).scala
  ),
  csharp: legacy(
    async () => (await import('@codemirror/legacy-modes/mode/clike')).csharp
  ),
  dart: legacy(
    async () => (await import('@codemirror/legacy-modes/mode/clike')).dart
  ),
  'objective-c': legacy(
    async () =>
      (await import('@codemirror/legacy-modes/mode/clike')).objectiveC
  ),
}

/** Is there an editor grammar for this language id? */
export const hasEditorLanguage = (lang: string): boolean => lang in LOADERS

/**
 * The CodeMirror extension for `lang`, or null for plain text and anything
 * without a grammar. A grammar that fails to load edits as plain text rather
 * than failing the editor.
 */
export async function loadEditorLanguage(
  lang: string
): Promise<Extension | null> {
  const load = LOADERS[lang]
  if (!load) return null
  try {
    return await load()
  } catch {
    return null
  }
}
