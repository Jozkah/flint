/**
 * Overlapping team tasks, shown before either one runs. AH-109.
 *
 * Each overlap names both tasks and the paths where their declared changes
 * meet, and asks for one of three answers: run one after the other, narrow
 * what one of them may change, or let them run side by side. The last is
 * recorded with the children it covers, and changes nothing about how their
 * work is applied later -- each still arrives as a proposal, and the
 * apply-time conflict check runs as it always does.
 *
 * What this shows is the overlap of *declared* paths. It says so: a clean
 * list here is not a claim that the changes are compatible.
 */
import { useMemo, useState } from 'react'
import { GitFork } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  conflictKey,
  type ConflictDecision,
  type OverlapKind,
  type PairConflict,
  type TeamTask,
} from '@/lib/coworkTeam'
import {
  useTeamConflictRequests,
  type ConflictRequest,
} from '@/hooks/useTeamConflictRequests'

const KIND: Record<OverlapKind, string> = {
  'same-file': 'same file',
  nested: 'a folder and something inside it',
  rename: 'a move',
  delete: 'a delete',
  generated: 'a regenerated file',
}

type Choice =
  | 'serialize-ab'
  | 'serialize-ba'
  | 'revise-a'
  | 'revise-b'
  | 'parallel'

function decisionFor(
  c: PairConflict,
  choice: Choice,
  scopes: Record<string, string>
): ConflictDecision | null {
  const [a, b] = c.tasks
  const list = (id: string) =>
    (scopes[id] ?? '')
      .split(/[,\n]/)
      .map((one) => one.trim())
      .filter(Boolean)
  switch (choice) {
    case 'serialize-ab':
      return { kind: 'serialize', first: a, then: b }
    case 'serialize-ba':
      return { kind: 'serialize', first: b, then: a }
    case 'revise-a':
      return { kind: 'revise', task: a, writes: list(a) }
    case 'revise-b':
      return { kind: 'revise', task: b, writes: list(b) }
    case 'parallel':
      return { kind: 'parallel' }
  }
}

function ConflictRow({
  conflict,
  tasks,
  choice,
  onChoice,
  scopes,
  onScope,
}: {
  conflict: PairConflict
  tasks: TeamTask[]
  choice: Choice | undefined
  onChoice: (c: Choice) => void
  scopes: Record<string, string>
  onScope: (task: string, text: string) => void
}) {
  const [a, b] = conflict.tasks
  const describe = (id: string) =>
    tasks.find((t) => t.id === id)?.description ?? ''
  const name = `team-conflict-${conflictKey(conflict)}`
  const option = (value: Choice, label: string) => (
    <label className="flex items-center gap-2 text-xs">
      <input
        type="radio"
        name={name}
        value={value}
        checked={choice === value}
        onChange={() => onChoice(value)}
        data-choice={value}
      />
      {label}
    </label>
  )
  const reviseField = (id: string, value: Choice) =>
    choice === value ? (
      <label className="ml-5 flex flex-col gap-1 text-[11px] text-ink-2">
        What {id} may change (comma-separated)
        <input
          className="rounded-md border border-border bg-transparent px-2 py-1 font-mono text-xs"
          value={scopes[id] ?? ''}
          onChange={(e) => onScope(id, e.target.value)}
          data-testid="team-conflict-scope"
          data-task={id}
        />
      </label>
    ) : null

  return (
    <li
      className="rounded-md border border-border p-2"
      data-testid="team-conflict"
      data-tasks={conflict.tasks.join(',')}
    >
      <p className="text-xs font-medium">
        <span className="font-mono">{a}</span> and{' '}
        <span className="font-mono">{b}</span> would both change:
      </p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {conflict.overlaps.map((o) => (
          <li
            key={`${o.paths[0]}>${o.paths[1]}`}
            className="font-mono text-[11px] text-ink-2"
            data-testid="team-conflict-path"
            data-kind={o.kind}
          >
            {o.note} <span className="text-muted-foreground">({KIND[o.kind]})</span>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {a}: {describe(a)}
        <br />
        {b}: {describe(b)}
      </p>
      <fieldset className="mt-2 flex flex-col gap-1">
        <legend className="sr-only">
          What to do about {a} and {b}
        </legend>
        {option('serialize-ab', `Run ${a} first, then ${b}`)}
        {option('serialize-ba', `Run ${b} first, then ${a}`)}
        {option('revise-a', `Change what ${a} may change`)}
        {reviseField(a, 'revise-a')}
        {option('revise-b', `Change what ${b} may change`)}
        {reviseField(b, 'revise-b')}
        {option(
          'parallel',
          'Run them side by side anyway (recorded; each change is still reviewed and checked before it is applied)'
        )}
      </fieldset>
    </li>
  )
}

export function CoworkTeamConflicts({
  sessionId,
}: {
  sessionId: string | null | undefined
}) {
  const request = useTeamConflictRequests((s) =>
    sessionId ? s.bySession[sessionId] : undefined
  )
  if (!request) return null
  // Keyed by the request, so a second round of conflicts -- after a revised
  // scope still overlaps -- starts with nothing chosen.
  return <ConflictForm key={requestKey(request)} request={request} />
}

const requestKey = (r: ConflictRequest) =>
  `${r.callId}:${r.conflicts.map(conflictKey).join(';')}`

function ConflictForm({ request }: { request: ConflictRequest }) {
  const [choices, setChoices] = useState<Record<string, Choice>>({})
  const [scopes, setScopes] = useState<Record<string, string>>(() =>
    Object.fromEntries(request.tasks.map((t) => [t.id, t.writes.join(', ')]))
  )
  const answer = useTeamConflictRequests((s) => s.answer)
  const complete = useMemo(
    () => request.conflicts.every((c) => choices[conflictKey(c)] != null),
    [request.conflicts, choices]
  )

  const submit = () => {
    const decisions: Record<string, ConflictDecision> = {}
    for (const c of request.conflicts) {
      const key = conflictKey(c)
      const choice = choices[key]
      const d = choice ? decisionFor(c, choice, scopes) : null
      if (d) decisions[key] = d
    }
    answer(request.sessionId, { kind: 'decided', decisions })
  }

  return (
    <section
      className="my-2 rounded-md border border-warning/40 bg-warning-tint p-3"
      role="region"
      aria-label="Overlapping team tasks"
      data-testid="team-conflicts"
    >
      <div className="flex items-center gap-2">
        <GitFork size={14} className="text-warning" />
        <p className="text-xs font-medium">
          These tasks would change the same paths with nothing ordering them.
          Nothing has run yet.
        </p>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Compared by the paths each task declared, not by reading the code: no
        overlap here does not mean the changes fit together.
      </p>
      <ul className="mt-2 flex flex-col gap-2">
        {request.conflicts.map((c) => {
          const key = conflictKey(c)
          return (
            <ConflictRow
              key={key}
              conflict={c}
              tasks={request.tasks}
              choice={choices[key]}
              onChoice={(choice) =>
                setChoices((s) => ({ ...s, [key]: choice }))
              }
              scopes={scopes}
              onScope={(task, text) =>
                setScopes((s) => ({ ...s, [task]: text }))
              }
            />
          )
        })}
      </ul>
      <div className="mt-2 flex items-center gap-1">
        <Button
          size="sm"
          disabled={!complete}
          onClick={submit}
          data-testid="team-conflicts-continue"
        >
          Continue
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => answer(request.sessionId, { kind: 'cancel' })}
          data-testid="team-conflicts-cancel"
        >
          Don’t run these tasks
        </Button>
      </div>
    </section>
  )
}
