import { useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Download, History, Play, RotateCcw, Rows3 } from 'lucide-react'
import type { LiveTurn, Participant, Room, RoomJournalRecord } from '@/lib/rooms/types'
import { compareRunOf } from '@/lib/rooms/types'
import {
  answersBy,
  compareGrid,
  hasAnswered,
  participantsMissingEarlier,
  type CompareGrid,
} from '@/lib/rooms/compareGrid'
import { compareExport } from '@/lib/rooms/compareExport'
import { copyToClipboard } from '@/lib/clipboard'
import { exportFileName } from '@/lib/exportMarkdown'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { RoomAvatar } from './RoomAvatar'
import { messagesOf, participantColor } from './roomUi'

type CompareCellState = 'off' | 'unavailable' | 'running' | 'queued' | 'done' | 'failed' | 'idle'

/** Where a participant stands on the newest question. */
function compareCellState(
  room: Room,
  grid: CompareGrid,
  p: Participant,
  lives: LiveTurn[]
): CompareCellState {
  if (lives.some((l) => l.author.kind === 'participant' && l.author.participantId === p.id)) {
    return 'running'
  }
  const latest = grid.questions.at(-1)
  if (latest && hasAnswered(grid, latest.id, p.id)) return 'done'
  if (p.compareSkip) return 'off'
  if (p.availability.state === 'unavailable') return 'unavailable'
  if (latest && answersBy(grid, latest.id, p.id).some((m) => m.status !== 'complete')) {
    return room.status === 'running' ? 'queued' : 'failed'
  }
  return room.status === 'running' && latest ? 'queued' : 'idle'
}

const STATE_TONE: Record<CompareCellState, string> = {
  off: 'text-subtle-foreground',
  unavailable: 'text-destructive',
  running: 'text-primary motion-safe:animate-pulse',
  queued: 'text-muted-foreground',
  done: 'text-foreground',
  failed: 'text-destructive',
  idle: 'text-muted-foreground',
}

/**
 * Compare rooms: run each model on its own (or again), leave one out of the
 * next run, have late models answer the earlier questions, and export the
 * whole comparison.
 */
export function CompareRunPanel({
  room,
  journal,
  liveTurns,
  busy,
  run,
  onToggle,
  onRun,
}: {
  room: Room
  journal: RoomJournalRecord[]
  liveTurns: LiveTurn[]
  busy: boolean
  run: (fn: () => Promise<void>) => void
  onToggle: (p: Participant, include: boolean) => Promise<unknown>
  onRun: (participantIds: string[] | null, scope: 'latest' | 'missing') => Promise<void>
}) {
  const { t } = useTranslation()
  const messages = useMemo(() => messagesOf(journal), [journal])
  const grid = useMemo(() => compareGrid(messages), [messages])
  const [note, setNote] = useState<string | null>(null)
  const lives = liveTurns.filter((l) => l.roomId === room.id)
  const roomRunning = room.status === 'running'
  const hasQuestion = grid.questions.length > 0
  const missing = participantsMissingEarlier(room, grid)
  const people = room.participants.filter((p) => !p.removed).sort((a, b) => a.order - b.order)

  const exportAs = async (kind: 'save-md' | 'copy-md' | 'copy-json') => {
    setNote(null)
    const out = compareExport(room, messages)
    if (kind === 'save-md') {
      try {
        const saved = await invoke<{ path: string } | null>('export_save_file', {
          ext: 'md',
          suggestedName: exportFileName(`${room.title} comparison`, 'md'),
          text: out.markdown,
        })
        if (saved) setNote(t('rooms:compare.saved'))
      } catch (e) {
        setNote(e instanceof Error ? e.message : String(e))
      }
      return
    }
    const text = kind === 'copy-md' ? out.markdown : JSON.stringify(out.json, null, 2)
    setNote(t((await copyToClipboard(text)) ? 'rooms:compare.copied' : 'rooms:compare.copyFailed'))
  }

  return (
    <Frame data-testid="compare-run-panel" className="motion-safe:animate-rise-in">
      <FrameHeader
        icon={<Rows3 />}
        title={t('rooms:compare.title')}
        actions={
          <span className="text-[11.5px] text-muted-foreground" data-testid="compare-run-mode">
            {t(
              compareRunOf(room) === 'one-by-one'
                ? 'rooms:compare.modeOneByOne'
                : 'rooms:compare.modeTogether'
            )}
          </span>
        }
      />
      <FrameBody className="gap-2 p-3.5">
        <ul className="flex flex-col gap-1.5">
          {people.map((p) => {
            const state = compareCellState(room, grid, p, lives)
            const answered = grid.questions.some((q) => answersBy(grid, q.id, p.id).length > 0)
            return (
              <li
                key={p.id}
                data-testid="compare-participant"
                data-state={state}
                className="flex min-w-0 items-center gap-2 rounded-[10px] border-[0.8px] border-border bg-card px-2 py-1.5"
              >
                <RoomAvatar model={p.model} name={p.name} color={participantColor(p.id)} size={22} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-xs font-medium text-foreground">{p.name}</span>
                  <span className={cn('truncate text-[11px]', STATE_TONE[state])}>
                    {t(`rooms:compare.state.${state}`)}
                  </span>
                </div>
                <label className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                  <input
                    type="checkbox"
                    className="size-3.5 accent-[var(--primary)]"
                    checked={!p.compareSkip}
                    disabled={busy || roomRunning}
                    aria-label={t('rooms:compare.includeFor', { name: p.name })}
                    onChange={(e) => run(async () => void (await onToggle(p, e.target.checked)))}
                  />
                  <span className="hidden sm:inline">{t('rooms:compare.include')}</span>
                </label>
                <Button
                  size="sm"
                  variant="surface"
                  className="h-7 shrink-0 px-2 text-[11.5px]"
                  disabled={busy || roomRunning || !hasQuestion || p.availability.state === 'unavailable'}
                  aria-label={t(answered ? 'rooms:compare.runAgainFor' : 'rooms:compare.runFor', {
                    name: p.name,
                  })}
                  onClick={() => run(() => onRun([p.id], 'latest'))}
                >
                  {answered ? <RotateCcw aria-hidden /> : <Play aria-hidden />}
                  {t(answered ? 'rooms:compare.runAgain' : 'rooms:compare.run')}
                </Button>
              </li>
            )
          })}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busy || roomRunning || !hasQuestion}
            onClick={() => run(() => onRun(null, 'latest'))}
          >
            <Play aria-hidden />
            {t('rooms:compare.runAll')}
          </Button>
          {missing.length > 0 && (
            <Button
              size="sm"
              variant="surface"
              data-testid="compare-answer-earlier"
              disabled={busy || roomRunning}
              title={t('rooms:compare.answerEarlierHint')}
              onClick={() => run(() => onRun(null, 'missing'))}
            >
              <History aria-hidden />
              {t('rooms:compare.answerEarlier')}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="surface" disabled={!hasQuestion}>
                <Download aria-hidden />
                {t('rooms:compare.export')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void exportAs('save-md')}>
                {t('rooms:compare.saveMarkdown')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportAs('copy-md')}>
                {t('rooms:compare.copyMarkdown')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportAs('copy-json')}>
                {t('rooms:compare.copyJson')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {note && (
          <p role="status" className="text-xs text-muted-foreground">
            {note}
          </p>
        )}
      </FrameBody>
    </Frame>
  )
}
