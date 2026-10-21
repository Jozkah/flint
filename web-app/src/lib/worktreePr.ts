/**
 * A GitHub pull request named for a worktree: `123`, `#123` or a pull request
 * URL. Becomes the backend's `pr:<n>` (or `pr:<owner>/<repo>#<n>` for a URL,
 * so origin is checked to be that repository) base, which fetches
 * `pull/<n>/head` from origin without ever waiting for input.
 */
export type WorktreePr =
  | { ok: true; base: string; number: number }
  | { ok: false; reason: string }

const URL_FORM =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d{1,9})(?:[/?#].*)?$/i

export function parseWorktreePr(input: unknown): WorktreePr {
  const raw =
    typeof input === 'number' && Number.isInteger(input)
      ? String(input)
      : typeof input === 'string'
        ? input.trim()
        : ''
  if (!raw) return { ok: false, reason: '`pr` must be a pull request number or URL.' }
  const url = URL_FORM.exec(raw)
  if (url) {
    const number = Number(url[3])
    if (number < 1) return { ok: false, reason: `${raw} is not a pull request.` }
    return { ok: true, number, base: `pr:${url[1]}/${url[2]}#${number}` }
  }
  const plain = /^#?(\d{1,9})$/.exec(raw)
  if (plain && Number(plain[1]) >= 1)
    return { ok: true, number: Number(plain[1]), base: `pr:${Number(plain[1])}` }
  return {
    ok: false,
    reason: `\`pr\` must be a pull request number like 123 or #123, or a https://github.com/<owner>/<repo>/pull/<n> URL (got ${raw.slice(0, 80)}).`,
  }
}
