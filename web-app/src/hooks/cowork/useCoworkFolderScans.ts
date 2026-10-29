import { errorText } from '@/lib/errorText'
import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { projectReadFile } from '@janhq/tauri-plugin-agent-tools-api'
import {
  COMPATIBILITY_INSTRUCTION_FILES,
  LEGACY_NATIVE_INSTRUCTION_FILE,
  MAX_INSTRUCTION_BYTES,
  NATIVE_INSTRUCTION_FILE,
  bindingKey,
  classifyInstruction,
  isMissingFileError,
  type InstructionFile,
  type InstructionProbe,
} from '@/lib/coworkReadiness'
import {
  listSubagents,
  type SubagentDefinition,
} from '@/lib/coworkSubagentRegistry'
import { loadProjectTooling, type LoadedTooling } from '@/lib/projectTooling'
import type { Dispatch } from 'react'
import type { SetStateAction } from 'react'
import type { RefObject } from 'react'
import type { ServiceHub } from '@/services'

export type CoworkFolderScansArgs = {
  setSubagentDefs: Dispatch<SetStateAction<SubagentDefinition[]>>
  folder: string | null
  setGitBranch: Dispatch<SetStateAction<string | null>>
  setTooling: Dispatch<SetStateAction<{ folder: string; loaded: LoadedTooling | null; } | null>>
  setInstructionFiles: Dispatch<SetStateAction<InstructionFile[]>>
  setProjectInstructions: Dispatch<SetStateAction<string | null>>
  sessionIdRef: RefObject<string | null>
  serviceHub: ServiceHub
  instructionsVersion: number
}

export function useCoworkFolderScans({
  setSubagentDefs,
  folder,
  setGitBranch,
  setTooling,
  setInstructionFiles,
  setProjectInstructions,
  sessionIdRef,
  serviceHub,
  instructionsVersion,
}: CoworkFolderScansArgs) {

  // Saved definitions name the `task` tool's options. Loaded once: the list is
  // only advertised, so a definition added mid-session applies at the next run.
  useEffect(() => {
    let alive = true
    void listSubagents().then((defs) => {
      if (alive) setSubagentDefs(defs)
    })
    return () => {
      alive = false
    }
  }, [setSubagentDefs])

  useEffect(() => {
    if (!folder) {
      setGitBranch(null)
      return
    }
    // Like the tooling effect below: a slow answer for a folder no longer
    // attached must not name the branch of the one that is.
    let alive = true
    invoke<string | null>('agent_git_branch', { project: folder })
      .then((branch) => {
        if (alive) setGitBranch(branch)
      })
      .catch(() => {
        if (alive) setGitBranch(null)
      })
    return () => {
      alive = false
    }
  }, [folder, setGitBranch])

  // Read once per attached folder. A failure is a typed state, never a throw,
  // and never stops the folder from being used.
  useEffect(() => {
    if (!folder) {
      setTooling(null)
      return
    }
    let alive = true
    setTooling({ folder, loaded: null })
    void loadProjectTooling(folder).then((loaded) => {
      if (alive) setTooling({ folder, loaded })
    })
    return () => {
      alive = false
    }
  }, [folder, setTooling])

  // Every instruction file at the attached root, in one pass.
  //
  // `JAN.md` is Flint's own and the only one whose text reaches the model.
  // `AGENTS.md` and `CLAUDE.md` are recognised and reported so a repository
  // written for another harness does not look instruction-less — detected is
  // not the same as ingested, and nothing here reads them into the prompt.
  //
  // Read through the same root-contained reader the code panel uses, so this
  // cannot become a way to pull in a file from outside the attached folder.
  useEffect(() => {
    if (!folder) {
      setInstructionFiles([])
      setProjectInstructions(null)
      return
    }
    // The binding this read belongs to. A result for the previous folder must
    // not land on the current one, so it is compared before anything is set.
    const startedFor = bindingKey({ sessionId: sessionIdRef.current, folder })
    let alive = true
    void (async () => {
      const probe = async (
        name: string,
        role: 'native' | 'compatibility'
      ): Promise<InstructionProbe> => {
        try {
          const dataFolder = await serviceHub.app().getJanDataFolder()
          if (!dataFolder)
            return { name, role, error: 'data folder unavailable' }
          const file = await projectReadFile(dataFolder, folder, name, false)
          if (file.binary) return { name, role, error: 'not text' }
          if (file.oversized) {
            return {
              name,
              role,
              content: 'x'.repeat(MAX_INSTRUCTION_BYTES + 1),
            }
          }
          return { name, role, content: file.content }
        } catch (e) {
          const message = errorText(e)
          // Absent is the ordinary case and is not a failure.
          return isMissingFileError(message)
            ? { name, role }
            : { name, role, error: message }
        }
      }

      // FLINT.md is the native instructions file; JAN.md is the legacy name a
      // project created before the rename still uses. Prefer FLINT.md; fall
      // back to JAN.md only when FLINT.md is simply absent (a FLINT.md that
      // exists but cannot be read is surfaced as-is, not masked by a legacy
      // file). FLINT.md wins when both exist.
      const flintProbe = await probe(NATIVE_INSTRUCTION_FILE, 'native')
      let nativeProbe = flintProbe
      if (flintProbe.content == null && !flintProbe.error) {
        const legacy = await probe(LEGACY_NATIVE_INSTRUCTION_FILE, 'native')
        if (legacy.content != null || legacy.error) nativeProbe = legacy
      }
      const probes = [
        nativeProbe,
        ...(await Promise.all(
          COMPATIBILITY_INSTRUCTION_FILES.map((name) =>
            probe(name, 'compatibility')
          )
        )),
      ]
      if (!alive) return
      if (
        bindingKey({ sessionId: sessionIdRef.current, folder }) !== startedFor
      ) {
        return
      }
      const files = probes.map(classifyInstruction)
      setInstructionFiles(files)
      // The prompt gets exactly what the card calls active, from the same
      // list, so the two cannot describe different runs.
      const native = files.find((file) => file.role === 'native' && file.active)
      setProjectInstructions(native ? (nativeProbe.content ?? null) : null)
    })()
    return () => {
      alive = false
    }
  }, [folder, serviceHub, instructionsVersion, sessionIdRef, setInstructionFiles, setProjectInstructions])
  return {

  }
}
