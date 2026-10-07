// A Cowork session's changes, as the desktop shows them: the bars above the
// composer (files ready for review, the worktree's branch, the pull request),
// the one-line What changed after a run, the Changes list with its diffs, and
// the Activity list. Read-only: applying and merging happen on the computer.
import { useState } from 'react'
import type { ChangedFile, CoworkActivity, CoworkChanges } from '@/lib/remote/protocol'
import { Empty } from './bits'
import { I } from './icons'
import { openDrawer, openSheet, toast } from '../state/app'
import { t } from '../i18n'

function totals(files: ChangedFile[]) {
  return {
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  }
}

/** One write's diff (`+ ` / `- ` lines, as Cowork records them). */
export function Diff({ text }: { text: string }) {
  const lines = text.split('\n').filter((l, i, all) => l || i < all.length - 1)
  return (
    <div className="diff hunk">
      {lines.map((l, i) => {
        const sign = l.startsWith('+') ? '+' : l.startsWith('-') ? '−' : ''
        const body = sign ? l.slice(l[1] === ' ' ? 2 : 1) : l.replace(/^ {2}/, '')
        return (
          <div key={i} className={sign === '+' ? 'a' : sign ? 'r' : undefined}>
            <span className="ln" />
            <span className="sg">{sign}</span>
            <span>{body}</span>
          </div>
        )
      })}
    </div>
  )
}

/** The bars above the composer. */
export function ChangeBars({ c }: { c: CoworkChanges }) {
  const [more, setMore] = useState(false)
  const tot = totals(c.files)
  const pr = c.pr
  const extra = pr && (pr.conflicts || pr.checks.failed > 0)
  return (
    <div className="bars" data-testid="change-bars">
      {c.files.length > 0 && (
        <div className="frame bar1">
          <I n="file" />
          <b>{t('changes.filesReady', { count: c.files.length })}</b>
          <span className="add">+{tot.additions}</span>
          <span className="del">−{tot.deletions}</span>
          <span className="sp" />
          <button type="button" className="btn sm" onClick={() => openDrawer('right', 'changes')}>
            {t('changes.review')}
          </button>
        </div>
      )}
      {c.worktree && (
        <div className="frame bar1" style={{ flexWrap: 'wrap' }}>
          <I n="branch" />
          <b className="mono" style={{ fontSize: 12 }}>
            {c.worktree.branch ?? t('changes.workingCopy')}
          </b>
          <span className="sp" />
          <button type="button" className="btn sm ghost" aria-label={t('changes.worktree')} onClick={() => openSheet('worktree', { path: c.worktree?.path, branch: c.worktree?.branch })}>
            <I n="more" />
          </button>
        </div>
      )}
      {pr && extra && !more && (
        <button type="button" className="morebars" onClick={() => setMore(true)}>
          {t('changes.showMore', { what: pr.conflicts ? t('changes.conflicts') : 'CI' })}
        </button>
      )}
      {pr && (!extra || more) && (
        <div className={`frame bar1 prbar${pr.conflicts ? ' conflict' : ''}`}>
          <I n="pr" />
          <b>#{pr.number}</b>
          <span className="muted" style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {pr.title}
          </span>
          <span className="sp" />
          {pr.conflicts && (
            <button type="button" className="chip err" onClick={() => toast(t('changes.resolveOnComputer'))}>
              <span className="d" />
              {t('changes.conflicts')}
            </button>
          )}
          <span className={`chip ${pr.checks.failed ? 'err' : pr.checks.pending ? 'warn' : 'ok'}`}>
            <span className="d" />
            {pr.checks.failed ? t('changes.ciFailed', { count: pr.checks.failed }) : pr.checks.pending ? t('changes.ciRunning') : t('changes.ciPassed')}
          </span>
        </div>
      )}
    </div>
  )
}

