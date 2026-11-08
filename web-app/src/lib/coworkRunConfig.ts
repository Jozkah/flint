import type { CoworkToolOptions } from '@/lib/coworkTools'
import type {
  CoworkEnvironmentOptions,
  PromptFolderAccess,
} from '@/lib/coworkPrompt'

export type CoworkRunConfig = CoworkToolOptions & CoworkEnvironmentOptions & {
  /**
   * The model this run is sent with, captured from its session when the run
   * started (janhq/jan#8905). Every step of the run uses it, whatever the
   * global picker says by then; absent, the global selection is used.
   */
  model?: { provider: string; id: string }
  workspacePath: string | null
  readOnlyFolder: string | null
  /** The session's additional attached folders, frozen with the run. */
  extraFolders?: readonly string[]
  /** The `extraFolders` this run's write grant covers; the rest are read-only. */
  writableExtraFolders?: readonly string[]
  /**
   * Whether this run may write to the attached folder.
   *
   * Frozen with the run, from its effective access — so the prompt describes
   * the destination the dispatcher will actually use.
   */
  folderAccess?: PromptFolderAccess
  /** The managed worktree's own branch, when `folderAccess` is `worktree`. */
  worktreeBranch?: string | null
  /** The attached project's git branch, surfaced in the system prompt. */
  gitBranch?: string | null
  /** Verbatim `JAN.md` from the attached folder, when it has one. */
  projectInstructions?: string | null
  /**
   * Compatibility instructions the resolver made active for this run.
   *
   * Frozen with the run like everything else here: configuration edited while
   * a run is going applies to the next one.
   */
  compatInstructions?: readonly { name: string; content: string }[]
  /** The backend's project tooling block, frozen with the run. */
  projectTooling?: string | null
  /**
   * The opening turn reads and proposes rather than acting.
   *
   * Decided per request from what the user typed, and frozen with the run like
   * everything else here.
   */
  openingInspection?: boolean
}
