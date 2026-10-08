import { useEffect, useRef, useState } from 'react'
import type { StudioKindWire } from '@/lib/remote/protocol'
import { durationText, phaseLabel } from '@/lib/studio/helpers'
import { TopMain } from '../shell/TopBar'
import { I } from '../ui/icons'
import { Empty, Kv, Loading } from '../ui/bits'
import { DictateButton, insertInto } from '../ui/dictate'
import { client, openSheet, toast } from '../state/app'
import { invalidate, useRpc } from '../state/rpc'
import { progressText, studioForm, studioJob, studioSummary } from '../state/studio'
import { Media, clipLength, parseSeedText } from '../ui/studio'
import { t } from '../i18n'

const STATUS_COLOR: Record<string, string> = {
  making: 'var(--warning)',
  done: 'var(--success)',
  failed: 'var(--destructive)',
  stopped: 'var(--muted-foreground)',
}
const STATUS_WORD: Record<string, string> = { making: t('studio.status.making'), done: t('studio.status.done'), failed: t('studio.status.failed'), stopped: t('studio.status.stopped') }

function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [on])
  return now
}

export default function Studio() {
  const kind = studioForm.use((s) => s.kind)
  const form = studioForm.use((s) => s[s.kind])
  const memoryAck = studioForm.use((s) => s.memoryAck)
  const status = useRpc('studio.status', {})
  const gallery = useRpc('studio.gallery', { kind })
  const live = studioJob.use((s) => s.job)
  const [prompt, setPrompt] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const s = status.data
  // The event stream's job is newer than the status read, once it has spoken.
  const job = live === undefined ? s?.job ?? null : live
  const now = useNow(!!job)
  const items = gallery.data?.items ?? []
  const [shown, setShown] = useState<string | null>(null)
  const preview = items.find((i) => i.id === shown) ?? items[0]
  const img = kind === 'image'

  const make = async () => {
    const text = prompt.trim()
    if (!text) return toast(t('studio.promptFirst'))
    if (!s?.supported) return openSheet('studioset')
    if (!img && s.memoryWarning && !memoryAck) return openSheet('studioset')
    try {
      await client().rpc('studio.generate', {
        kind,
        prompt: text,
        negative: form.negative.trim() || undefined,
        sizeIndex: form.sizeIndex,
        count: img ? form.count : undefined,
        seconds: img ? undefined : form.seconds,
        seed: parseSeedText(form.seed),
        memoryAcknowledged: memoryAck,
      })
      invalidate(['studio.status'])
      toast(img ? t('studio.makingImage') : t('studio.makingVideo'))
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === 'not_ready' || code === 'memory_warning' || code === 'unsupported') openSheet('studioset')
      toast(e instanceof Error ? e.message : t('studio.couldNotStart'))
    }
  }

  const stop = () =>
    void client()
      .rpc('studio.stop', {})
      .then(() => toast(t('studio.stopping')))
      .catch(() => toast(t('studio.couldNotStop')))

  const p = job ? progressText(job, now) : null
  return (
    <>
      <TopMain crumb={t('common.workspace')} title={t('studio.title')} />
      <div className="scroll">
        <div className="segm" role="group" style={{ marginTop: 6 }}>
          {(['image', 'video'] as StudioKindWire[]).map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => { studioForm.set({ kind: k }); setShown(null) }}>
              <I n={k === 'image' ? 'image' : 'video'} />
              {k === 'image' ? t('studio.images') : t('studio.video')}
            </button>
          ))}
        </div>
        {status.loading && !s && <Loading />}
        {s && !s.supported && (
          <Empty>{t('studio.unsupported')}</Empty>
        )}
        <div className="spv" data-testid="studio-preview">
          {preview && <Media item={preview} />}
          {preview && !img && <span className="vbadge">{clipLength(preview)}</span>}
          {job && job.kind === kind && p && (
            <div className="sprog" role="status">
              <b>{p.title}</b>
              <span>
                {phaseLabel(job.phase)}
                {p.left ? ` · ${p.left}` : ''}
              </span>
              <i style={{ width: `${p.percent}%` }} />
              <button type="button" className="btn sm dan" onClick={stop}>
                {t('studio.stop')}
              </button>
            </div>
          )}
        </div>
        {items.length > 1 && (
          <div className="film">
            {items.slice(0, 8).map((i) => (
              <button key={i.id} type="button" aria-label={i.recipe.prompt} onClick={() => setShown(i.id)}>
                <Media item={i} />
              </button>
            ))}
          </div>
        )}
        <div className="cbox" style={{ margin: '8px 0 4px' }}>
          <textarea
            ref={ref}
            rows={2}
            aria-label={t('studio.prompt')}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={img ? t('studio.placeholderImage') : t('studio.placeholderVideo')}
          />
          <div className="crow">
            <button type="button" className="ib" aria-label={t('settings.title')} onClick={() => openSheet('studioset')}>
              <I n="sliders" />
            </button>
            <span className="muted" style={{ fontSize: 11.5, marginRight: 'auto' }} data-testid="studio-summary">
              {studioSummary(kind, form, s?.sizes[kind])}
            </span>
            <DictateButton insert={(words) => insertInto(ref.current, prompt, setPrompt, words)} />
            <button type="button" className={`send${prompt.trim() && !job ? '' : ' off'}`} aria-label={t('studio.make')} onClick={() => void make()}>
              <I n="up" />
            </button>
          </div>
        </div>
        {s && s.activity.length > 0 && (
          <>
            <div className="ssec">{t('studio.activity')}</div>
            <div className="frame" style={{ padding: '4px 10px' }}>
              {s.activity.map((a) => (
                <Kv
                  key={`${a.id}-${a.at}`}
                  className="studio-act"
                  k={<span style={{ color: STATUS_COLOR[a.status] }}>{STATUS_WORD[a.status]}</span>}
                  v={
                    <span style={{ maxWidth: '65%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>
                      {a.status === 'failed' && a.error ? a.error : a.prompt}
                      {a.status === 'done' ? ` · ${durationText(a.durationMs)}` : ''}
                    </span>
                  }
                />
              ))}
            </div>
          </>
        )}
        <div className="ssec">{img ? t('studio.yourImages') : t('studio.yourVideos')}</div>
        {gallery.data && items.length === 0 && <Empty>{t('studio.empty')}</Empty>}
        <div className="gal">
          {items.map((i) => (
            <button key={i.id} type="button" className="gi" aria-label={i.recipe.prompt} onClick={() => openSheet('studioitem', { item: i })}>
              <Media item={i} />
              {!img && <span>{clipLength(i)}</span>}
            </button>
          ))}
        </div>
      </div>
    </>
  )
}
