import {
  sameBinding,
  type Binding,
  type EvidenceLimit as ReadinessEvidenceLimit,
  type WriteDestination,
} from '@/lib/coworkReadiness'
import type { GitStatus } from '@/lib/coworkGit'
import type { FileOrigin } from '@/lib/fileActivity'
import type { AccessMode } from '@/lib/coworkAccess'

/**
 * Where a change went, and what we actually know about who made it.
 *
 * A file being inside the selected repository says nothing about who changed
 * it. Someone's editor, a build, a script they ran an hour ago and a shell
 * command Jan issued all leave the same mark on disk. So origin is never
 * inferred from location: every claim here is backed by evidence, and where
 * there is no evidence the honest answer — "this appeared while Jan was
 * running, and nothing proves Jan caused it" — is a first-class outcome
 * rather than a gap to be filled in with a guess.
 *
 * One ledger, consumed by every surface that talks about changes, so the
 * prompt, the readiness card, Changes, activity and the completion summary
 * cannot describe the same file differently.
 */

/**
 * Where a change landed.
 *
 * The run's own write destination, plus the one the run cannot choose: a path
 * outside every root it knows about, because the folder was detached or is no
 * longer available. Kept as one type with `WriteDestination` rather than a
 * parallel vocabulary, so a destination cannot mean one thing in the readiness
 * card and another in the ledger.
 */
export type ChangeDestination = WriteDestination | 'external'

/** What is actually known about a change. */
export type ChangeEvidence =
  /** A Jan file-tool call that succeeded. The only thing Jan claims. */
  | 'jan-write'
  /** Already different before the run started. Never Jan's. */
  | 'pre-existing'
  /** First seen during the run, with nothing proving causation. */
  | 'observed-in-run'
  /** Not a Git repository, or Git could not be read. Nothing is known. */
  | 'no-evidence'

/** How the working tree looked when the run started. */
export type BaselineState =
  | 'clean'
  | 'dirty'
  | 'non-git'
  | 'git-unavailable'
  /** The capture started but did not finish — a cancelled or aborted run. */
  | 'incomplete'

export type GitBaseline = {
  state: BaselineState
  /**
   * The session and folder this baseline describes.
   *
   * Carried with it, not alongside it: a baseline is only meaningful for the
   * binding it was taken from, and a capture that lands after the user has
   * moved on describes a folder nobody is looking at.
   */
  binding: Binding
  /** Repo-relative paths differing from HEAD, by how they differed. */
  tracked: readonly string[]
  staged: readonly string[]
  untracked: readonly string[]
}

/** A Jan file-tool call, as the transcript recorded it. */
export type JanFileCall = {
  path: string
  /** The run's destination at the time of the call. */
  destination: ChangeDestination
  /** Refused and failed calls did not change anything. */
  ok: boolean
}

/** One file, and everything known about how it came to differ. */
export type OriginEntry = {
  path: string
  destination: ChangeDestination
  evidence: ChangeEvidence
  /**
   * Jan wrote here, and the file was already modified before the run.
   *
   * Both facts are true and both are reported: Jan's write is real, and the
   * rest of that file's diff is not Jan's to claim.
   */
  alsoPreExisting: boolean
}

/**
 * Where a Jan write actually landed.
 *
 * Taken from the run's own frozen destination rather than from the path: a
 * project path under a review-only run cannot have been written at all, and a
 * run that was authorized to edit the folder wrote to the folder. The sandbox
 * and the artifacts directory are the same destination as far as the user is
 * concerned — both are Jan's own space, not their repository.
 */
export function destinationOfOrigin(
  origin: FileOrigin,
  runDestination: ChangeDestination
): ChangeDestination {
  switch (origin) {
    case 'sandbox':
    case 'artifact':
      return 'sandbox'
    case 'external':
      return 'external'
    case 'project':
      return runDestination
  }
}

/** An empty baseline of a given state, for a binding. */
const emptyBaseline = (
  state: BaselineState,
  binding: Binding
): GitBaseline => ({
  state,
  binding,
  tracked: [],
  staged: [],
  untracked: [],
})

