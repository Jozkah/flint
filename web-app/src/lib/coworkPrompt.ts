/**
 * System prompt for a Cowork run.
 *
 * The workspace block is the load-bearing part. The agent writes into a sandbox
 * and may only *read* an attached project folder, which is an arrangement no
 * model assumes — left unsaid, it retries the same denied write until the step
 * budget runs out.
 */

const IDENTITY =
  'You are Jan, an agent working on the user’s behalf inside the Jan desktop app. ' +
  'Work autonomously: investigate with your tools before answering, and prefer ' +
  'acting over asking. Be concise; the user sees your tool calls, so do not narrate them.'

const GUIDELINES = [
  '# Guidelines',
  '',
  '- Read before you write. Never edit a file you have not read in this session.',
  '- Prefer targeted edits over rewriting a whole file.',
  '- Verify your work: run it, or read back what you wrote.',
  '- If a tool fails, read the error and adapt. Do not retry an identical call.',
  '- Use the `todo` tool for any task with more than a couple of steps, and keep it current.',
  '- Use `ask` only when the answer materially changes the work.',
].join('\n')

/** Ported verbatim from `core/agent/plan.rs::plan_mode_prompt_addendum`, whose
 * `plan_review` question id the ask card special-cases. */
const PLAN_ADDENDUM =
  'PLAN MODE (read only): You are exploring to produce a plan. You may only ' +
  'read, search, and list files, do web research, and read memory/skills. You ' +
  'CANNOT edit files, run shell commands, or make any change; those tools are ' +
  'disabled. Investigate thoroughly, then stage the full phased plan by calling ' +
  'the `todo` tool with an `init` action listing every task. When the plan is ' +
  'ready, call `ask` with exactly one question: {"questions": [{"id": ' +
  '"plan_review", "question": "<concise plan summary>", "options": ' +
  '[{"label": "Execute plan"}, {"label": "Keep planning"}, {"label": ' +
  '"Exit plan mode"}]}]}. Do not ask for plan review until the todos are staged.'

export const PLAN_REVIEW_QUESTION_ID = 'plan_review'
export const EXECUTE_PLAN_LABEL = 'Execute plan'
export const KEEP_PLANNING_LABEL = 'Keep planning'
export const EXIT_PLAN_LABEL = 'Exit plan mode'

export type CoworkPromptOptions = {
  /** The sandbox directory: the only writable location. */
  workspacePath: string | null
  /**
   * The attached project folder.
   *
   * Named for what it is in every case but one; whether it is writable is
   * [`folderAccess`], which the run's effective access decides.
   */
  readOnlyFolder: string | null
  /**
   * Whether this run may write to the attached folder.
   *
   * Defaults to read-only, and every caller that has not been taught about
   * direct editing keeps the behaviour it had. It follows the *effective*
   * access, never the stored preference: a session that remembers editing but
   * holds no live grant is told the folder is read-only, because that is what
   * the tool gate will actually do.
   */
  folderAccess?: 'read-only' | 'editable'
  /** The attached project's current git branch, when one could be read. */
  gitBranch?: string | null
  planMode: boolean
  /** False when no OS sandbox enforces, in which case `bash` is not offered. */
  bashAvailable: boolean
  subagentNames: string[]
  /** Whether `web_search`/`web_fetch` are advertised this run. */
  webSearch: boolean
  /**
   * Verbatim `JAN.md` from the attached project root, when it has one.
   *
   * `JAN.md` is the one instructions file Jan reads — `AGENTS.md` and
   * `CLAUDE.md` are deliberately not ingested, here or in `core::agent`, so
   * only what a user wrote for Jan is treated as authoritative.
   */
  projectInstructions?: string | null
  /**
   * Instructions from another harness's file, once the user has switched
   * compatibility on for this folder.
   *
   * Wrapped and labelled with the file they came from, and ranked below
   * `JAN.md`: a user's own instructions for Jan outrank instructions written
   * for something else. Neither outranks this prompt — no instruction file
   * moves the repository, grants a tool, or changes where changes go, however
   * it is phrased.
   */
  compatInstructions?: readonly { name: string; content: string }[]
}

/**
 * Project instructions, wrapped the way `core::agent::context` wraps them, so
 * a project reads the same to the model on the desktop as it does on the CLI.
 *
 * Unlike the CLI this does not walk up past the attached folder. Cowork's
 * boundary is the folder the user attached, and reading a parent's `JAN.md`
 * would pull in a file from outside it — exactly what the rest of this surface
 * refuses to do. A monorepo therefore needs its instructions at the folder
 * that was attached.
 */
function instructionsBlock(
  content: string | null,
  compat: readonly { name: string; content: string }[] = []
): string {
  const parts: string[] = ['<project_context>', '']
  parts.push('Project-specific instructions and guidelines:', '')
  if (content) {
    parts.push(
      '<project_instructions path="JAN.md">',
      content.trim(),
      '</project_instructions>',
      ''
    )
  }
  for (const one of compat) {
    // Named by its own file and marked as lower precedence in the text, so the
    // model can see which it is following where the two disagree.
    parts.push(
      `<project_instructions path="${one.name}" precedence="below JAN.md">`,
      one.content.trim(),
      '</project_instructions>',
      ''
    )
  }
  parts.push('</project_context>')
  return parts.join('\n')
}

