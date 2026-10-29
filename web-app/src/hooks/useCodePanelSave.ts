import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { CodePanelState, CodeTab } from '@/lib/coworkCode'
import {
  checkDisk,
  discardBuffer,
  dropBuffer,
  isDirty,
  markSaved,
  type Buffers,
  type EditTarget,
} from '@/lib/coworkCodeEdit'
import type { SaveUserEdit } from '@/lib/coworkCodeSave'
import { withEol, type Eol } from '@/lib/lineEndings'
import { errorText } from '@/lib/errorText'
import { useCodeBuffers, useCoworkUserEdits } from '@/hooks/useCoworkUserEdits'

export type CodeConflict = {
  id: string
  /** What the file holds on disk now. */
  disk: string
  /** Raised by a save attempt, which Overwrite then completes. */
  fromSave: boolean
}

export type PendingClose = { ids: string[]; next: CodePanelState }

type Options = {
  active: CodeTab | null | undefined
  activeId: string | null
  sessionKey: string | null
  /** Where saving the active tab writes, or why it cannot. */
  editTarget: EditTarget | null
  editable: boolean
  /** The active file's bytes as read, LF-normalised; undefined until ready. */
  readyContent: string | undefined
  /** How the file on disk ends its lines, put back when the buffer is saved. */
  diskEol: Eol
  buffers: Buffers
  setBuffers: (next: (current: Buffers) => Buffers) => void
  /** Re-read the active file; null when it cannot be read as text. */
  recheckDisk: () => Promise<string | null>
  saveFile: SaveUserEdit
  readRoot?: string | null
  extraFolders?: readonly string[]
  onSaved?: () => void
  onStateChange: (next: CodePanelState) => void
  t: (key: string, opts?: Record<string, unknown>) => string
}

/**
 * Hand-edit lifecycle of the Code rail's active tab: seeding the buffer from
 * disk, saving (with a disk check first), discarding, closing dirty tabs and
 * resolving a conflict between the buffer and newer bytes on disk.
 */
