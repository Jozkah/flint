import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { getServiceHub } from '@/hooks/useServiceHub'
import {
  formatPathReferenceText,
  parsePromptForReferences,
  stripPromptReferences,
  typedReference,
} from '@/lib/path-references'
import {
  resolveReference,
  searchReferences,
  unresolvedReferenceNote,
} from '@/lib/safeReferences'
import {
  rankReferences,
  type NamedSource,
  type ReferenceEntry,
} from '@/lib/referenceMenu'
import { resolveAlias, useReferenceAliases } from '@/lib/referenceAliases'
import { TRIGGER_TAIL, mentionTrigger } from '@/lib/chatMentions'
import {
  listConversations,
  listConversationsAsync,
} from '@/lib/chatMentionSources'
import type { LibraryPrompt } from '@/lib/promptLibrary'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * The composer's `@` / `#` menu: detecting the trigger as the user types,
 * ranking files (inside the reference folder), skills, agents, aliases,
 * prompts and conversations, inserting the pick, naming aliases, and
 * resolving the references in a prompt at send time.
 */
export function useReferencePicker({
  referenceRoot,
  referenceSources,
  prompt,
  setPrompt,
  scopeKey,
  currentThreadId,
  libraryPrompts,
  beginPromptInsert,
  focusComposer,
}: {
  referenceRoot?: string | null
  referenceSources?: { skills?: NamedSource[]; agents?: NamedSource[] }
  prompt: string
  setPrompt: (value: string) => void
  scopeKey?: string
  currentThreadId: string | undefined
  libraryPrompts: LibraryPrompt[]
  beginPromptInsert: (
    prompt: LibraryPrompt,
    apply: (text: string) => void,
    cancel?: () => void
  ) => void
  focusComposer: () => void
}) {
  const { t } = useTranslation()
  const [filePickerOpen, setFilePickerOpen] = useState(false)
  const [filePickerQuery, setFilePickerQuery] = useState('')
  const [filePickerEntries, setFilePickerEntries] = useState<ReferenceEntry[]>(
    []
  )
  // The `@` menu's active row, moved from the composer with the arrow keys.
  const [referenceActive, setReferenceActive] = useState(0)
  // A file or folder being named as an alias (AH-205), and why a name failed.
  const [aliasDraft, setAliasDraft] = useState<ReferenceEntry | null>(null)
  const [aliasError, setAliasError] = useState<string | null>(null)
  // Announced: how many references match, or what happened to an alias.
  const [referenceStatus, setReferenceStatus] = useState('')
  // Which character opened the menu: `#` lists conversations only.
  const [menuTrigger, setMenuTrigger] = useState<'@' | '#'>('@')
  // Re-ranks the open menu once the conversation counts have loaded.
  const rerankMenuRef = useRef<(() => void) | null>(null)
  // Whether the menu is open now, for work that finishes after it closed.
  const filePickerOpenRef = useRef(false)
  filePickerOpenRef.current = filePickerOpen
  const referenceListId = useId()
  const referenceSkills = referenceSources?.skills
  const referenceAgents = referenceSources?.agents
  const [workingDir, setWorkingDir] = useState<string | undefined>(undefined)
  // Textarea cursor position snapshot at the time @ was typed
  const filePickerCursorPos = useRef<number | null>(null)

  // The folder references may name, and the data folder the confined reader
  // needs. No folder means no references at all -- not the home directory.
  const [referenceDataFolder, setReferenceDataFolder] = useState<
    string | undefined
  >(undefined)
  // Whatever the mode: a surface that attached a folder (Cowork) names it
  // here, and one that did not gets no references at all.
  useEffect(() => {
    setWorkingDir(referenceRoot ?? undefined)
    if (!referenceRoot) return
    let alive = true
    void getServiceHub()
      .app()
      .getJanDataFolder()
      .then((folder) => {
        if (alive) setReferenceDataFolder(folder ?? undefined)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [referenceRoot])

  // Detect `@` in the prompt text and open the file picker
  const handlePromptChange = useCallback(
    (value: string) => {
      setPrompt(value)

      const cursorIdx = filePickerCursorPos.current ?? value.length

      // Look backwards from current cursor to find the last word starting with
      // @ (the @ must not be glued to a preceding word char, so `user@host`
      // never opens the picker), or a `#` that begins a word and is followed
      // by a letter, which lists conversations only. Files need a folder
      // (AH-204); conversations, skills and prompts do not.
      const beforeCursor = value.slice(0, cursorIdx)
      const atMatch = mentionTrigger(beforeCursor)

      if (atMatch) {
        const query = atMatch.query
        setFilePickerQuery(query)
        setMenuTrigger(atMatch.char)

        // One ranked list. The file index is searched through the backend's
        // confined listing; if it cannot be read the rest are still offered,
        // and typing is never waited on.
        const rank = (files: Awaited<ReturnType<typeof searchReferences>>) => {
          const ranked = rankReferences(query, {
            files,
            skills: referenceSkills ?? [],
            agents: referenceAgents ?? [],
            aliases: useReferenceAliases.getState().list(workingDir),
            prompts: libraryPrompts.map((p) => ({
              id: p.id,
              name: p.name,
              detail: p.folder ?? p.body.slice(0, 80),
            })),
            conversations: listConversations(),
            currentConversationId: scopeKey ?? currentThreadId,
          }, 50, atMatch.char)
          setFilePickerEntries(ranked)
          setReferenceActive(0)
          setReferenceStatus(
            ranked.length === 0
              ? t('chat:composer.referencesNone')
              : t('chat:composer.references', { count: ranked.length })
          )
          rerankMenuRef.current = () => rank(files)
        }
        // Counts and previews of the chats load once per menu opening, then
        // the open menu is ranked again with them.
        if (!filePickerOpen) {
          void listConversationsAsync().then(() => {
            // The menu may have closed while this loaded; ranking it again
            // would announce a status for a menu nobody sees.
            if (filePickerOpenRef.current) rerankMenuRef.current?.()
          })
        }
        const fileQuery =
          atMatch.char === '#' ||
          /^(skill|agent|alias|prompt|chat|session|room):/.test(query)
            ? null
            : query
        if (workingDir && referenceDataFolder && fileQuery !== null) {
          searchReferences(referenceDataFolder, workingDir, fileQuery)
            .then(rank)
            .catch(() => rank([]))
        } else {
          rank([])
        }
        setFilePickerOpen(true)
      } else {
        setFilePickerOpen(false)
      }
    },
    [
      t,
      workingDir,
      referenceDataFolder,
      setPrompt,
      referenceSkills,
      referenceAgents,
      libraryPrompts,
      scopeKey,
      currentThreadId,
      filePickerOpen,
    ]
  )

  // Insert the selected reference into the prompt
  const handleFilePickerSelect = useCallback(
    (entry: ReferenceEntry) => {
      if (filePickerCursorPos.current == null) return

      const beforeCursor = prompt.slice(0, filePickerCursorPos.current)
      const afterCursor = prompt.slice(filePickerCursorPos.current)

      // Replace the `@query` with the entry's token
      const textBefore = beforeCursor.replace(TRIGGER_TAIL, '$1')
      // The identifier, not the label: a folder-relative path, or a typed
      // reference. It means the same thing however it is displayed, and a
      // path cannot name anything outside the folder.
      // A library prompt is pasted as text, not left as a reference.
      if (entry.kind === 'prompt') {
        const found = libraryPrompts.find(
          (p) => `prompt:${p.id}` === entry.token
        )
        setFilePickerOpen(false)
        filePickerCursorPos.current = null
        if (found) {
          beginPromptInsert(
            found,
            (text) => setPrompt(textBefore + text + afterCursor),
            // Cancelling leaves no dangling `@query` behind.
            () => setPrompt(textBefore + afterCursor)
          )
        }
        setTimeout(() => focusComposer(), 0)
        return
      }
      const refText = formatPathReferenceText(entry.token) + ' '
      const newPrompt = textBefore + refText + afterCursor

      setPrompt(newPrompt)
      setFilePickerOpen(false)
      filePickerCursorPos.current = null

      // Focus back on textarea
      setTimeout(() => focusComposer(), 0)
    },
    [prompt, setPrompt, libraryPrompts, beginPromptInsert, focusComposer]
  )

  const handleFilePickerClose = useCallback(() => {
    setFilePickerOpen(false)
    setAliasDraft(null)
    setAliasError(null)
    filePickerCursorPos.current = null
  }, [])

  // Name the file or folder being drafted as an alias (AH-205). Focus goes
  // back to the composer either way, where it was when the draft began.
  const handleAliasSave = useCallback(
    (name: string, lines = '') => {
      if (!aliasDraft) return
      const out = useReferenceAliases
        .getState()
        .add(workingDir, name, aliasDraft.token, lines)
      if (!out.ok) {
        setAliasError(out.message)
        setReferenceStatus(
          t('chat:composer.aliasNotSaved', { message: out.message })
        )
        return
      }
      setAliasDraft(null)
      setAliasError(null)
      setReferenceStatus(
        t('chat:composer.aliasSaved', {
          name: out.alias.name,
          target: out.alias.target,
        })
      )
      setFilePickerEntries((entries) =>
        rankReferences(filePickerQuery, {
          files: entries
            .filter((e) => e.kind === 'file' || e.kind === 'directory')
            .map((e) => ({
              path: e.token,
              name: e.name,
              kind: e.kind as 'file' | 'directory',
              extension: e.extension,
            })),
          skills: referenceSkills ?? [],
          agents: referenceAgents ?? [],
          aliases: useReferenceAliases.getState().list(workingDir),
        })
      )
      setTimeout(() => focusComposer(), 0)
    },
    [
      aliasDraft,
      workingDir,
      filePickerQuery,
      referenceSkills,
      referenceAgents,
      focusComposer,
      t,
    ]
  )

  const handleAliasCancel = useCallback(() => {
    setAliasDraft(null)
    setAliasError(null)
    setTimeout(() => focusComposer(), 0)
  }, [focusComposer])

  // Resolve @path references in the prompt text, returning the resolved content
  const resolvePromptReferences = useCallback(
    async (
      text: string
    ): Promise<{
      text: string
      resolvedContents: string
    }> => {
      const refs = parsePromptForReferences(text)
      // No folder, no references: an `@name` in an ordinary chat is left as
      // typed. It used to be read as a path -- relative to nothing, or
      // absolute -- so `@C:\Users\me\.ssh\id_rsa` put that file in the prompt.
      if (refs.length === 0 || !workingDir)
        return { text, resolvedContents: '' }

      const parts: string[] = []
      const unresolved = new Set<string>()
      for (const ref of refs) {
        const typed = typedReference(ref)
        // A skill reference is acted on by the skill machinery, which reads
        // it from the text; it stays there and needs nothing inlined.
        if (typed?.kind === 'skill') continue
        // A conversation mention is resolved separately, with or without a
        // folder (chatMentionSend.ts).
        if (
          typed?.kind === 'chat' ||
          typed?.kind === 'session' ||
          typed?.kind === 'room'
        )
          continue
        if (typed?.kind === 'agent') {
          const agent = referenceAgents?.find((one) => one.name === typed.name)
          parts.push(
            agent
              ? `[Agent @agent:${agent.name}${agent.description ? `: ${agent.description}` : ''}. To hand work to it, call the task tool with agent "${agent.name}".]`
              : `[Reference @${ref} was not included: there is no saved agent named ${typed.name}]`
          )
          continue
        }
        if (typed?.kind === 'alias') {
          const alias = await resolveAlias(
            referenceDataFolder ?? '',
            workingDir,
            typed.name
          )
          parts.push(
            alias.ok
              ? alias.content
              : `[Reference @${ref} was not included: ${alias.message}]`
          )
          continue
        }
        const resolved = await resolveReference(
          referenceDataFolder ?? '',
          workingDir,
          ref
        )
        if (resolved.ok) {
          parts.push(resolved.content)
        } else {
          unresolved.add(ref)
          // Said in the message, not dropped: the model should know a
          // reference was refused, and why, rather than miss it silently.
          // A name that matched no file stays silent (pasted code, emails).
          const note = unresolvedReferenceNote(ref, resolved)
          if (note) parts.push(note)
        }
      }

      const resolvedContents = parts.join('\n\n')

      // Remove @ references from the prompt text (they'll be replaced by the
      // resolved contents above so the model sees the content directly)
      const cleanText = stripPromptReferences(text, unresolved)

      return { text: cleanText, resolvedContents }
    },
    [workingDir, referenceDataFolder, referenceAgents]
  )

  /** The menu's keys: move, pick, close, and Alt+A to name an alias. */
  const handleReferenceKeyDown = (event: React.KeyboardEvent) => {
    if (filePickerOpen && !aliasDraft) {
      const count = filePickerEntries.length
      const active = filePickerEntries[Math.min(referenceActive, count - 1)]
      if (count > 0 && event.key === 'ArrowDown') {
        event.preventDefault()
        setReferenceActive((index) => (index + 1) % count)
      } else if (count > 0 && event.key === 'ArrowUp') {
        event.preventDefault()
        setReferenceActive((index) => (index - 1 + count) % count)
      } else if (active && (event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
        event.preventDefault()
        handleFilePickerSelect(active)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        handleFilePickerClose()
      } else if (event.altKey && event.key.toLowerCase() === 'a' && active) {
        event.preventDefault()
        if (active.kind === 'file' || active.kind === 'directory') {
          setAliasDraft(active)
          setAliasError(null)
          setReferenceStatus(`Name ${active.token} as an alias`)
        } else {
          setReferenceStatus('Only a file or folder can be named')
        }
      }
    }
  }

  return {
    filePickerOpen,
    filePickerQuery,
    filePickerEntries,
    referenceActive,
    setReferenceActive,
    aliasDraft,
    setAliasDraft,
    aliasError,
    setAliasError,
    referenceStatus,
    setReferenceStatus,
    menuTrigger,
    referenceListId,
    workingDir,
    filePickerCursorPos,
    handlePromptChange,
    handleFilePickerSelect,
    handleFilePickerClose,
    handleAliasSave,
    handleAliasCancel,
    handleReferenceKeyDown,
    resolvePromptReferences,
  }
}
