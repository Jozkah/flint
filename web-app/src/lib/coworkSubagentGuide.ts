/**
 * What the model is told about delegating, shared by the `task` / `team` tool
 * descriptions and the Subagents block of the system prompt, so the two never
 * disagree about when to delegate.
 *
 * The wording follows the same triggers as the Rust `dispatch_subagent`
 * description (`core/agent/subagent.rs::dispatch_description`): delegate for an
 * open-ended search, independent parallel parts, or output too large to read
 * yourself; do not delegate a lookup you can do in a call or two; write a
 * complete brief; the user never sees the child's output.
 *
 * It is re-sent on every turn, so it is kept short enough for a small local
 * model; `coworkSubagentGuide.test.ts` caps its size.
 */

/**
 * The roles Flint ships (`core/agent/roles.rs`), with one clause each on when
 * to pick them. Kept in step with the Rust `Role::when`; a test reads the Rust
 * file and fails if the two drift.
 */
export const SUBAGENT_ROLES: readonly { name: string; when: string }[] = [
  {
    name: 'explorer',
    when: 'find where code lives or how it fits together, read-only',
  },
  {
    name: 'planner',
    when: 'design a phased plan before a large change, read-only',
  },
  { name: 'implementer', when: 'make a well-specified edit in named files' },
  { name: 'reviewer', when: 'check code for real bugs, read-only' },
  {
    name: 'tester',
    when: 'run the tests that cover a change and report results',
  },
  {
    name: 'security',
    when: 'look for exploitable weaknesses, read-only',
  },
]

/** `name (when)` for every shipped role, `; `-separated. */
export function subagentRoleMenu(): string {
  return SUBAGENT_ROLES.map((r) => `${r.name} (${r.when})`).join('; ')
}

/** Saved subagents that are not one of the shipped roles. */
export function savedSubagentNames(names: readonly string[]): string[] {
  const roles = new Set(SUBAGENT_ROLES.map((r) => r.name))
  return names.filter((n) => !roles.has(n))
}

/** The sentence listing roles and saved subagents, for a tool description. */
export function subagentChoices(names: readonly string[]): string {
  const saved = savedSubagentNames(names)
  return (
    `Roles: ${subagentRoleMenu()}.` +
    (saved.length ? ` Saved: ${saved.join(', ')}.` : '')
  )
}

/** The brief rules every delegation tool repeats, in one place. */
export const BRIEF_RULE =
  'It cannot see this chat, so `description` must be a complete brief: the goal, the files or names involved, and what to report back.'

export const DELEGATE_WHEN =
  'Delegate when: a search or investigation is open-ended and needs many reads or rounds; the request covers two or more separate areas, modules or packages, or says all, every or the whole repo, or is an inventory or sweep over many files such as coverage gaps, usages or risks (send one subagent per area, in one message, before reading anything yourself); the output would be large and you only need the conclusion; or a role below fits.'

export const DO_NOT_DELEGATE =
  'Do not delegate: a lookup you can do in one or two tool calls, a file or symbol you already know, or work another subagent is already doing.'

export const NOT_SHOWN_TO_USER =
  "The user does not see the subagent's output: read it and tell them what matters."