export function useCodePanelSave({
  active,
  activeId,
  sessionKey,
  editTarget,
  editable,
  readyContent,
  diskEol,
  buffers,
  setBuffers,
  recheckDisk,
  saveFile,
  readRoot,
  extraFolders,
  onSaved,
  onStateChange,
  t,
}: Options) {
  const [conflict, setConflict] = useState<CodeConflict | null>(null)
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Seed the buffer from what was read, and keep it in step with the disk:
  // new bytes replace a clean buffer, and raise a conflict under a dirty one
  // rather than overwriting what the user typed.
  useEffect(() => {
    if (!activeId || readyContent === undefined || !editable) return
    // Read the store, not this render's copy: text typed since the render
    // that scheduled this effect must not be seeded over.
    const buffer = sessionKey
      ? useCodeBuffers.getState().bySession[sessionKey]?.[activeId]
      : undefined
    if (!buffer) {
      setBuffers((current) => ({
        ...current,
        [activeId]: { base: readyContent, text: readyContent },
      }))
      return
    }
    const verdict = checkDisk(buffer, readyContent)
    if (verdict === 'refresh') {
      setBuffers((current) => ({
        ...current,
        [activeId]: { base: readyContent, text: readyContent },
      }))
    } else if (verdict === 'conflict') {
      setConflict((c) =>
        c?.id === activeId ? c : { id: activeId, disk: readyContent, fromSave: false }
      )
    }
    // Only when the bytes read change, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, readyContent, editable])

  // Coming back to the window is when an editor elsewhere may have saved.
  useEffect(() => {
    if (!editable || !activeId) return
    const onFocus = () => {
      void recheckDisk().then((disk) => {
        if (disk === null) return
        const buffer = useCodeBuffers.getState().bySession[sessionKey ?? '']?.[
          activeId
        ]
        const verdict = checkDisk(buffer, disk)
        if (verdict === 'refresh') {
          setBuffers((current) => ({
            ...current,
            [activeId]: { base: disk, text: disk },
          }))
        } else if (verdict === 'conflict') {
          setConflict({ id: activeId, disk, fromSave: false })
        }
      })
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [editable, activeId, recheckDisk, sessionKey, setBuffers])

  const writeActive = useCallback(
    async (text: string) => {
      if (!active || !activeId || !sessionKey || !editTarget) return false
      if (editTarget.kind === 'read-only') return false
      setSaving(true)
      setSaveError(null)
      try {
        const outcome = await saveFile({
          sessionId: sessionKey,
          target: editTarget,
          content: withEol(text, diskEol),
          readRoot: readRoot ?? null,
          extraFolders,
        })
        if (!outcome.ok) {
          setSaveError(outcome.error)
          return false
        }
        setBuffers((current) => markSaved(current, activeId, text))
        setConflict(null)
        useCoworkUserEdits.getState().record(sessionKey, {
          path: active.path,
          writtenPath: editTarget.path,
          where: editTarget.kind,
          diff: outcome.diff,
          at: Date.now(),
        })
        onSaved?.()
        toast.success(
          editTarget.kind === 'sandbox' && active.origin.kind === 'project'
            ? t('common:codePanel.savedSandbox', { name: active.path })
            : t('common:codePanel.saved', { name: active.path })
        )
        return true
      } catch (e) {
        setSaveError(errorText(e))
        return false
      } finally {
        setSaving(false)
      }
    },
    [
      active,
      activeId,
      sessionKey,
      editTarget,
      diskEol,
      saveFile,
      readRoot,
      extraFolders,
      setBuffers,
      onSaved,
      t,
    ]
  )

  /**
   * Save the active tab. The disk is read first: if it moved since the
   * editor started from it, the user chooses before anything is overwritten.
   */
  const save = useCallback(async () => {
    if (!activeId || !editable || saving) return false
    const buffer = useCodeBuffers.getState().bySession[sessionKey ?? '']?.[
      activeId
    ]
    if (!buffer || !isDirty(buffer)) return true
    const disk = await recheckDisk()
    if (disk !== null && disk !== buffer.base) {
      setConflict({ id: activeId, disk, fromSave: true })
      return false
    }
    return writeActive(buffer.text)
  }, [activeId, editable, saving, sessionKey, recheckDisk, writeActive])

  const discard = useCallback(() => {
    if (!activeId) return
    setBuffers((current) => discardBuffer(current, activeId))
    setSaveError(null)
  }, [activeId, setBuffers])

  /** Close tabs, asking first when any of them holds unsaved edits. */
  const requestClose = useCallback(
    (ids: string[], next: CodePanelState) => {
      const dirty = ids.filter((id) => isDirty(buffers[id]))
      if (dirty.length > 0) {
        setPendingClose({ ids: dirty, next })
        return
      }
      setBuffers((current) =>
        ids.reduce((acc, id) => dropBuffer(acc, id), current)
      )
      onStateChange(next)
    },
    [buffers, setBuffers, onStateChange]
  )

  const confirmClose = useCallback(
    async (choice: 'save' | 'discard' | 'cancel') => {
      const pending = pendingClose
      if (!pending) return
      if (choice === 'cancel') {
        setPendingClose(null)
        return
      }
      if (choice === 'save') {
        // Only offered for the active tab, the one the editor can save.
        const ok = await save()
        if (!ok) return
      }
      setPendingClose(null)
      setBuffers((current) =>
        pending.ids.reduce((acc, id) => dropBuffer(acc, id), current)
      )
      onStateChange(pending.next)
    },
    [pendingClose, save, setBuffers, onStateChange]
  )

  const resolveConflict = useCallback(
    async (choice: 'overwrite' | 'reload' | 'keep') => {
      const c = conflict
      if (!c) return
      if (choice === 'keep') {
        // Keep editing against the new disk: the next save overwrites it.
        setBuffers((current) => ({
          ...current,
          [c.id]: { base: c.disk, text: current[c.id]?.text ?? c.disk },
        }))
        setConflict(null)
        return
      }
      if (choice === 'reload') {
        setBuffers((current) => ({
          ...current,
          [c.id]: { base: c.disk, text: c.disk },
        }))
        setConflict(null)
        return
      }
      const text = buffers[c.id]?.text
      if (text === undefined) return
      await writeActive(text)
    },
    [conflict, buffers, setBuffers, writeActive]
  )

  return {
    conflict,
    pendingClose,
    saving,
    saveError,
    save,
    discard,
    requestClose,
    confirmClose,
    resolveConflict,
  }
}
