import { describe, it, expect } from 'vitest'
import en from '@/locales/en/permissions.json'
import {
  APPROVAL_CANCELLED_TEXT,
  APPROVAL_DENIED_TEXT,
  classifyPermissionOutcome,
} from '@/lib/permissionOutcome'
import type { PermissionMessage } from '@/lib/permissionRequest'

const text = (msg: PermissionMessage | undefined): string | undefined => {
  if (!msg) return undefined
  const [, path] = msg.key.split(':')
  let node: unknown = en
  for (const part of path.split('.')) {
    node = (node as Record<string, unknown>)?.[part]
  }
  expect(typeof node, `missing key ${msg.key}`).toBe('string')
  return (node as string).replace(/\{\{(\w+)\}\}/g, (_, v) =>
    String(msg.values?.[v])
  )
}

// Each input is the exact wording the producer emits today: the chat loop,
// coworkDispatch.ts, mcp_trust.rs `Refusal::message`, and the built-in gate in
// tauri-plugin-agent-tools/src/commands.rs (whitespace as `format!` joins it).
const CASES: [string, string, RegExp, RegExp | undefined][] = [
  [APPROVAL_DENIED_TEXT, 'denied-by-user', /You denied/, undefined],
  [
    'The user did not allow `write`. Do not retry it. Say what you would have changed, and wait for instructions.',
    'denied-by-user',
    /You denied/,
    undefined,
  ],
  [APPROVAL_CANCELLED_TEXT, 'cancelled', /cancelled because the conversation stopped/, /Send the message again/],
  [
    "Error: MCP server 'github' is not trusted for this call. Ask the user to allow it before calling its tools; nothing was sent to the server.",
    'mcp-not-trusted',
    /^github is not trusted/,
    /trust the server/,
  ],
  [
    "Error: the authorization for this call to 'github' was not valid. Ask the user again; nothing was sent to the server.",
    'mcp-ticket-rejected',
    /one-time permission for github/,
    /expires after 5 minutes/,
  ],
  [
    "tool 'bash' is denied by policy",
    'policy',
    /A rule in this project's settings/,
    /\.jan\/agent\/agent\.toml/,
  ],
  [
    "tool 'read' is denied: .jan is the agent's own state directory and is hidden",
    'hidden-state',
    /never shown/,
    undefined,
  ],
  [
    "tool 'web_fetch' was refused: this run has no network access.                  Nothing was sent.",
    'network-off',
    /Internet access is off/,
    /Settings > Agent Tools/,
  ],
  [
    "tool 'web_fetch' was refused: evil.test is not a destination this                  project allows. Nothing was sent.",
    'domain-blocked',
    /^evil\.test is not a site/,
    /allow_domains/,
  ],
  [
    "tool 'read' was refused: .env looks like it holds                  credentials, and nothing has granted access to it by name.",
    'secret-file',
    /^\.env looks like it holds credentials/,
    /agent\.toml/,
  ],
  [
    "tool 'bash' was refused: this is a destructive git operation                  (reset-hard), which can lose work",
    'destructive-git',
    /\(reset-hard\)/,
    /bash\(git:reset-hard\)/,
  ],
  [
    "tool 'bash' was refused: its arguments could not be resolved to a                  file, command or destination, so no permission rule could be applied",
    'unresolvable-arguments',
    /could not be matched/,
    undefined,
  ],
  [
    "tool 'write' tried to write outside the agent workspace and was refused",
    'write-outside-workspace',
    /outside its workspace/,
    /Copy the file/,
  ],
  [
    "tool 'write' cannot write outside the agent workspace. The attached folder /x is mounted read-only",
    'write-outside-workspace',
    /outside its workspace/,
    /Copy the file/,
  ],
  [
    "tool 'read' needs user approval (ReadEscape) and is not available yet",
    'approval-unavailable',
    /cannot be approved from here yet/,
    undefined,
  ],
  [
    'The `write` tool is disabled in review mode, which is read-only.',
    'review-mode',
    /review mode/,
    /Switch the session/,
  ],
  [
    'The folder this session was working in is no longer attached, so `edit` was not run.',
    'folder-detached',
    /no longer attached/,
    /Attach a folder/,
  ],
  [
    '`edit` was not run: editing this folder has not been confirmed for this session. Ask the user',
    'edit-not-confirmed',
    /not been confirmed/,
    /Confirm folder access/,
  ],
  [
    '`edit` was not run: the selected access mode is not available in this build, so nothing',
    'access-unsupported',
    /not available in this build/,
    undefined,
  ],
]

describe('classifyPermissionOutcome', () => {
  it.each(CASES)('%s', (input, kind, message, nextStep) => {
    const outcome = classifyPermissionOutcome(input)
    expect(outcome?.kind).toBe(kind)
    expect(text(outcome!.message)).toMatch(message)
    if (nextStep) {
      expect(text(outcome!.nextStep)).toMatch(nextStep)
    } else {
      expect(outcome!.nextStep).toBeUndefined()
    }
  })

  it('leaves ordinary tool errors alone', () => {
    expect(classifyPermissionOutcome(undefined)).toBeNull()
    expect(classifyPermissionOutcome('')).toBeNull()
    expect(classifyPermissionOutcome('Error: ENOENT: no such file')).toBeNull()
    expect(
      classifyPermissionOutcome("Error: Server 'github' not found")
    ).toBeNull()
  })

  it('tells a cancellation apart from a denial', () => {
    expect(classifyPermissionOutcome(APPROVAL_CANCELLED_TEXT)?.kind).toBe(
      'cancelled'
    )
    expect(classifyPermissionOutcome(APPROVAL_DENIED_TEXT)?.kind).toBe(
      'denied-by-user'
    )
  })
})
