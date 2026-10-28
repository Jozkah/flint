/**
 * Invisible Unicode stripped from untrusted text before the model reads it.
 *
 * The same set and rule as `src-tauri/plugins/tauri-plugin-agent-tools/src/invisible.rs`;
 * both are tested against `tests/fixtures/invisible-unicode.json` there, so
 * the two cannot drift apart. Tag characters (U+E0000-E007F) hide
 * instructions a person cannot see, bidi overrides and isolates reorder what
 * they can, zero-width characters and invisible operators hide text between
 * visible characters. A zero-width joiner is in the set, so emoji joined with
 * one show as separate emoji.
 */
const INVISIBLE =
  /[\u{E0000}-\u{E007F}\u202A-\u202E\u2066-\u2069\u200B-\u200F\u2060-\u2064\uFEFF\uFE00-\uFE0D\u{E0100}-\u{E01EF}\u00AD\u061C\u180E]/gu

/**
 * `text` without invisible characters, and how many were removed. A BOM at the
 * very start is kept, as in the Rust helper.
 */
export function stripInvisible(text: string): { text: string; removed: number } {
  let removed = 0
  const stripped = text.replace(INVISIBLE, (match, offset: number) => {
    if (offset === 0 && match === '\uFEFF') return match
    removed += 1
    return ''
  })
  return { text: removed === 0 ? text : stripped, removed }
}
