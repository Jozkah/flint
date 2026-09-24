/**
 * The text in the window's native title bar.
 *
 * With a real title bar the title is visible all the time, and it is also what
 * the taskbar, Alt+Tab and screen readers announce. It names what the window
 * is showing -- the chat, or the Cowork session and its project -- without
 * ever carrying a filesystem path: a project is named by its folder's last
 * segment only, and anything path-shaped inside a title is cut to its last
 * segment too, since chat titles are generated from what the user typed.
 */

export const APP_NAME = 'Flint'

/** Longest segment the title carries before it is ellipsised. */
const MAX_SEGMENT = 60

export type WindowTitleInput =
  | { section: 'chat'; threadTitle?: string | null }
  | {
      section: 'cowork'
      sessionTitle?: string | null
      projectFolder?: string | null
    }
  | { section: 'settings' }
  | { section: 'other' }

/** The last segment of a path, whichever separator it uses. */
export function lastPathSegment(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

/**
 * The Cowork session-details trigger label: "repo · branch". Uses
 * lastPathSegment so a Windows folder (`C:\Users\me\repo`) shows its last
 * segment rather than the whole path (#94).
 */
export function sessionDetailsLabel(
  folder: string | null | undefined,
  branch: string | null | undefined
): string {
  const repo = folder ? lastPathSegment(folder) : ''
  if (!repo) return ''
  return branch ? `${repo} · ${branch}` : repo
}

// An absolute or home-relative path, as one whitespace-free token: `C:\a\b`,
// `\\server\share\x`, `/home/u/x`, `~/x`. A lone `/` between words ("and/or")
// has no leading root and is left alone.
const PATH_TOKEN =
  /(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/(?=[^\s/]+\/))[^\s"'<>|]*/g

/** One title segment: no control characters, no paths, bounded length. */
export function sanitizeTitleSegment(raw: string | null | undefined): string {
  if (!raw) return ''
  const noControls = Array.from(raw)
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0
      return code < 0x20 || (code >= 0x7f && code < 0xa0) ? ' ' : ch
    })
    .join('')
  const noPaths = noControls.replace(PATH_TOKEN, (p) => lastPathSegment(p))
  const collapsed = noPaths.replace(/\s+/g, ' ').trim()
  const chars = Array.from(collapsed)
  return chars.length > MAX_SEGMENT
    ? `${chars.slice(0, MAX_SEGMENT - 1).join('').trimEnd()}…`
    : collapsed
}

export function composeWindowTitle(input: WindowTitleInput): string {
  switch (input.section) {
    case 'chat': {
      const title = sanitizeTitleSegment(input.threadTitle)
      return title ? `${title} - ${APP_NAME}` : APP_NAME
    }
    case 'cowork': {
      const session = sanitizeTitleSegment(input.sessionTitle)
      const project = input.projectFolder
        ? sanitizeTitleSegment(lastPathSegment(input.projectFolder))
        : ''
      const parts = [session, project].filter(Boolean)
      return parts.length
        ? `${parts.join(' · ')} - ${APP_NAME} Cowork`
        : `${APP_NAME} Cowork`
    }
    case 'settings':
      return `Settings - ${APP_NAME}`
    default:
      return APP_NAME
  }
}
