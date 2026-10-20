import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { SlashBuiltin } from '@/lib/slashCommands'
import {
  SAVED_DIR,
  listSaved,
  onSavedChanged,
  parseArgsText,
  type SavedWorkflow,
} from '@/lib/savedWorkflows'
import { dataFolderIo } from '@/lib/workflowRuns'

/**
 * The user's saved workflows as `/workflow:<name>` entries of the Cowork `/`
 * menu, which is also their picker. Picking one sends the user's own request to
 * run it; the model then calls `workflow {saved, args}`.
 */
export function useSavedWorkflowBuiltins(send: (text: string) => void): SlashBuiltin[] {
  const [saved, setSaved] = useState<SavedWorkflow[]>([])
  useEffect(() => {
    let alive = true
    const load = async () => {
      const io = await dataFolderIo(SAVED_DIR)
      const all = io ? await listSaved(io) : []
      if (alive) setSaved(all)
    }
    void load()
    const off = onSavedChanged(() => void load())
    return () => {
      alive = false
      off()
    }
  }, [])
  return useMemo(
    () =>
      saved.map((one) => ({
        name: `workflow:${one.name}`,
        description: one.description || one.name,
        argumentHint: one.args.map((a) => `${a}=...`).join(' ') || undefined,
        run: (text: string) => {
          const parsed = parseArgsText(text, one.args)
          if ('error' in parsed) {
            toast.error(parsed.error)
            return
          }
          send(
            `Run the saved workflow "${one.name}" now: call the workflow tool with ` +
              JSON.stringify({ saved: one.name, args: parsed.args })
          )
        },
      })),
    [saved, send]
  )
}
