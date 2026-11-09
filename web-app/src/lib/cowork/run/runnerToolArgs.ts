// Explaining a tool call the Cowork runner refused: its capped arguments, the
// shape it should have had, and what kind of refusal it was.

import { firstJsonObject } from '@/lib/toolCallRepair'
import type { HarnessRefusalKind } from '@/lib/coworkRunner'

/** Cap on how much of a rejected call's raw arguments is echoed back. A whole
 * file's worth of `content` would otherwise flood the transcript and the next
 * request's context. */
export const ARGS_ECHO_CAP = 300

/** Echo a rejected call's arguments, capped so a huge value is not dumped. */
export function capArgs(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw)
  return s.length > ARGS_ECHO_CAP
    ? `${s.slice(0, ARGS_ECHO_CAP)}... (${s.length} chars, truncated)`
    : s
}

/**
 * Roughly, whether a string is JSON that was cut off before it closed -- a tool
 * call whose arguments ran past the model's output-token budget mid-value (a
 * `write` of a whole large file is the usual cause). Long, opens like JSON, and
 * has no complete top-level object, so it never balanced.
 */
export function looksTruncatedArgs(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  const t = raw.trimStart()
  if (t.length < 200) return false
  if (!t.startsWith('{') && !t.startsWith('[')) return false
  // Ends where JSON ends: complete but malformed (an unquoted value), not cut off.
  if (/[}\]]\s*$/.test(t)) return false
  return firstJsonObject(t) === undefined
}

/**
 * The refusal text for a call the SDK could not parse. A call cut off by the
 * output limit gets specific, actionable guidance -- resending the same giant
 * value just truncates again and loops -- rather than the generic parse error,
 * which the model cannot act on.
 */
/**
 * The one-line shape of a valid call to each built-in tool, for a refusal
 * that should show what was expected (transcript audit #12). Required
 * arguments only; the schema the model was given has the rest.
 */
export const EXPECTED_SHAPES: Record<string, string> = {
  read: '{"path": "<file>"}',
  write: '{"path": "<file>", "content": "<text>"}',
  edit: '{"path": "<file>", "edits": [{"old_string": "<exact text>", "new_string": "<replacement>"}]}',
  ls: '{"path": "<folder>"}',
  find: '{"pattern": "<glob>"}',
  grep: '{"pattern": "<regex>"}',
  bash: '{"command": "<command>"}',
  git: '{"args": ["status"]} or {"program": "gh", "args": ["pr", "list", "--repo", "owner/repo"]}',
  request_access: '{"path": "<absolute folder>", "reason": "<why>", "access_mode": "read"}',
}

/**
 * The fields a schema validation error names, as "`path`: Required". The AI
 * SDK reports them as a JSON list of issues inside its message.
 */
export function schemaIssues(errorText: string): string[] {
  const out: string[] = []
  const issue =
    /\{[^{}]*?"path"\s*:\s*\[([^\]]*)\][^{}]*?"message"\s*:\s*"([^"]*)"[^{}]*?\}/g
  for (const m of errorText.matchAll(issue)) {
    const field = m[1]
      .split(',')
      .map((p) => p.trim().replace(/^"|"$/g, ''))
      .filter(Boolean)
      .join('.')
    out.push(`\`${field || '(arguments)'}\`: ${m[2]}`)
  }
  const missing = /missing required (?:argument|property) '?"?([\w.]+)/gi
  for (const m of errorText.matchAll(missing)) {
    const line = `\`${m[1]}\`: Required`
    if (!out.includes(line)) out.push(line)
  }
  return out
}

/**
 * Why a `bash` call was refused when the shell is not offered, and what to use
 * instead. Without it the model saw only a list of tool names, called `bash`
 * again with a different command, and each retry counted toward the loop guard.
 */
export function noShellAdvice(base: string, tool: string | undefined): string {
  if (tool !== 'bash' || refusalKindOf(base) !== 'tool-not-offered') return ''
  return (
    ' `bash` is not offered in this run (the shell is unavailable on this machine or turned' +
    ' off), so no command can run through it. ' +
    (/(^|[^a-z_])host_powershell($|[^a-z_])/.test(base)
      ? 'Use `host_powershell` for commands, and the file tools for files.'
      : 'Use the file tools (read, ls, find, grep, write, edit) instead.')
  )
}

export function explainInvalid(base: string, tool: string | undefined, raw: unknown): string {
  const issues = schemaIssues(base)
  const shape = tool ? EXPECTED_SHAPES[tool] : undefined
  const sent =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.keys(raw as Record<string, unknown>)
      : []
  return (
    (issues.length ? ` Invalid or missing: ${issues.join('; ')}.` : '') +
    noShellAdvice(base, tool) +
    (shape ? ` Expected call shape: ${shape}.` : '') +
    (shape && sent.length
      ? ` You sent: ${sent.map((k) => `\`${k}\``).join(', ')}.`
      : '')
  )
}

export function invalidArgsMessage(
  errorText: unknown,
  raw: unknown,
  usable: boolean,
  tool?: string
): string {
  const base = String(errorText ?? 'the call was not valid')
  if (looksTruncatedArgs(raw)) {
    return (
      `${base} -- the arguments were cut off before they were complete, which ` +
      'happens when the content is too large to return in one turn. Do not ' +
      'resend the whole thing: ' +
      (tool === 'write' || tool === 'edit'
        ? 'create the file with a first `write` of its opening portion, then ' +
          'extend it with `edit` in further calls (or write fewer lines per call).'
        : 'resend the call with shorter argument values.')
    )
  }
  return (
    base +
    (usable || raw === undefined
      ? ''
      : ` (the arguments sent were: ${capArgs(raw)})`) +
    explainInvalid(base, tool, raw)
  )
}

/** The kind of refusal an invalid call is, from the SDK's own reason. */
export function refusalKindOf(invalid: string): HarnessRefusalKind {
  return /unavailable tool|no such tool|not (?:a|an) (?:available|offered) tool/i.test(invalid)
    ? 'tool-not-offered'
    : 'invalid-call'
}
