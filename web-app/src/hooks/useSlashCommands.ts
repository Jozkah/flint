import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  buildSlashItems,
  expandCommand,
  filterSlashItems,
  markSkillMessage,
  qualifiedName,
  resolveSlash,
  slashQuery,
  type SlashBuiltin,
  type SlashCatalogEntry,
  type SlashItem,
} from '@/lib/slashCommands'
import {
  invokeSlashSkill,
  loadSlashCatalog,
  type SlashSurface,
} from '@/lib/slashCatalog'

export type { SlashSurface }

const errorText = (e: unknown) =>
  e instanceof Error ? e.message : typeof e === 'string' ? e : String(e)

export interface UseSlashCommandsOptions {
  surface: SlashSurface
  /** Cowork's folder: its project plugins and skills join the global ones. */
  project?: string | null
  /** Surface-specific built-ins (`/new`). `/help` is always added. */
  builtins?: SlashBuiltin[]
  /** Help text for the always-present `/help`. */
  helpDescription?: string
}

/** What sending a draft should do. */
export type SlashSendResult =
  /** Not a command: send the draft as typed. */
  | { kind: 'plain' }
  /** A built-in ran; clear the draft, send nothing. */
  | { kind: 'handled' }
  /** Send `text` to the model; `display` is what the user typed. */
  | { kind: 'message'; text: string; display: string }
  /** Invocation failed; keep the draft, show `error`. */
  | { kind: 'error'; error: string }

/**
 * The `/` menu and send-time expansion one composer needs. Shared by the
 * Home/Cowork `ChatInput` and the Rooms composer, so all three offer the same
 * commands and expand them the same way.
 *
 * The composer owns its text; it reports every change to `onTextChange`,
 * routes key presses through `onKeyDown` first (true = consumed), and runs a
 * draft through `prepareSend` before sending.
 */
export function useSlashCommands({
  surface,
  project,
  builtins,
  helpDescription = 'List available commands',
}: UseSlashCommandsOptions) {
  const [catalog, setCatalog] = useState<SlashCatalogEntry[]>([])
  const [query, setQuery] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const loadSeq = useRef(0)
  const queryRef = useRef<string | null>(null)

  const refresh = useCallback(async () => {
    const seq = ++loadSeq.current
    const entries = await loadSlashCatalog(surface, project)
    if (seq === loadSeq.current) setCatalog(entries)
  }, [surface, project])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const allBuiltins = useMemo<SlashBuiltin[]>(
    () => [
      ...(builtins ?? []).filter((b) => b.name !== 'help'),
      {
        name: 'help',
        description: helpDescription,
        run: () => setHelpOpen(true),
      },
    ],
    [builtins, helpDescription]
  )

  const items = useMemo(
    () => buildSlashItems(catalog, allBuiltins),
    [catalog, allBuiltins]
  )

  const open = helpOpen || (query !== null && dismissed !== query)
  const visible = useMemo(
    () => (helpOpen ? items : query === null ? [] : filterSlashItems(items, query)),
    [helpOpen, items, query]
  )
  const active = Math.min(activeIndex, Math.max(visible.length - 1, 0))

  const onTextChange = useCallback(
    (text: string) => {
      const next = slashQuery(text)
      // Opening the menu re-reads the catalog, so a plugin installed or
      // toggled since mount shows up without a reload.
      if (queryRef.current === null && next !== null) void refresh()
      queryRef.current = next
      setQuery(next)
      if (next === null) setDismissed(null)
      setActiveIndex(0)
      if (text.length > 0) setHelpOpen(false)
    },
    [refresh]
  )

  const close = useCallback(() => {
    setHelpOpen(false)
    setDismissed(query)
  }, [query])

  /** The text the composer should hold after picking `item`. */
  const pick = useCallback(
    (item: SlashItem) => {
      setHelpOpen(false)
      queryRef.current = null
      setQuery(null)
      setDismissed(null)
      setActiveIndex(0)
      return `/${item.trigger} `
    },
    []
  )

  /**
   * Key handling while the menu is open. Returns the new text when a row was
   * picked, `true` when the key was otherwise consumed, false when the
   * composer should handle it.
   */
  const onKeyDown = useCallback(
    (e: {
      key: string
      shiftKey?: boolean
      preventDefault: () => void
      nativeEvent?: { isComposing?: boolean }
    }): string | boolean => {
      if (!open || e.nativeEvent?.isComposing) return false
      const count = visible.length
      if (count === 0 && !helpOpen) return false
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
        return true
      }
      if (count === 0) return false
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((active + 1) % count)
        return true
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((active - 1 + count) % count)
        return true
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
        e.preventDefault()
        return pick(visible[active])
      }
      return false
    },
    [open, helpOpen, visible, active, close, pick]
  )

  /** Expand a draft for sending. */
  const prepareSend = useCallback(
    async (text: string): Promise<SlashSendResult> => {
      const hit = resolveSlash(text, items)
      if (!hit) return { kind: 'plain' }
      const { item, args } = hit
      const display = text.trim()
      if (item.builtin) {
        await item.builtin.run(args)
        return { kind: 'handled' }
      }
      if (item.kind === 'command' && item.entry) {
        return { kind: 'message', text: expandCommand(item.entry, args), display }
      }
      const name = qualifiedName(item)
      try {
        const message = await invokeSlashSkill(surface, project, name, args)
        return { kind: 'message', text: markSkillMessage(name, args, message), display }
      } catch (e) {
        return { kind: 'error', error: errorText(e) }
      }
    },
    [items, surface, project]
  )

  /** Whether a draft names a built-in (which needs no model to run). */
  const isBuiltin = useCallback(
    (text: string) => Boolean(resolveSlash(text, items)?.item.builtin),
    [items]
  )

  return {
    items,
    isBuiltin,
    visible,
    open: open && (visible.length > 0 || helpOpen),
    helpOpen,
    query,
    activeIndex: active,
    setActiveIndex,
    onTextChange,
    onKeyDown,
    pick,
    close,
    prepareSend,
    refresh,
  }
}

export type SlashCommandsController = ReturnType<typeof useSlashCommands>
