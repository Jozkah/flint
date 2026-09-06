/**
 * The repository map: what the model is told the project contains.
 *
 * The readiness card has had a `repositoryMap` context category since the
 * accounting was built, and it has always measured zero — truthfully, because
 * no map existed. A category that is always zero is a promise the product does
 * not keep, so this module builds the thing the category was named for.
 *
 * Three rules, all of them the same rule from different sides.
 *
 * **The map describes the tree the run can actually read.** It is walked by
 * the backend through the same containment and the same `.gitignore` chain as
 * the code panel (`project_browse::build_map`), so it can never name a path a
 * tool call would then be refused. A map that lists what the agent cannot open
 * is worse than no map: it turns a boundary into a mystery.
 *
 * **Everything omitted is stated.** The walk has three caps (entries, depth,
 * credential-looking names) and this renderer adds a fourth (a byte budget, so
 * a map cannot crowd out the conversation). Each one that fires becomes a line
 * of the map itself. The failure this avoids is a model concluding a file does
 * not exist because a budget quietly ended the listing.
 *
 * **The text is deterministic.** Same tree, same bytes — the walk is ordered
 * and so is the trim. A map that reshuffles between turns would discard the
 * prompt prefix on every step of a run, which is the most expensive possible
 * way to be untidy.
 */

import {
  projectMap,
  type ProjectMap,
  type ProjectMapEntry,
} from '@janhq/tauri-plugin-agent-tools-api'

/**
 * How much of the prompt a map may occupy.
 *
 * 8 KiB is roughly 2k tokens by the estimator Cowork reports with — enough for
 * the shape of an ordinary repository, small enough that a monorepo's map
 * cannot displace the conversation. Chosen as a budget rather than an entry
 * count because bytes are what the context window actually spends.
 */
export const REPO_MAP_MAX_BYTES = 8 * 1024

const encoder = new TextEncoder()

function bytes(text: string): number {
  return encoder.encode(text).length
}

/** A rendered map, with everything it had to leave out. */
export type RepositoryMapRender = {
  /**
   * The block as it appears in the system prompt, heading and all — or the
   * empty string when there is nothing to say, which is not the same as a map
   * that was never built.
   */
  text: string
  entriesShown: number
  /** Entries the byte budget dropped, on top of what the walk itself capped. */
  entriesTrimmed: number
  /** Every omission, in the words the block uses. Exposed for tests and for
   * any surface that wants to report them without re-parsing the text. */
  notes: string[]
}

const EMPTY: RepositoryMapRender = {
  text: '',
  entriesShown: 0,
  entriesTrimmed: 0,
  notes: [],
}

/**
 * One entry, indented by depth.
 *
 * The name alone, not the whole relative path: the indentation already carries
 * the parentage, and repeating it triples the byte cost of a deep tree for no
 * added information. A trailing `/` marks a directory, which is the one thing
 * indentation cannot say on its own.
 */
function line(entry: ProjectMapEntry): string {
  const name = entry.relPath.split('/').pop() ?? entry.relPath
  const indent = '  '.repeat(Math.max(0, entry.depth - 1))
  return `${indent}${name}${entry.isDir ? '/' : ''}`
}

/**
 * Entries in reading order: a parent immediately followed by its children.
 *
 * The walk is breadth-first because that is how a budget should be *spent*;
 * this is how it should be *read*. Re-ordering here rather than in the walk
 * keeps the truncation rule ("the deepest level goes first") intact while
 * still printing a tree a human or a model can follow.
 */
function inReadingOrder(
  entries: readonly ProjectMapEntry[]
): ProjectMapEntry[] {
  const children = new Map<string, ProjectMapEntry[]>()
  for (const entry of entries) {
    const slash = entry.relPath.lastIndexOf('/')
    const parent = slash === -1 ? '' : entry.relPath.slice(0, slash)
    const bucket = children.get(parent)
    if (bucket) bucket.push(entry)
    else children.set(parent, [entry])
  }
  const out: ProjectMapEntry[] = []
  const visit = (parent: string) => {
    for (const entry of children.get(parent) ?? []) {
      out.push(entry)
      if (entry.isDir) visit(entry.relPath)
    }
  }
  visit('')
  // A child whose parent never made it into the map (the entry budget ended
  // mid-level) would otherwise vanish silently. Append the orphans in their
  // original order rather than dropping them.
  if (out.length !== entries.length) {
    const seen = new Set(out.map((one) => one.relPath))
    for (const entry of entries) {
      if (!seen.has(entry.relPath)) out.push(entry)
    }
  }
  return out
}

/**
 * Render a walked project into the block the prompt carries.
 *
 * `maxBytes` bounds the whole block, notes included, so the number the caller
 * budgets for is the number the prompt spends.
 */
