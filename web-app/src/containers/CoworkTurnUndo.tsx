/**
 * Undo and redo the file changes each turn produced. AH-202.
 *
 * The backend keeps the journal: the exact bytes before and after every file
 * a turn's `write` and `edit` calls changed. Undo puts a turn's files back as
 * they were only if every one is still exactly what the turn left -- a file the
 * user edited since, or a later turn touched, refuses the whole undo and is
 * named. Nothing the user wrote themselves is ever in the journal, so nothing
 * they wrote is ever reverted.
 */
import { useCallback, useEffect, useState } from 'react'
import { Redo2, Undo2 } from 'lucide-react'
import {
  redoTurn,
  undoJournal,
  undoTurn,
  type UndoTurnSummary,
} from '@janhq/tauri-plugin-agent-tools-api'
import { Button } from '@/components/ui/button'
import { changedByText, turnActors } from '@/lib/changeActor'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { errorText } from '@/lib/errorText'
import { getServiceHub } from '@/hooks/useServiceHub'

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path

export function CoworkTurnUndo({
  dataFolder: givenDataFolder,
  sessionId,
  writeGrant,
  /** Bumped when a run ends, so a finished turn's changes appear. */
  refreshKey,
  onChanged,
}: {
  /** Resolved from the service hub when not given. */
  dataFolder?: string | null
  sessionId: string
  writeGrant?: string
  refreshKey?: unknown
  /** The files changed; whatever describes them should be re-read. */
  onChanged?: () => void
}) {
  const { t } = useTranslation()
  const [resolvedDataFolder, setResolvedDataFolder] = useState<string | null>(
    null
  )
  useEffect(() => {
    if (givenDataFolder !== undefined) return
    let alive = true
    getServiceHub()
      .app()
      .getJanDataFolder()
      .then((folder) => {
        if (alive) setResolvedDataFolder(folder ?? null)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [givenDataFolder])
  const dataFolder =
    givenDataFolder !== undefined ? givenDataFolder : resolvedDataFolder
  const [turns, setTurns] = useState<UndoTurnSummary[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState<{
    ok: boolean
    text: string
  } | null>(null)

  const load = useCallback(async () => {
    if (!dataFolder) return
    try {
      const found = await undoJournal(dataFolder, sessionId)
      // Checked, not trusted: a panel inside the Cowork page must not be able
      // to take the page down because a reply was not the list it expected.
      setTurns(Array.isArray(found) ? found : [])
    } catch {
      setTurns([])
    }
  }, [dataFolder, sessionId])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const act = async (turn: UndoTurnSummary, undo: boolean) => {
    if (!dataFolder) return
    setBusy(turn.run)
    setStatus(null)
    try {
      const report = await (undo ? undoTurn : redoTurn)(
        dataFolder,
        sessionId,
        turn.run,
        { writeGrant, scope: 'session' }
      )
      setStatus({
        ok: true,
        text: t(undo ? 'common:turnUndo.undone' : 'common:turnUndo.redone', {
          count: report.files,
        }),
      })
      onChanged?.()
    } catch (e) {
      setStatus({ ok: false, text: errorText(e) })
    } finally {
      setBusy(null)
      await load()
    }
  }

  if (turns.length === 0) return null

  // Newest first: the turn someone most likely wants to take back.
  const ordered = [...turns].reverse()
  return (
    <section
      className="border-b border-border px-3 py-2.5"
      aria-label={t('common:turnUndo.title')}
      data-testid="turn-undo"
    >
      <p className="text-xs font-medium text-ink-2">
        {t('common:turnUndo.title')}
      </p>
      {/* The recovery boundary, stated before the buttons rather than learned
          from a refusal. */}
      <p className="mt-0.5 mb-1.5 text-xs text-muted-foreground">
        {t('common:turnUndo.scope')}
      </p>
      <ul className="flex flex-col gap-1">
        {ordered.map((turn, i) => {
          const undone = turn.state === 'undone'
          const label = t('common:turnUndo.turn', {
            n: turns.length - i,
            files: turn.paths.map(baseName).join(', '),
          })
          // AH-110: who changed these files, in words rather than by colour,
          // and inside the row's own label so it is announced with it.
          const who = turnActors(turn)
            .map((actor) => changedByText(actor, t))
            .join('; ')
          return (
            <li
              key={turn.run}
              className="flex items-center gap-2 text-xs"
              data-testid="turn-undo-row"
              data-run={turn.run}
              data-state={turn.state}
            >
              <span
                className="min-w-0 flex-1 truncate"
                title={turn.paths.join('\n')}
              >
                {label}
                {who && (
                  <span
                    className="ml-1 text-muted-foreground"
                    data-testid="turn-undo-actor"
                    data-actor-ids={turnActors(turn)
                      .map((a) => a?.id ?? 'unknown')
                      .join(' ')}
                  >
                    {'\u2014 '}
                    {who}
                  </span>
                )}
              </span>
              {undone ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 pointer-coarse:h-11"
                  disabled={busy !== null}
                  onClick={() => void act(turn, false)}
                  aria-label={`${t('common:turnUndo.redo')}: ${label}. ${who}`}
                  data-testid="turn-redo"
                >
                  <Redo2 size={12} />
                  {t('common:turnUndo.redo')}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 pointer-coarse:h-11"
                  disabled={busy !== null}
                  onClick={() => void act(turn, true)}
                  aria-label={`${t('common:turnUndo.undo')}: ${label}. ${who}`}
                  data-testid="turn-undo-button"
                >
                  <Undo2 size={12} />
                  {t('common:turnUndo.undo')}
                </Button>
              )}
            </li>
          )
        })}
      </ul>
      {/* Announced: an undo that was refused must be heard, not just seen. */}
      <p
        aria-live="polite"
        role={status && !status.ok ? 'alert' : undefined}
        className={
          status?.ok === false
            ? 'mt-1 text-xs text-destructive'
            : 'mt-1 text-xs text-ink-2'
        }
        data-testid="turn-undo-status"
      >
        {status?.text ?? ''}
      </p>
    </section>
  )
}
