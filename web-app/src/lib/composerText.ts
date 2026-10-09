/**
 * The composer saves Markdown, and its serializer backslash-escapes the
 * punctuation that would otherwise format: typing `17*23` gives `17\*23`. A sent
 * message is shown as typed, so the escapes are taken back out before it goes.
 * Pairs are read left to right, so a typed backslash (`\\`) survives.
 */
const ESCAPED = /\\([\\`*_{}()#+.!~|<>[\]-])/g

export function unescapeComposerMarkdown(text: string): string {
  return text.replace(ESCAPED, '$1')
}
