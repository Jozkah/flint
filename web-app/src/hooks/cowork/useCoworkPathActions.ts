import { toAssetUrl } from '@/lib/assetPath'
import type { CodeOpenOptions, CodePathCheck } from '@/lib/codeOpen'
import { resolveCodePath } from '@/lib/codePathResolve'
import {
  useCallback,
  useMemo,
  useState,
} from 'react'
import { toast } from 'sonner'
import { projectReadFile } from '@janhq/tauri-plugin-agent-tools-api'
import { previewKindFor, resolveInRoot } from '@/lib/coworkPreview'
import { codePathExists } from '@/lib/codePathExists'
import { readTextBounded } from '@/lib/boundedRead'
import { useCoworkSessions, ensureCurrentSession } from '@/hooks/useCoworkSessions'
import { useCoworkOrigins } from '@/hooks/useCoworkOrigins'
import {
  buildOriginLedger,
  destinationOfOrigin,
  summarizeRun,
  type JanFileCall,
  type RunOrigins,
} from '@/lib/coworkOrigins'
import { type CoworkRail } from '@/hooks/useCoworkView'
import {
  isChange,
  type FileActivityEvent,
  type FileOrigin,
} from '@/lib/fileActivity'
import { loadGitStatus } from '@/lib/coworkGit'
import { absoluteChangePath, shortToolPath } from '@/lib/codePathResolve'
import {
  emptyCodePanelState,
  artifactTab,
  openTabAt,
  projectKeyOf,
  projectTab,
  sandboxTab,
  shouldOpenInCode,
  relativeToRoot,
  type CodeTab,
} from '@/lib/coworkCode'
import { isInsideAnyFolder } from '@/lib/coworkFolders'
import { type RailMode } from '@/containers/CoworkRailToolbar'
import { runCarries } from '@/lib/coworkAccess'
import { errorText } from '@/lib/errorText'
import type { RefObject } from 'react'
import type { EffectiveAccess } from '@/lib/coworkAccess'
import type { LiveGrant } from '@/lib/coworkAccess'
import type { CoworkSession } from '@/hooks/useCoworkSessions'
import type { ServiceHub } from '@/services'

export type CoworkPathActionsArgs = {
  paneSessionIdRef: RefObject<string | undefined>
  setRail: (next: CoworkRail) => void
  effective: EffectiveAccess
  folder: string | null
  liveGrant: LiveGrant | undefined
  treeRoot: string | null
  workspacePath: string | null
  extraFolders: string[]
  session: CoworkSession | null
  t: (key: string, options?: Record<string, unknown>) => string
  serviceHub: ServiceHub
  rail: { kind: "preview"; path?: string; root?: string; } | { kind: "diff"; focusPath?: string; } | { kind: "code"; } | { kind: "tasks"; } | { kind: "timeline"; } | { kind: "browser"; } | { kind: "background"; } | null
}

