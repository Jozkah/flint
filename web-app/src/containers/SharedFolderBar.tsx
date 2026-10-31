/* eslint-disable react-refresh/only-export-components */
import { useEffect, useState } from 'react'
import { ChevronDown, GitBranch, Users } from 'lucide-react'
import { BarRow } from '@/components/ui/bar-row'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useSharedFolderView } from '@/hooks/useSharedFolderView'
import {
  sharedFolder,
  type SharedFolderView,
  type SharedHeld,
  type SharedPeer,
} from '@/lib/sharedFolder'
import { cn } from '@/lib/utils'

type TFunction = (key: string, options?: Record<string, unknown>) => string

/** Recent files shown per peer before "+N more". */
export const SHARED_FILES_SHOWN = 5

export type SharedSummary = {
  /** What the row says. */
  text: string
  /** The kind of the most urgent thing, `calm` when there is none. */
  kind: 'hold' | 'branch' | 'waiting' | 'calm'
  urgent: boolean
}

/** The branch the shared tree moved to under this session, if it did. */
export function branchMoved(
  view: SharedFolderView
): { from: string; to: string } | null {
  const { you } = view
  if (you.isolated || !you.startBranch || !view.branch) return null
  return you.startBranch === view.branch
    ? null
    : { from: you.startBranch, to: view.branch }
}

/** The one line the bar (and the narrow strip) shows: the most urgent fact, else who is here. */
export function summarizeShared(
  view: SharedFolderView,
  t: TFunction
): SharedSummary {
  const you = view.you.displayName
  const hold = view.holds[0]
  if (hold)
    return {
      kind: 'hold',
      urgent: true,
      text: holdText(hold, you, t),
    }
  const moved = branchMoved(view)
  if (moved)
    return {
      kind: 'branch',
      urgent: true,
      text: t('common:sharedFolder.branchChanged', moved),
    }
  const waiting = view.others.filter((p) => p.waitingApproval).length
  if (waiting > 0)
    return {
      kind: 'waiting',
      urgent: true,
      text: t('common:sharedFolder.waitingApproval', { count: waiting }),
    }
  // "Working" means a run in flight: idle sessions that finished earlier are
  // still attached to the folder, but saying they are working misleads.
  const working = view.others.filter((p) => p.status === 'running').length
  return {
    kind: 'calm',
    urgent: false,
    text:
      working > 0
        ? t('common:sharedFolder.others', { count: working })
        : t('common:sharedFolder.othersIdle', { count: view.others.length }),
  }
}

