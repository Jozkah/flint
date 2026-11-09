import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useAppState } from '@/hooks/useAppState'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  composeMcpPrompt,
  filledMcpArguments,
  mcpPromptTrigger,
  useMcpPrompts,
} from '@/lib/mcpPrompts'
import type { SlashBuiltin } from '@/lib/slashCommands'
import type { Attachment } from '@/types/attachment'
import type { MCPPromptInfo } from '@/services/mcp/types'

/**
 * MCP prompts in the composer's `/` menu: one entry per prompt a running
 * server offers. Picking one asks for its arguments (when it declares any),
 * fetches it from the server and puts the result in the composer as a
 * draft, its images as attachments.
 */
export function useMcpPromptInsert({
  setPrompt,
  addImages,
}: {
  setPrompt: (value: string) => void
  addImages: (images: Attachment[]) => void
}) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const prompts = useMcpPrompts((s) => s.prompts)
  const setPrompts = useMcpPrompts((s) => s.setPrompts)
  // Servers starting or stopping change the tool names; list again then.
  const mcpToolNames = useAppState((s) => s.mcpToolNames)

  useEffect(() => {
    let cancelled = false
    // Never throws into the render: a backend without prompts lists none.
    Promise.resolve()
      .then(() => serviceHub.mcp().listPrompts())
      .then((listed) => {
        if (!cancelled) setPrompts(listed ?? [])
      })
      .catch((error) => {
        console.debug('[mcp] listing prompts failed', error)
      })
    return () => {
      cancelled = true
    }
  }, [serviceHub, setPrompts, mcpToolNames])

  const [mcpFill, setMcpFill] = useState<MCPPromptInfo | null>(null)
  const [busy, setBusy] = useState(false)

  const insertMcpPrompt = useCallback(
    async (prompt: MCPPromptInfo, values: Record<string, string> = {}) => {
      setBusy(true)
      try {
        const content = await serviceHub
          .mcp()
          .getPrompt(prompt.server, prompt.name, filledMcpArguments(values))
        const { text, images } = composeMcpPrompt(prompt, content)
        if (!text && images.length === 0) {
          toast.info(t('common:mcpPrompts.empty', { name: prompt.name }))
          return true
        }
        setPrompt(text)
        if (images.length > 0) addImages(images)
        if (content.omitted > 0) {
          toast.info(t('common:mcpPrompts.omitted', { count: content.omitted }))
        }
        return true
      } catch (error) {
        toast.error(t('common:mcpPrompts.failed', { name: prompt.name }), {
          description: error instanceof Error ? error.message : String(error),
        })
        return false
      } finally {
        setBusy(false)
      }
    },
    [serviceHub, setPrompt, addImages, t]
  )

  /** Insert now when the prompt takes no arguments, else ask for them first. */
  const beginMcpPromptInsert = useCallback(
    (prompt: MCPPromptInfo) => {
      if (prompt.arguments.length === 0) {
        void insertMcpPrompt(prompt)
        return
      }
      setMcpFill(prompt)
    },
    [insertMcpPrompt]
  )

  const submitMcpFill = useCallback(
    async (values: Record<string, string>) => {
      if (!mcpFill) return
      if (await insertMcpPrompt(mcpFill, values)) setMcpFill(null)
    },
    [mcpFill, insertMcpPrompt]
  )

  const mcpBuiltins = useMemo<SlashBuiltin[]>(() => {
    const used = new Set<string>()
    return prompts.map((p) => {
      let name = mcpPromptTrigger(p)
      for (let n = 2; used.has(name); n++) name = `${mcpPromptTrigger(p)}-${n}`
      used.add(name)
      return {
        name,
        description: p.description
          ? `${p.server}: ${p.description}`
          : `${p.server}: ${p.title || p.name}`,
        mcpPrompt: p,
        // Typed in full and sent: the draft is cleared by the send, so the
        // insert lands after it.
        run: () => {
          setTimeout(() => beginMcpPromptInsert(p), 0)
        },
      }
    })
  }, [prompts, beginMcpPromptInsert])

  return {
    mcpBuiltins,
    mcpFill,
    mcpBusy: busy,
    beginMcpPromptInsert,
    submitMcpFill,
    cancelMcpFill: () => setMcpFill(null),
  }
}
