/**
 * The composer saves Markdown, and its serializer backslash-escapes the
 * punctuation that would otherwise format (typing `17*23` gives `17\*23`) and
 * writes `<`, `>` and `&` as entities. A sent
 * message is shown as typed, so the escapes are taken back out before it goes.
 * Pairs are read left to right, so a typed backslash (`\\`) survives.
 */
const ESCAPED = /\\([\\`*_{}()#+.!~|<>[\]-])/g

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&' }

export function unescapeComposerMarkdown(text: string): string {
  return text
    .replace(ESCAPED, '$1')
    .replace(/&(lt|gt|amp);/g, (_m, name: string) => ENTITIES[name])
}

/**
 * The draft to put back after a refused send, or null when the user has typed
 * something new since. `now` is the composer's draft as last rendered: the
 * clear after the send may not have rendered yet, so the sent draft itself
 * still counts as untouched. Compared and restored as saved (escaped): the
 * unescaped text never equals a draft with `_` or `*` in it, and the draft
 * was lost (CW-002).
 */
export function refusedDraftToRestore(
  now: string,
  sentRaw: string
): string | null {
  return !now || now === sentRaw ? sentRaw : null
}