export function useCoworkPathActions({
  paneSessionIdRef,
  setRail,
  effective,
  folder,
  liveGrant,
  treeRoot,
  workspacePath,
  extraFolders,
  session,
  t,
  serviceHub,
  rail,
}: CoworkPathActionsArgs) {
  // The last artifact previewed this session, so re-opening Preview from the
  // rail toolbar returns to it instead of an empty pane.
  const [lastPreviewPath, setLastPreviewPath] = useState<string | undefined>(
    undefined
  )
  const [lastPreviewRoot, setLastPreviewRoot] = useState<string | undefined>(undefined)
  /** Open a tab in the Code panel. `sandbox` marks paths under the session
   * workspace (agent artifacts) rather than the attached project. */
  const openCode = useCallback(
    (tab: CodeTab, options: CodeOpenOptions = {}) => {
      const sid = ensureCurrentSession(paneSessionIdRef.current)
      const store = useCoworkSessions.getState()
      const current = store.sessions.find((s) => s.id === sid)
      store.setCodePanel(
        sid,
        openTabAt(current?.codePanel ?? emptyCodePanelState(), tab, options)
      )
      // In the background the tab is queued without leaving what is on screen.
      if (!options.background) setRail({ kind: 'code' })
    },
    [setRail, paneSessionIdRef]
  )

  /**
   * Open a path a tool acted on, from its widget in the transcript.
   *
   * The path comes from the tool call's own `path` argument — structured
   * data, never text parsed out of the model's prose. It still has to land in
   * an allowed root: paths under the attached project open as project paths,
   * everything else is treated as the session sandbox, which is the only
   * other place the agent can write. Non-source files are left alone rather
   * than opened as code.
   */
  // With a live grant the backend rebases relative paths onto the write
  // root; without one they are the sandbox's.
  const relativeIsProject = !!runCarries(effective, {
    folder,
    grantId: liveGrant?.grantId ?? null,
  }).writeGrant
  const resolveToolPath = useCallback(
    (path: string) =>
      resolveCodePath(path, {
        treeRoot,
        workspacePath,
        extraFolders,
        relativeIsProject,
        hasSession: !!session?.id,
      }),
    [treeRoot, workspacePath, extraFolders, relativeIsProject, session?.id]
  )
  const openToolPath = useCallback(
    (path: string, options?: CodeOpenOptions) => {
      if (!shouldOpenInCode(path) && previewKindFor(path) !== 'file') {
        const absolute = /^([a-zA-Z]:[\\/]|[\\/])/.test(path)
        const root = absolute
          ? [treeRoot, workspacePath, ...extraFolders].find(
              (candidate) => candidate && resolveInRoot(candidate, path)
            )
          : relativeIsProject ? treeRoot : workspacePath
        if (root) {
          setLastPreviewPath(path)
          setLastPreviewRoot(root)
          setRail({ kind: 'preview', path, root })
        }
        return
      }
      const resolved = resolveToolPath(path)
      // The tree the Code panel browses, so the tab is not born detached in a
      // managed session.
      const projectKey = projectKeyOf(treeRoot)
      if (resolved.kind === 'project' && projectKey) {
        openCode(projectTab(resolved.rel, projectKey), options)
      } else if (resolved.kind === 'sandbox' && session?.id) {
        openCode(sandboxTab(resolved.rel, session.id), options)
      }
    },
    [resolveToolPath, treeRoot, workspacePath, extraFolders, relativeIsProject, openCode, session?.id, setRail]
  )
  /** Why a path cannot be opened, for its tooltip. */
  const checkToolPath = useCallback(
    (path: string): CodePathCheck => {
      if (previewKindFor(path) !== 'file') {
        const absolute = /^([a-zA-Z]:[\\/]|[\\/])/.test(path)
        const root = absolute
          ? [treeRoot, workspacePath, ...extraFolders].find(
              (candidate) => candidate && resolveInRoot(candidate, path)
            )
          : relativeIsProject ? treeRoot : workspacePath
        return root ? { ok: true } : { ok: false, reason: t('common:preview.outside') }
      }
      const resolved = resolveToolPath(path)
      return resolved.kind === 'unresolved'
        ? {
            ok: false,
            reason: t(`common:codePanel.unresolved.${resolved.reason}`),
          }
        : { ok: true }
    },
    [resolveToolPath, treeRoot, workspacePath, extraFolders, relativeIsProject, t]
  )
  /** Does a clicked path's file exist? Only a definite "not found" is false. */
  const toolPathExists = useCallback(
    (path: string) =>
      codePathExists(resolveToolPath(path), {
        project: async (rel) => {
          if (!treeRoot) return
          const dataFolder = await serviceHub.app().getJanDataFolder()
          if (!dataFolder) return
          await projectReadFile(dataFolder, treeRoot, rel, false)
        },
        sandboxMissing: async (rel) => {
          const abs = workspacePath ? resolveInRoot(workspacePath, rel) : null
          if (!abs) return false
          const read = await readTextBounded(await toAssetUrl(abs), {
            maxBytes: 4096,
          })
          return read.status === 'missing'
        },
      }),
    [resolveToolPath, treeRoot, workspacePath, serviceHub]
  )
  /**
   * A tool path as shown: relative to the sandbox or the attached folder it
   * is in, else just its name. The full path stays in the tooltip.
   */
  const displayToolPath = useCallback(
    (path: string) =>
      // Roots in order, for paths the Code panel cannot open (non-source).
      shortToolPath(resolveToolPath(path), path, [
        ...(workspacePath ? [workspacePath] : []),
        ...(treeRoot ? [treeRoot] : []),
        ...extraFolders,
      ]),
    [resolveToolPath, extraFolders, workspacePath, treeRoot]
  )
  // The folders a path in a reply may open from: sandbox, project tree,
  // attached folder and extras.
  const pathLinkRoots = useMemo(
    () =>
      [workspacePath, treeRoot, folder, ...extraFolders].filter(
        (r): r is string => typeof r === 'string' && r.length > 0
      ),
    [workspacePath, treeRoot, folder, extraFolders]
  )
  /**
   * A path in the run summary: the Code panel or preview where one can show
   * it, otherwise the system's default app, so no listed file is a dead label.
   */
  const openSummaryPath = useCallback(
    (path: string) => {
      if (shouldOpenInCode(path) || previewKindFor(path) !== 'file') {
        openToolPath(path)
        return
      }
      const absolute = absoluteChangePath(path, 'session', {
        treeRoot,
        workspacePath,
        resolved: resolveToolPath(path),
      })
      if (!absolute) return
      void serviceHub
        .opener()
        .openPath(absolute, pathLinkRoots)
        .catch((e) => toast.error(errorText(e)))
    },
    [openToolPath, treeRoot, workspacePath, resolveToolPath, serviceHub, pathLinkRoots]
  )
  /** Show a changed file in Changes. */
  const openToolDiff = useCallback(
    (path: string) => setRail({ kind: 'diff', focusPath: path }),
    [setRail]
  )

  /**
   * Which root a path belongs to. The activity record needs this to separate
   * the read-only project from the sandbox the agent writes into.
   */
  const originOfPath = useCallback(
    (path: string): FileOrigin => {
      // Against the tree the run works in, not the attached folder: in a
      // managed session every project path is under the worktree, and matching
      // on the folder would file all of them as external.
      if (treeRoot && relativeToRoot(treeRoot, path) !== path) return 'project'
      if (workspacePath && relativeToRoot(workspacePath, path) !== path)
        return 'sandbox'
      // Every attached folder is inside, not only the primary one.
      if (isInsideAnyFolder(extraFolders, path)) return 'project'
      return 'external'
    },
    [treeRoot, workspacePath, extraFolders]
  )

  /**
   * Write the run's origin ledger, from evidence rather than from the model.
   *
   * Successful Flint file calls are the only thing claimed outright. Everything
   * else found differing at the end is either proved pre-existing by the
   * baseline, reported as merely observed during the run, or — with no usable
   * baseline — reported as unknown. A file being inside the repository is
   * never itself treated as evidence of anything.
   */
  const recordOrigins = useCallback(
    async (input: {
      sessionId: string
      origins: RunOrigins
      events: readonly FileActivityEvent[]
    }) => {
      const { sessionId, origins, events } = input
      const { baseline, binding, destination } = origins
      // Where the changes are, which is not always where the session is
      // attached. Falling back to the folder keeps a ledger recorded before
      // this distinction existed readable.
      const tree = origins.tree ?? binding.folder

      const janCalls: JanFileCall[] = events
        .filter((event) => isChange(event.operation) && event.ok)
        .map((event) => ({
          // Compared against Git's repo-relative paths, so a project path has
          // to be expressed the same way before the two can be matched.
          path:
            event.origin === 'project' && tree
              ? relativeToRoot(tree, event.path)
              : event.path,
          // An extra folder is attached directly, never worktreed, so a
          // write there landed in the user's own folder even in a managed run.
          destination:
            destination === 'managed' &&
            isInsideAnyFolder(extraFolders, event.path)
              ? 'repository'
              : destinationOfOrigin(event.origin, destination),
          ok: true,
        }))

      let endDifferences: string[] = []
      if (tree) {
        try {
          const status = await loadGitStatus(tree, 'all')
          endDifferences = (status?.files ?? []).map((file) => file.path)
        } catch {
          // Nothing found is nothing claimed: a failed read leaves the ledger
          // with Flint's own calls and no assertions about anything else.
        }
      }

      const entries = buildOriginLedger({
        baseline,
        janCalls,
        endDifferences,
        destinationOf: (path) =>
          destinationOfOrigin(
            originOfPath(tree ? `${tree}/${path}` : path),
            destination
          ),
      })
      useCoworkOrigins.getState().record(sessionId, {
        entries,
        summary: summarizeRun(entries, baseline, origins),
        at: Date.now(),
      })
    },
    [originOfPath, extraFolders]
  )

  // Source artifacts open as code, not as a plain-text preview dump.
  const showPreview = useCallback(
    (path: string) => {
      // An artifact is something the agent generated: it lives in the session
      // workspace, never in the user's project.
      // An artifact is something the agent generated: it lives in this
      // session's workspace, never in the user's project.
      if (shouldOpenInCode(path) && session?.id) {
        openCode(artifactTab(path, session.id))
      } else {
        setLastPreviewPath(path)
        setLastPreviewRoot(workspacePath ?? undefined)
        setRail({ kind: 'preview', path, root: workspacePath ?? undefined })
      }
    },
    [openCode, session?.id, setRail, workspacePath]
  )

  // The rail toolbar's four mutually-exclusive modes map onto the rail state
  // (Changes is the diff panel, Activity the tasks panel). Selecting the active
  // mode again closes it, so the toolbar toggles. Code and Preview open into
  // their own empty states, so neither is ever disabled.
  const selectRail = useCallback(
    (mode: RailMode) => {
      if (mode === 'code') ensureCurrentSession(paneSessionIdRef.current)
      const kind =
        mode === 'changes' ? 'diff' : mode === 'activity' ? 'tasks' : mode
      if (rail?.kind === kind) {
        setRail(null)
        return
      }
      setRail(kind === 'preview' ? { kind, path: lastPreviewPath, root: lastPreviewRoot } : { kind })
    },
    [lastPreviewPath, lastPreviewRoot, rail?.kind, setRail, paneSessionIdRef]
  )
  return {
    originOfPath,
    recordOrigins,
    setLastPreviewPath,
    setLastPreviewRoot,
    openToolPath,
    selectRail,
    checkToolPath,
    toolPathExists,
    openToolDiff,
    displayToolPath,
    pathLinkRoots,
    showPreview,
    openSummaryPath,
    resolveToolPath,
    relativeIsProject,
  }
}
