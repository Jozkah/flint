// Pieces from the desktop's #30–#87: the reply row under an answer, the
// Context window card, and the effort stops, worded as the desktop words them.
import type { ChatDetails, ContextWindowWire, ReplyMeta } from '@/lib/remote/protocol'
import { compact } from './format'
import { I } from './icons'
import { Kv } from './bits'
import { openSheet } from '../state/app'

const tps = (n: number) => `${n.toFixed(1)} t/s`

/** "41.2 t/s · 412 tokens · cached", then "Used N skills". */
export function ReplyRow({ meta }: { meta?: ReplyMeta }) {
  if (!meta) return null
  const facts = [
    meta.tokensPerSecond ? tps(meta.tokensPerSecond) : null,
    meta.outputTokens ? `${meta.outputTokens.toLocaleString()} tokens` : null,
    meta.cache === 'reused' ? 'cached' : null,
  ].filter(Boolean)
  const skills = meta.skills ?? []
  if (!facts.length && !skills.length) return null
  return (
    <div className="rrow" data-testid="reply-row">
      {facts.length > 0 && (
        <button type="button" onClick={() => openSheet('replystats', { meta })}>
          <I n="gauge" size={12} />
          {facts.join(' · ')}
        </button>
      )}
      {skills.length > 0 && (
        <button type="button" className="muted" onClick={() => openSheet('skillsused', { skills })}>
          Used {skills.length} {skills.length === 1 ? 'skill' : 'skills'}
        </button>
      )}
    </div>
  )
}

/** ContextWindowCard: the stacked bar, what is left before compaction, the
 * legend with shares, and the speeds. */
export function ContextCard({
  c,
  speed,
  onCompact,
}: {
  c: ContextWindowWire | null
  speed?: ChatDetails['speed']
  onCompact?: () => void
}) {
  if (!c) return <div className="cwc"><b>Context window</b><span className="muted">Nothing sent yet.</span></div>
  const win = c.windowTokens && c.windowTokens > 0 ? c.windowTokens : null
  const whole = win ? Math.max(win, c.usedTokens) : Math.max(c.usedTokens, 1)
  const buffer = win && c.autoCompactOn ? c.buffer : 0
  const free = win ? Math.max(0, win - c.usedTokens - buffer) : 0
  const until = win && c.autoCompactOn ? Math.max(0, win - buffer - c.usedTokens) : null
  const pct = (n: number) => (n / whole) * 100
  const share = (n: number) => {
    const p = pct(n)
    return p >= 0.1 ? `${p.toFixed(1)}%` : p > 0 ? '<0.1%' : '0%'
  }
  return (
    <div className="cwc" data-testid="context-card">
      <div className="kv">
        <b style={{ color: 'var(--foreground)' }}>Context window</b>
        <span>
          {compact(c.usedTokens)}
          {win ? ` / ${compact(win)} (${Math.round(pct(c.usedTokens))}%)` : ''}
        </span>
      </div>
      <div className="sbar" aria-hidden>
        {c.segments.map((s) => <i key={s.id} style={{ width: `${pct(s.tokens)}%`, background: s.color }} />)}
        {buffer > 0 && <i style={{ width: `${pct(buffer)}%`, background: '#71717a' }} />}
        {win && <i style={{ flex: 1, background: '#3f3f46' }} />}
      </div>
      <div className="kv">
        <span>{until !== null ? `${compact(until)} until auto-compact` : c.autoCompactOn ? '' : 'Auto-compact is off'}</span>
        {onCompact && (
          <button type="button" className="btn sm" onClick={onCompact}>
            Compact session
          </button>
        )}
      </div>
      <div className="leg">
        {c.segments.map((s) => (
          <div key={s.id}>
            <span className="sq" style={{ background: s.color }} />
            <span>{s.label}</span>
            <span className="muted" style={{ marginLeft: 'auto' }}>{compact(s.tokens)}</span>
            <span className="muted" style={{ width: 40, textAlign: 'right' }}>{share(s.tokens)}</span>
          </div>
        ))}
        {buffer > 0 && (
          <div><span className="sq" style={{ background: '#71717a' }} />Autocompact buffer<span className="muted" style={{ marginLeft: 'auto' }}>{compact(buffer)}</span><span className="muted" style={{ width: 40, textAlign: 'right' }}>{share(buffer)}</span></div>
        )}
        {win && (
          <div><span className="sq" style={{ background: '#3f3f46' }} />Free space<span className="muted" style={{ marginLeft: 'auto' }}>{compact(free)}</span><span className="muted" style={{ width: 40, textAlign: 'right' }}>{share(free)}</span></div>
        )}
      </div>
      {speed?.last ? <Kv k="Last reply" v={tps(speed.last)} /> : null}
      {speed?.average ? <Kv k="Avg. speed" v={tps(speed.average)} /> : null}
    </div>
  )
}