/**
 * Read a working-tree snapshot into a baseline.
 *
 * `null` from the backend means the folder is not in a repository, which is a
 * known state rather than a failure: there is simply no Git evidence to be
 * had, and every difference found later is reported as such.
 */
export function baselineFromStatus(
  status: GitStatus | null,
  binding: Binding
): GitBaseline {
  if (!status) return emptyBaseline('non-git', binding)

  const tracked: string[] = []
  const staged: string[] = []
  const untracked: string[] = []
  for (const file of status.files) {
    if (file.status === 'untracked') untracked.push(file.path)
    else if (file.staged) staged.push(file.path)
    else tracked.push(file.path)
  }

  const dirty = tracked.length + staged.length + untracked.length > 0
  return {
    state: dirty ? 'dirty' : 'clean',
    binding,
    tracked,
    staged,
    untracked,
  }
}

/** Git itself could not be consulted. Distinct from "not a repository". */
export const unavailableBaseline = (binding: Binding): GitBaseline =>
  emptyBaseline('git-unavailable', binding)

/** The capture was started but never finished. */
export const incompleteBaseline = (binding: Binding): GitBaseline =>
  emptyBaseline('incomplete', binding)

/**
 * Accept a baseline only if it still describes where the user is.
 *
 * Capturing takes a round trip, and in that time the folder can be swapped or
 * detached. A baseline from the previous binding would make every difference
 * in the new folder look new — the whole working tree attributed to a run
 * that never touched it.
 */
export function acceptBaseline(
  captured: GitBaseline,
  current: Binding
): GitBaseline | null {
  return sameBinding(captured.binding, current) ? captured : null
}

/** Was this path already different when the run started? */
export function wasPreExisting(
  baseline: GitBaseline | null,
  path: string
): boolean {
  if (!baseline) return false
  return (
    baseline.tracked.includes(path) ||
    baseline.staged.includes(path) ||
    baseline.untracked.includes(path)
  )
}

/** Nothing can be known about differences without a usable Git baseline. */
const hasEvidence = (baseline: GitBaseline | null): boolean =>
  baseline !== null &&
  baseline.state !== 'non-git' &&
  baseline.state !== 'git-unavailable' &&
  baseline.state !== 'incomplete'

/**
 * Build the ledger for one run.
 *
 * The order matters. A successful Jan call is direct evidence and outranks
 * everything else, but it never swallows the pre-existing flag. Everything
 * else is a difference we merely *found*, and the only question is whether the
 * baseline proves it was already there.
 */
export function buildOriginLedger(input: {
  /** The baseline taken at run start, or null when none was usable. */
  baseline: GitBaseline | null
  /** Every Jan file-tool call this run made, successful or not. */
  janCalls: readonly JanFileCall[]
  /** Repo-relative paths differing when the run ended. */
  endDifferences: readonly string[]
  /** Where a found difference lives. Never used to infer authorship. */
  destinationOf: (path: string) => ChangeDestination
}): OriginEntry[] {
  const { baseline, janCalls, endDifferences, destinationOf } = input

  const entries: OriginEntry[] = []
  const claimed = new Set<string>()

  // A refused or failed call changed nothing, so it is not a mutation and
  // never appears as one.
  for (const call of janCalls) {
    if (!call.ok || claimed.has(call.path)) continue
    claimed.add(call.path)
    entries.push({
      path: call.path,
      destination: call.destination,
      evidence: 'jan-write',
      alsoPreExisting: wasPreExisting(baseline, call.path),
    })
  }

  for (const path of endDifferences) {
    if (claimed.has(path)) continue
    claimed.add(path)
    entries.push({
      path,
      destination: destinationOf(path),
      // Without a baseline there is no "before" to compare against, so no
      // difference here can be dated — including the ones that predate the
      // run by weeks.
      evidence: !hasEvidence(baseline)
        ? 'no-evidence'
        : wasPreExisting(baseline, path)
          ? 'pre-existing'
          : 'observed-in-run',
      alsoPreExisting: false,
    })
  }

  return entries
}

