/**
 * Invisible Unicode stripped from untrusted text before the model reads it.
 *
 * The same set and rule as `src-tauri/plugins/tauri-plugin-agent-tools/src/invisible.rs`;
 * both are tested against `tests/fixtures/invisible-unicode.json` there, so
 * the two cannot drift apart. Tag characters (U+E0000-E007F) hide
 * instructions a person cannot see, bidi overrides and isolates reorder what
 * they can, zero-width characters and invisible operators hide text between
 * visible characters. A single zero-width joiner or non-joiner between two
 * visible non-ASCII characters is kept (Persian, Arabic and Indic words and
 * emoji sequences need it); anywhere else it is stripped.
 */
// The class lists joiners and variation selectors on purpose: they are the
// characters this strips.
const INVISIBLE =
  // eslint-disable-next-line no-misleading-character-class
  /[\u{E0000}-\u{E007F}\u202A-\u202E\u2066-\u2069\u200B-\u200F\u2060-\u2064\uFEFF\uFE00-\uFE0D\u{E0100}-\u{E01EF}\u00AD\u061C\u180E]/gu

// eslint-disable-next-line no-misleading-character-class
const INVISIBLE_ONE =new RegExp(INVISIBLE.source, 'u')
const WHITE_SPACE = /\p{White_Space}/u

/** A visible non-ASCII character a joiner may sit beside. */
function joinable(ch: string | undefined): boolean {
  if (ch === undefined) return false
  return (ch.codePointAt(0) ?? 0) > 0x7f && !WHITE_SPACE.test(ch) && !INVISIBLE_ONE.test(ch)
}

/**
 * `text` without invisible characters, and how many were removed. A BOM at the
 * very start is kept, as in the Rust helper.
 */
export function stripInvisible(text: string): { text: string; removed: number } {
  if (!INVISIBLE_ONE.test(text)) return { text, removed: 0 }
  const chars = Array.from(text)
  let removed = 0
  let out = ''
  chars.forEach((ch, i) => {
    const joinerKept =
      (ch === '\u200C' || ch === '\u200D') && i > 0 && joinable(chars[i - 1]) && joinable(chars[i + 1])
    if (INVISIBLE_ONE.test(ch) && !(i === 0 && ch === '\uFEFF') && !joinerKept) {
      removed += 1
    } else {
      out += ch
    }
  })
  return { text: removed === 0 ? text : out, removed }
}