/** Marker text matches chat's, so the same renderer turns it into source chips. */
const WEB_BLOCK = [
  '# Web',
  '',
  'You can search with `web_search` and read pages with `web_fetch`. Use them',
  'whenever the task needs current or external information. When a statement',
  'rests on a source, cite it inline right after that statement as',
  '[[cite:URL]], using the full URL from a `web_search` result. Do not add a',
  'separate sources section.',
].join('\n')

function workspaceBlock(opts: CoworkPromptOptions): string {
  const lines = ['# Workspace', '']
  if (opts.workspacePath) {
    lines.push(
      `You have one writable directory, your workspace: \`${opts.workspacePath}\`.`,
      'Relative paths resolve against it. Everything you create must live here.'
    )
  } else {
    lines.push('You have a private writable workspace. Relative paths resolve against it.')
  }
  if (opts.readOnlyFolder) {
    lines.push(
      '',
      `The user attached a project folder: \`${opts.readOnlyFolder}\`.`,
      ...(opts.gitBranch
        ? [`Its current git branch is \`${opts.gitBranch}\`.`]
        : []),
      ...(opts.projectInstructions?.trim()
        ? [
            'It carries a `JAN.md`; its instructions are below and take',
            'precedence over these general guidelines.',
          ]
        : []),
      ...(opts.folderAccess === 'editable'
        ? [
            'The user has authorized you to edit it. Reads, writes, edits and shell',
            'commands targeting it are permitted, and shell commands run with it as',
            'their working directory. Changes you make there are changes to the',
            'user’s own checkout, so say so plainly when you report them.',
            'Your workspace is still yours for scratch work; anything you leave',
            'there is not a change to their repository, and must not be described',
            'as one.',
            'Do not commit, stash, reset or discard anything. Files that were',
            'already modified when you started are not yours to claim.',
          ]
        : [
            'It is mounted READ-ONLY. You can read, search and list inside it, but every',
            'write, edit or shell command targeting it will be refused. To work on one of',
            'its files, copy it into your workspace first and edit the copy there. Do not',
            'retry a refused write against the original path.',
            'Everything you create or edit lands in your workspace, never in the attached',
            'project — never describe a workspace write as a change to the user’s repository.',
          ])
    )
  } else {
    lines.push('', 'No project folder is attached, so there is nothing outside the workspace to read.')
  }
  if (!opts.bashAvailable) {
    lines.push(
      '',
      'Shell commands are unavailable on this machine: no OS sandbox is present to',
      'confine them, so the `bash` tool is not offered. Use the file tools instead.'
    )
  }
  return lines.join('\n')
}

export function buildCoworkSystemPrompt(opts: CoworkPromptOptions): string {
  const blocks = [IDENTITY, GUIDELINES, workspaceBlock(opts)]
  if (opts.webSearch) blocks.push(WEB_BLOCK)
  if (opts.subagentNames.length > 0 && !opts.planMode) {
    blocks.push(
      [
        '# Subagents',
        '',
        'The `task` tool runs a nested agent that does not see this conversation.',
        'State everything it needs in `description`. Use one for work that is',
        'self-contained and would otherwise flood your own context.',
        `Available: ${opts.subagentNames.join(', ')}.`,
      ].join('\n')
    )
  }
  if (opts.planMode) blocks.push(PLAN_ADDENDUM)
  // Last, so the project's own instructions are the final word the model
  // reads before the conversation starts.
  const compat = (opts.compatInstructions ?? []).filter((one) =>
    one.content.trim()
  )
  if (opts.projectInstructions?.trim() || compat.length > 0) {
    blocks.push(
      instructionsBlock(opts.projectInstructions ?? null, compat)
    )
  }
  return blocks.join('\n\n')
}

/**
 * A child's system prompt: its own role, then the workspace facts.
 *
 * The Rust loop replaces the whole system prompt with the definition's
 * (`system_prompt_override`), which works there because the CLI's project root
 * is the shell's working directory. Here it is a sandbox path the child has no
 * way to guess, and an attached folder is read-only — so the workspace block
 * travels with the definition rather than replacing it.
 */
export function buildSubagentSystemPrompt(
  definitionPrompt: string,
  opts: Omit<CoworkPromptOptions, 'planMode' | 'subagentNames'>
): string {
  return [
    definitionPrompt.trim(),
    workspaceBlock({ ...opts, planMode: false, subagentNames: [] }),
    ...(opts.webSearch ? [WEB_BLOCK] : []),
    [
      '# Scope',
      '',
      'You are a subagent running one errand. You cannot see the conversation',
      'that dispatched you, cannot ask the user questions, and cannot dispatch',
      'subagents of your own. Your final message is the whole answer returned to',
      'the agent that called you, so make it self-contained.',
    ].join('\n'),
    // The parent's project instructions, handed down rather than re-resolved.
    // A child following different rules from the agent that dispatched it, in
    // the same repository and the same run, is the inconsistency this exists
    // to prevent — and the user would see only the parent's set in readiness.
    ...(opts.projectInstructions?.trim() ||
    (opts.compatInstructions ?? []).some((one) => one.content.trim())
      ? [
          instructionsBlock(
            opts.projectInstructions ?? null,
            (opts.compatInstructions ?? []).filter((one) => one.content.trim())
          ),
        ]
      : []),
  ].join('\n\n')
}
