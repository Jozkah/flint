/**
 * Line endings between the file on disk and the editor.
 *
 * The editor splits on every kind of line break and joins with `\n`, so a
 * CRLF file read verbatim never equals what the editor reports back: the
 * buffer looked edited the moment the file opened. The buffer therefore
 * holds LF text, compared against LF text, and the file's own style is put
 * back when writing.
 */
export type Eol = '\n' | '\r\n' | '\r'

/** The editor's view of `text`: every line break as `\n`. */
export const toLf = (text: string): string =>
  text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text

/**
 * The line ending a file mostly uses. A mixed file takes its majority, CRLF
 * on a tie; a file with no line break at all is LF.
 */
export function detectEol(text: string): Eol {
  if (!text.includes('\r')) return '\n'
  let crlf = 0
  let lf = 0
  let cr = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++
        i++
      } else cr++
    } else if (c === 10) lf++
  }
  if (crlf >= lf && crlf >= cr) return crlf > 0 ? '\r\n' : '\n'
  return cr > lf ? '\r' : '\n'
}

/** `text` (LF) written in `eol`. */
export const withEol = (text: string, eol: Eol): string => {
  const lf = toLf(text)
  return eol === '\n' ? lf : lf.replace(/\n/g, eol)
}