export function renderRepositoryMap(
  map: ProjectMap | null | undefined,
  maxBytes: number = REPO_MAP_MAX_BYTES
): RepositoryMapRender {
  if (!map) return EMPTY
  const ordered = inReadingOrder(map.entries)
  if (ordered.length === 0 && map.sensitiveOmitted === 0) return EMPTY

  const notesFor = (trimmed: number): string[] => {
    const notes: string[] = []
    if (map.truncated) {
      notes.push(
        'The walk stopped at its entry limit; deeper levels are missing.'
      )
    }
    if (trimmed > 0) {
      notes.push(
        `${trimmed} more ${trimmed === 1 ? 'entry is' : 'entries are'} not listed here: the map has a size budget.`
      )
    }
    if (map.depthLimited) {
      notes.push('Directories below the depth limit were not descended into.')
    }
    if (map.sensitiveOmitted > 0) {
      notes.push(
        `${map.sensitiveOmitted} credential-looking ${map.sensitiveOmitted === 1 ? 'file is' : 'files are'} omitted by name.`
      )
    }
    if (map.unreadableDirs > 0) {
      notes.push(
        `${map.unreadableDirs} ${map.unreadableDirs === 1 ? 'directory' : 'directories'} could not be read.`
      )
    }
    notes.push(
      'Use `ls` and `read` to confirm anything this map does not settle.'
    )
    return notes
  }

  const assemble = (shown: ProjectMapEntry[], trimmed: number): string =>
    [
      '# Repository map',
      '',
      `${map.dirs} ${map.dirs === 1 ? 'directory' : 'directories'}, ${map.files} ${map.files === 1 ? 'file' : 'files'} found.`,
      '',
      ...shown.map(line),
      '',
      ...notesFor(trimmed),
    ].join('\n')

  const whole = assemble(ordered, 0)
  if (bytes(whole) <= maxBytes) {
    return {
      text: whole,
      entriesShown: ordered.length,
      entriesTrimmed: 0,
      notes: notesFor(0),
    }
  }

  // Over budget. Drop from the deepest entries inward, so what survives is the
  // top of the tree — the part that orients. A binary search on the count,
  // because re-assembling the block for every candidate is the only way to
  // count the notes' own bytes, and the notes change when the trim does.
  const byDepth = [...ordered]
  const deepestFirst = [...ordered].sort((a, b) => b.depth - a.depth)
  const keepable = (count: number): ProjectMapEntry[] => {
    const drop = new Set(
      deepestFirst.slice(0, byDepth.length - count).map((e) => e.relPath)
    )
    return byDepth.filter((one) => !drop.has(one.relPath))
  }
  let low = 0
  let high = ordered.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    const shown = keepable(mid)
    if (bytes(assemble(shown, ordered.length - mid)) <= maxBytes) low = mid
    else high = mid - 1
  }
  const shown = keepable(low)
  const trimmed = ordered.length - low
  return {
    text: assemble(shown, trimmed),
    entriesShown: shown.length,
    entriesTrimmed: trimmed,
    notes: notesFor(trimmed),
  }
}

/** What a run got when it asked for a map. */
export type RunRepositoryMap = {
  /** The block to embed, or null when there is no map to embed. */
  text: string | null
  /**
   * Why there is no map, in words a user can act on.
   *
   * Null on success *and* on "there was nothing to map" — an empty repository
   * is a fact about the repository, not a failure of the walk. A run never
   * fails over this: orientation is an aid, and refusing to start without one
   * would trade a real capability for a cosmetic one.
   */
  error: string | null
  /** The render, for any surface that wants the counts without the text. */
  render: RepositoryMapRender | null
}

/**
 * Walk `root` and render its map, or say why not.
 *
 * The walk goes through the backend so containment is enforced where every
 * other project read enforces it. A root of null is not an error: Review with
 * no folder attached has nothing to map, and reporting that as a failure would
 * put a red notice on the ordinary case.
 */
export async function walkRepositoryMap(
  dataFolder: string | null | undefined,
  root: string | null | undefined,
  maxBytes: number = REPO_MAP_MAX_BYTES
): Promise<RunRepositoryMap> {
  if (!root) return { text: null, error: null, render: null }
  if (!dataFolder) {
    return {
      text: null,
      error: 'data folder unavailable',
      render: null,
    }
  }
  try {
    const walked: ProjectMap = await projectMap(dataFolder, root)
    const render = renderRepositoryMap(walked, maxBytes)
    return {
      text: render.text === '' ? null : render.text,
      error: null,
      render,
    }
  } catch (e) {
    return {
      text: null,
      error: e instanceof Error ? e.message : String(e),
      render: null,
    }
  }
}