/** "What changed", one quiet line after a run, opening to the files. */
export function WhatChanged({ c }: { c: CoworkChanges }) {
  if (!c.summary) return null
  return (
    <details className="wcline" data-testid="what-changed">
      <summary>
        <b title={t('changes.recordedBy')}>{t('changes.whatChanged')}</b>
        <span className="muted">{c.summary}</span>
        <I n="chev" size={13} style={{ marginLeft: 'auto', color: 'var(--subtle-foreground)' }} />
      </summary>
      <div className="frame wc" style={{ margin: '8px 0 0' }}>
        <div className="sec" style={{ borderTop: 0 }}>
          <span className="lbl">{t('changes.whereResult')}</span>
          {c.worktree ? t('changes.inWorktree') : c.applyOnDesktop ? t('changes.inReviewCopy') : t('changes.inFolder')}
          {c.files.map((f) => (
            <div key={f.path} className="fl">
              <span>{f.path}</span>
              <span>
                <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </details>
  )
}

export function ChangesList({ c }: { c: CoworkChanges }) {
  const [open, setOpen] = useState<string | null>(null)
  if (!c.files.length) return <Empty>{t('changes.none')}</Empty>
  return (
    <>
      <div className="lbl">
        {t('changes.output', { where: c.worktree ? t('changes.sessionWorktree') : c.applyOnDesktop ? t('changes.reviewCopy') : t('changes.folder') })}
      </div>
      <div className="card2" style={{ padding: 0, overflow: 'hidden' }} data-testid="changes-list">
        {c.files.map((f) => (
          <div key={f.path}>
            <button
              type="button"
              className="kv"
              style={{ all: 'unset', display: 'flex', width: '100%', boxSizing: 'border-box', padding: '10px 12px', gap: 8, alignItems: 'center', borderTop: '.8px dashed var(--border)', cursor: 'pointer' }}
              onClick={() => setOpen((o) => (o === f.path ? null : f.path))}
              aria-expanded={open === f.path}
            >
              <span className="mono" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
                {f.path}
              </span>
              <span className="add">+{f.additions}</span>
              <span className="del">−{f.deletions}</span>
            </button>
            {open === f.path && (
              <div style={{ padding: '0 12px 10px' }}>
                <small className="muted">{t('changes.by', { source: f.source })}</small>
                {f.hunks.map((h, i) => (
                  <Diff key={i} text={h} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {c.applyOnDesktop && (
        <p className="sh" style={{ margin: '8px 0 0' }}>
          {t('changes.applyOnComputer')}
        </p>
      )}
    </>
  )
}

const STATUS: Record<string, [string, string]> = {
  running: ['warn live', t('changes.status.running')],
  queued: ['', t('changes.status.queued')],
  done: ['ok', t('changes.status.done')],
  failed: ['err', t('changes.status.failed')],
  awaiting: ['warn', t('changes.status.awaiting')],
}

export function ActivityList({ a }: { a: CoworkActivity }) {
  const rows = [
    ...a.subagents.map((s) => ({ id: s.id, kind: 'Agent', title: s.name, sub: t('changes.toolCalls', { count: s.steps }), status: s.status as string })),
    ...a.commands.map((c) => ({ id: c.id, kind: 'Command', title: c.command, sub: '', status: c.status as string })),
  ]
  if (!rows.length) return <Empty>{t('changes.noActivity')}</Empty>
  const running = rows.filter((r) => r.status === 'running' || r.status === 'queued' || r.status === 'awaiting')
  const finished = rows.filter((r) => !running.includes(r))
  const row = (r: (typeof rows)[number]) => {
    const [cls, word] = STATUS[r.status] ?? ['', r.status]
    return (
      <div key={r.id} className="card2" style={{ flexDirection: 'row', alignItems: 'center' }}>
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <b className={r.kind === 'Command' ? 'mono' : undefined} style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {r.title}
          </b>
          <small className="muted">
            {r.kind === 'Command' ? t('changes.command') : t('changes.agent')}
            {r.sub ? ` · ${r.sub}` : ''}
          </small>
        </span>
        <span className={`chip ${cls}`}>
          <span className="d" />
          {word}
        </span>
      </div>
    )
  }
  return (
    <div data-testid="activity-list">
      {running.length > 0 && <div className="lbl">{t('changes.runningCount', { count: running.length })}</div>}
      {running.map(row)}
      {finished.length > 0 && <div className="lbl">{t('changes.finishedCount', { count: finished.length })}</div>}
      {finished.map(row)}
    </div>
  )
}
