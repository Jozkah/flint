import fs from 'node:fs'

const BACKSLASH = 92
const QUOTE = 34

/**
 * `gh api --paginate` writes one JSON array per page, concatenated without a
 * separator. Parse that stream back into a single flat array.
 */
export function readConcatJson(path) {
  if (!fs.existsSync(path)) return []
  const s = fs.readFileSync(path, 'utf8')
  const out = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (inString) {
      if (escaped) escaped = false
      else if (code === BACKSLASH) escaped = true
      else if (code === QUOTE) inString = false
      continue
    }
    if (code === QUOTE) {
      inString = true
      continue
    }
    const c = s[i]
    if (c === '[' || c === '{') {
      if (depth === 0) start = i
      depth++
    } else if (c === ']' || c === '}') {
      depth--
      if (depth === 0) out.push(JSON.parse(s.slice(start, i + 1)))
    }
  }
  return out.flat()
}