/**
 * Everything a run knows about where its changes go, frozen at its start.
 *
 * The point of gathering these four facts into one object is that six surfaces
 * — the prompt, readiness, the Code panel, activity, Changes and the
 * completion summary — used to each re-derive them from the session. Six
 * derivations of the same question is six chances to answer it differently,
 * and the one that matters most is the prompt: telling the model the folder is
 * editable while the gate refuses every write makes the run's own account of
 * itself wrong from the first token.
 *
 * So this is derived once, at run start, and read by all of them.
 */
export type RunOrigins = {
  binding: Binding
  access: AccessMode
  destination: ChangeDestination
  /**
   * The working tree as it was before the run, when it could be captured.
   *
   * Null is itself a fact — it means nothing later can be dated — and is why
   * this belongs in the snapshot rather than being looked up per surface.
   */
  baseline: GitBaseline | null
}

/**
 * What the model is told about the attached folder.
 *
 * Read from the run's frozen access rather than the stored preference. A
 * session that remembers editing but holds no live grant is told read-only,
 * because read-only is what the gate will actually do — and a model told
 * otherwise spends the run trying writes that are refused.
 */
export const promptFolderAccess = (
  origins: RunOrigins
): 'read-only' | 'editable' =>
  origins.access === 'edit-folder' && origins.destination === 'repository'
    ? 'editable'
    : 'read-only'

/**
 * What this run will not be able to tell the user afterwards.
 *
 * Surfaced in readiness *before* the run rather than only in the summary
 * after it: someone deciding whether to let an agent loose in a folder should
 * know in advance that nothing it finds will be attributable.
 */
export type { EvidenceLimit } from '@/lib/coworkReadiness'

export const evidenceLimit = (
  baseline: GitBaseline | null
): ReadinessEvidenceLimit => {
  if (!baseline) return 'not-captured'
  switch (baseline.state) {
    case 'clean':
    case 'dirty':
      return 'none'
    default:
      return baseline.state
  }
}

/** The counted shape of a run's changes. Generated, never written by a model. */
export type CompletionSummary = {
  /** Files Jan changed itself, by where they went. */
  janWrites: { destination: ChangeDestination; paths: string[] }[]
  /** Jan wrote to these, and they were already modified beforehand. */
  janWritesOverExisting: string[]
  /** Already different before the run. Not Jan's. */
  preExisting: string[]
  /** Appeared during the run with nothing proving Jan caused them. */
  observed: string[]
  /** Differences with no Git evidence either way. */
  unknown: string[]
  baseline: BaselineState | 'none'
}

const DESTINATION_ORDER: ChangeDestination[] = [
  'repository',
  'managed',
  'sandbox',
  'external',
]

/**
 * Count the ledger into the run's completion summary.
 *
 * Deterministic and application-generated on purpose: the model is the one
 * party in the room that cannot be trusted to report what it changed, because
 * it is reporting on itself from a transcript it also wrote. This is derived
 * from the ledger alone, and the surface that shows it keeps it visually and
 * structurally apart from anything the model said.
 */
export function summarizeRun(
  entries: readonly OriginEntry[],
  baseline: GitBaseline | null
): CompletionSummary {
  const writes = entries.filter((one) => one.evidence === 'jan-write')
  const janWrites = DESTINATION_ORDER.map((destination) => ({
    destination,
    paths: writes
      .filter((one) => one.destination === destination)
      .map((one) => one.path),
  })).filter((group) => group.paths.length > 0)

  const by = (evidence: ChangeEvidence) =>
    entries.filter((one) => one.evidence === evidence).map((one) => one.path)

  return {
    janWrites,
    janWritesOverExisting: writes
      .filter((one) => one.alsoPreExisting)
      .map((one) => one.path),
    preExisting: by('pre-existing'),
    observed: by('observed-in-run'),
    unknown: by('no-evidence'),
    baseline: baseline?.state ?? 'none',
  }
}

/** Does this summary have anything to report at all? */
export const summaryIsEmpty = (summary: CompletionSummary): boolean =>
  summary.janWrites.length === 0 &&
  summary.preExisting.length === 0 &&
  summary.observed.length === 0 &&
  summary.unknown.length === 0
