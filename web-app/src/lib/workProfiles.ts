/**
 * Work profiles: an add-on to the system prompt for the kind of work a
 * request is -- review, planning, a refactor, reverse engineering... The core
 * prompt (safety, verification, workspace rules) is the same for every
 * profile; a profile only adds what matters for that kind of work.
 *
 * Off by default: without it every run gets the global prompt alone. With it
 * on, each new message picks a profile -- Jev chooses when it is set up, a
 * keyword match otherwise -- unless the user picked one by hand.
 */

export const WORK_PROFILE_IDS = [
  'execute',
  'review',
  'plan',
  'refactor',
  'debug',
  'reverse-engineer',
  'explain',
] as const

export type WorkProfileId = (typeof WORK_PROFILE_IDS)[number]

export type WorkProfile = {
  id: WorkProfileId
  label: string
  /** What the request looks like: shown in Settings, and what Jev matches on. */
  description: string
  /** The default add-on text. The user may replace it in Settings. */
  prompt: string
}

export const WORK_PROFILES: readonly WorkProfile[] = [
  {
    id: 'execute',
    label: 'Execute',
    description: 'Build, add or change something: implement a feature, fix a known bug, make the requested edit.',
    prompt: [
      '- The user wants the change made. Make it end to end: the code, the call sites it affects, and the tests that cover it.',
      '- Keep the change to what was asked; note related problems you see instead of fixing them unasked.',
      '- Run the relevant existing tests or checks after the change and report the result.',
    ].join('\n'),
  },
  {
    id: 'review',
    label: 'Review',
    description: 'Review, audit or check existing code or a diff for bugs, risks and quality. No changes expected.',
    prompt: [
      '- This is a review: read and reason, do not change files unless asked.',
      '- Read the whole change and the code it touches before judging it; follow calls into other files when a finding depends on them.',
      '- Report findings ranked by severity, each with the file and line, the concrete failure (inputs or state that break it), and a suggested fix.',
      '- Say what you checked and found fine as well as what is wrong; do not pad with style nits.',
      '- Output: a list ranked by severity; each item is `file:line`, the problem, how it fails, and the fix.',
    ].join('\n'),
  },
  {
    id: 'plan',
    label: 'Plan',
    description: 'Design or plan work before doing it: an approach, architecture, steps, trade-offs, estimates.',
    prompt: [
      '- The user wants a plan, not the implementation. Investigate enough to ground it in the real code.',
      '- Give the approach, the files and components involved, the ordered steps, the risks, and the decisions that are the user\'s to make.',
      '- Recommend one option when there are several, and say why.',
      '- Output: numbered steps, then the risks, then the decisions left to the user.',
    ].join('\n'),
  },
  {
    id: 'refactor',
    label: 'Refactor',
    description: 'Restructure, clean up, rename, split or simplify code without changing what it does.',
    prompt: [
      '- Behaviour must stay the same. Run the existing tests before and after; if none cover the code, say so and add a small one first when it is worth it.',
      '- Change in small steps that each leave the code working. Update every caller of anything you rename or move.',
      '- Do not mix in behaviour changes or fixes; list those separately.',
    ].join('\n'),
  },
  {
    id: 'debug',
    label: 'Debug',
    description: 'Find out why something fails, crashes or behaves wrongly, and fix the cause.',
    prompt: [
      '- Reproduce the problem first, or find the evidence for it (logs, error text, a failing test).',
      '- Form a hypothesis, test it, and narrow down to the root cause before changing code. Do not patch the symptom.',
      '- After the fix, show the reproduction passing, and add a regression test when the cause could come back.',
    ].join('\n'),
  },
  {
    id: 'reverse-engineer',
    label: 'Reverse engineer',
    description: 'Work out how unfamiliar or undocumented code, binaries, formats or protocols work.',
    prompt: [
      '- Map the structure before the details: entry points, main data structures, how the parts connect.',
      '- Keep notes of what you established and how (file, offset, observed behaviour), separate from what you infer.',
      '- Label guesses as guesses; verify them against the code or by observation before building on them.',
    ].join('\n'),
  },
  {
    id: 'explain',
    label: 'Explain',
    description: 'Answer a question or explain how something works; no changes expected.',
    prompt: [
      '- Answer the question directly first, then the supporting detail.',
      '- Ground the answer in the actual code: cite the files and lines it comes from. Say when something is not in the code you can see.',
      '- Do not change files unless asked.',
    ].join('\n'),
  },
]

export function workProfile(id: WorkProfileId): WorkProfile {
  return WORK_PROFILES.find((p) => p.id === id) ?? WORK_PROFILES[0]
}

export function isWorkProfileId(value: unknown): value is WorkProfileId {
  return typeof value === 'string' && (WORK_PROFILE_IDS as readonly string[]).includes(value)
}

/** Keyword rules, most specific first. Used when Jev is not set up or abstains. */
const RULES: Array<[WorkProfileId, RegExp]> = [
  ['reverse-engineer', /\b(reverse[- ]?engineer\w*|disassembl\w*|decompil\w*|ghidra|ida pro)\b|\bfigure out how\b.*\bworks?\b/i],
  ['review', /\b(review|audit)\b(?!\s+(button|screen|page|step|modal|form))|\bcheck (this|the|my) (code|diff|pr|change)s?\b/i],
  ['refactor', /\b(refactor\w*|restructure|clean ?up (the |this )?(code|module|file))\b/i],
  ['debug', /\b(debug\w*|why (does|is|do|isn'?t|doesn'?t|won'?t|did)\b.*\b(fail\w*|crash\w*|break\w*|error\w*|wrong|work)|(crash(es|ed|ing)?|throws?|stack ?trace)\b|(is|are|keeps?) (failing|crashing|broken)|not working|doesn'?t work)/i],
  ['plan', /\b(make|write|draft|give me) (a |the )?plan\b|\bplan (out|how|the|for)\b|\bhow should (i|we)\b|\b(architecture|roadmap)\b/i],
  ['explain', /^\s*(what|how|why|where|which|explain|can you explain|tell me)\b(?![^?]*\b(add|make|create|fix|change|implement|build)\b)/i],
]

/** A profile from the message's wording; `execute` when nothing matches. */
export function classifyLocally(message: string): WorkProfileId {
  for (const [id, re] of RULES) if (re.test(message)) return id
  return 'execute'
}

/** The block added to the system prompt for a profile. */
export function workProfileBlock(id: WorkProfileId, text: string): string {
  return `# How to approach this request (${workProfile(id).label})\n\n${text.trim()}`
}