function holdText(hold: SharedHeld, you: string, t: TFunction): string {
  return t(
    hold.kind === 'git'
      ? 'common:sharedFolder.holdGit'
      : 'common:sharedFolder.holdEdit',
    { owner: hold.ownerName, target: hold.target, session: you }
  )
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

/** "m:ss" left until `until` (epoch ms). */
export function formatRemaining(until: number, now: number): string {
  const s = Math.max(0, Math.ceil((until - now) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const STATE_DOT: Record<SharedPeer['status'], string> = {
  running: 'bg-info motion-safe:animate-pulse',
  idle: 'bg-subtle-foreground',
  unavailable: 'bg-border',
}

function PeerRow({
  peer,
  onOpen,
}: {
  peer: SharedPeer
  onOpen: (id: string) => void
}) {
  const { t } = useTranslation()
  const files = peer.recentFiles.slice(0, SHARED_FILES_SHOWN)
  const more = peer.recentFiles.length - files.length
  const state = peer.waitingApproval
    ? t('common:sharedFolder.waitingApprovalOne')
    : t(`common:sharedFolder.status.${peer.status}`)
  return (
    <li
      data-testid="shared-peer"
      data-session-id={peer.sessionId}
      className="flex flex-col gap-0.5 py-1.5"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <i
          aria-hidden
          data-testid="shared-peer-dot"
          data-state={peer.waitingApproval ? 'waiting' : peer.status}
          title={state}
          className={cn(
            'size-2 shrink-0 rounded-full',
            peer.waitingApproval
              ? 'bg-warning motion-safe:animate-pulse'
              : STATE_DOT[peer.status]
          )}
        />
        <span className="sr-only">{state}</span>
        <button
          type="button"
          data-testid="shared-peer-open"
          aria-label={t('common:sharedFolder.openSession', {
            name: peer.displayName,
          })}
          onClick={() => onOpen(peer.sessionId)}
          className="min-w-0 truncate text-left text-xs font-medium text-foreground hover:underline focus-visible:underline focus-visible:outline-hidden"
        >
          {peer.displayName}
        </button>
        {peer.branch && (
          <Chip
            mono
            data-testid="shared-peer-branch"
            title={peer.branch}
            className="h-[18px] min-w-0 px-1.5 text-[length:calc(var(--ui-font-base)*0.625)]"
          >
            <GitBranch aria-hidden />
            <span className="truncate">{peer.branch}</span>
          </Chip>
        )}
        {peer.isolated && (
          <Chip
            data-testid="shared-peer-isolated"
            className="h-[18px] px-1.5 text-[length:calc(var(--ui-font-base)*0.625)]"
          >
            {t('common:sharedFolder.isolated')}
          </Chip>
        )}
        <span className="flex-1" />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-testid="shared-peer-message"
          onClick={() => onOpen(peer.sessionId)}
          className="h-6 shrink-0 px-2 text-xs pointer-coarse:h-9"
        >
          {t('common:sharedFolder.message')}
        </Button>
      </div>
      {files.length > 0 && (
        <p
          data-testid="shared-peer-files"
          className="pl-3.5 font-mono text-[length:calc(var(--ui-font-base)*0.6875)] leading-4 break-all text-muted-foreground"
          title={peer.recentFiles.map((f) => f.path).join('\n')}
        >
          {files.map((f) => f.path).join(', ')}
          {more > 0 && (
            <span
              data-testid="shared-peer-files-more"
              className="font-sans text-subtle-foreground"
            >
              {' '}
              {t('common:sharedFolder.moreFiles', { count: more })}
            </span>
          )}
        </p>
      )}
      {peer.claims.length > 0 && (
        <p
          data-testid="shared-peer-claims"
          className="pl-3.5 text-[length:calc(var(--ui-font-base)*0.6875)] leading-4 text-warning"
        >
          {t('common:sharedFolder.editing')}{' '}
          <span className="font-mono break-all">{peer.claims.join(', ')}</span>
        </p>
      )}
    </li>
  )
}

function Allowance({
  sessionId,
  scope,
  until,
  onChanged,
}: {
  sessionId: string
  scope: 'edit' | 'git' | 'all'
  until: number
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const now = useNow(true)
  const left = until - now
  if (left <= 0) return null
  return (
    <li
      data-testid="shared-allowance"
      data-scope={scope}
      className="flex items-center gap-2 py-1 text-xs text-secondary-foreground"
    >
      <span className="min-w-0 flex-1">
        {t(`common:sharedFolder.allowed.${scope}`)}{' '}
        <span className="tabular-nums" data-testid="shared-allowance-left">
          {formatRemaining(until, now)}
        </span>
      </span>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        data-testid="shared-allowance-withdraw"
        className="h-6 shrink-0 px-2 text-xs pointer-coarse:h-9"
        onClick={() => {
          void sharedFolder
            .allow(sessionId, scope, 0)
            .catch(() => undefined)
            .finally(onChanged)
        }}
      >
        {t('common:sharedFolder.withdraw')}
      </Button>
    </li>
  )
}

/**
 * Who else works in this session's folder: one quiet row over the composer
 * (one more bar in the stack, so the narrow strip folds it in with the
 * others), opening in place to each peer, the holds on this session and the
 * time-boxed allowances the user gave it. Nothing renders alone in a folder
 * or without a backend that knows the registry.
 */
export function SharedFolderBar({
  sessionId,
  onOpenSession,
}: {
  sessionId: string | null | undefined
  onOpenSession: (sessionId: string) => void
}) {
  const { t } = useTranslation()
  const { view, refresh } = useSharedFolderView(sessionId)
  const [open, setOpen] = useState(false)
  if (!sessionId || !view || view.others.length === 0) return null
  const summary = summarizeShared(view, t)
  const names = view.others.map((p) => p.displayName).join(', ')
  const active = view.allowances.filter((a) => a.until > Date.now())
  const covered = (scope: 'edit' | 'git') =>
    active.some((a) => a.scope === 'all' || a.scope === scope)
  return (
    <div
      data-testid="shared-folder-bar"
      data-kind={summary.kind}
      data-shared-label={summary.text}
      data-shared-urgent={summary.urgent ? '' : undefined}
      data-shared-count={view.others.length}
      className="mb-1.5 overflow-hidden rounded-[10px] bg-muted shadow-[inset_0_0_0_0.8px_var(--border)]"
    >
      <BarRow
        testId="shared-folder-row"
        icon={
          <Users
            aria-hidden
            className={cn(
              'size-4 shrink-0',
              summary.urgent ? 'text-warning' : 'text-muted-foreground'
            )}
          />
        }
        lead={
          <>
            <span
              data-testid="shared-folder-text"
              className={summary.urgent ? 'text-warning' : undefined}
            >
              {summary.text}
            </span>
            {summary.kind === 'calm' && (
              <span className="text-subtle-foreground"> · {names}</span>
            )}
          </>
        }
        leadTitle={summary.kind === 'calm' ? `${summary.text}: ${names}` : summary.text}
        actions={[]}
        trailing={
          <button
            type="button"
            data-testid="shared-folder-toggle"
            aria-expanded={open}
            aria-label={t(
              open ? 'common:sharedFolder.hide' : 'common:sharedFolder.show'
            )}
            className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-hover-row focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-9"
            onClick={() => setOpen((v) => !v)}
          >
            <ChevronDown
              aria-hidden
              className={cn('size-4 transition-transform', open && 'rotate-180')}
            />
          </button>
        }
      />
      {open && (
        <div
          data-testid="shared-folder-details"
          className="border-t border-border/70 px-3 pb-1.5"
        >
          <ul className="divide-y divide-border/50">
            {view.others.map((p) => (
              <PeerRow key={p.sessionId} peer={p} onOpen={onOpenSession} />
            ))}
          </ul>
          {view.holds.length > 0 && (
            <ul className="border-t border-border/70 pt-1" data-testid="shared-holds">
              {view.holds.map((h, i) => (
                <li
                  key={`${h.kind}:${h.target}:${h.ownerId}`}
                  data-testid="shared-hold"
                  data-kind={h.kind}
                  className="flex flex-col gap-1 py-1.5 text-xs text-warning"
                >
                  {/* The first hold is the row's own text. */}
                  {i > 0 && <span>{holdText(h, view.you.displayName, t)}</span>}
                  {!covered(h.kind) && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      data-testid="shared-allow"
                      data-scope={h.kind}
                      className="h-7 self-start px-2 text-xs pointer-coarse:h-9"
                      onClick={() => {
                        void sharedFolder
                          .allow(sessionId, h.kind)
                          .catch(() => undefined)
                          .finally(refresh)
                      }}
                    >
                      {t(
                        h.kind === 'git'
                          ? 'common:sharedFolder.allowGit'
                          : 'common:sharedFolder.allowEdit'
                      )}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {active.length > 0 && (
            <ul className="border-t border-border/70" data-testid="shared-allowances">
              {active.map((a) => (
                <Allowance
                  key={a.scope}
                  sessionId={sessionId}
                  scope={a.scope}
                  until={a.until}
                  onChanged={refresh}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
