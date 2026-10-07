// Studio's sheets (settings, one result) and the dictation setup sheet.

import { useState } from 'react'
import type { StudioItemWire, StudioModelWire, StudioStatusResult } from '@/lib/remote/protocol'
import { durationText } from '@/lib/studio/helpers'
import { Grab, Kv, Pills } from '../ui/bits'
import { I } from '../ui/icons'
import { client, closeSheet, toast } from '../state/app'
import { invalidate, useRpc } from '../state/rpc'
import { setStudioForm, studioForm } from '../state/studio'
import { Media } from '../ui/studio'
import { t } from '../i18n'

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`

async function call(run: () => Promise<unknown>, ok?: string) {
  try {
    await run()
    if (ok) toast(ok)
  } catch (e) {
    toast(e instanceof Error ? e.message : t('common.didNotWork'))
  } finally {
    invalidate(['studio.'])
  }
}

function ModelRow({ m, s }: { m: StudioModelWire; s: StudioStatusResult }) {
  const loaded = s.resident?.modelId === m.id
  const dl = s.download?.modelId === m.id ? s.download : null
  const sub = loaded
    ? `${t('models.loaded')}${s.engineBackend ? ` · ${s.engineBackend === 'cuda12' ? 'CUDA' : s.engineBackend === 'vulkan' ? 'Vulkan' : 'CPU'}` : ''}`
    : dl
      ? t('studio.sheet.downloading', { pct: Math.round((dl.bytes / Math.max(1, dl.total)) * 100), done: gb(dl.bytes), total: gb(dl.total) })
      : m.installed
        ? t('studio.sheet.notLoaded')
        : t('studio.sheet.notDownloaded', { size: gb(m.totalBytes) })
  return (
    <div className="opt" style={{ borderColor: 'var(--border)' }}>
      <I n={m.kind === 'video' ? 'video' : 'image'} />
      <span className="tx">
        <b>{m.name}</b>
        <small>{sub}</small>
      </span>
      {loaded ? (
        <button type="button" className="btn sm" onClick={() => void call(() => client().rpc('studio.unload', {}), t('studio.sheet.unloaded'))}>
          {t('studio.sheet.unload')}
        </button>
      ) : m.installed ? (
        <button type="button" className="btn sm" disabled={!!s.job} onClick={() => void call(() => client().rpc('studio.load', { modelId: m.id }), t('studio.sheet.loadedToast'))}>
          {t('studio.sheet.load')}
        </button>
      ) : (
        <button type="button" className="btn sm" disabled={!!dl} onClick={() => void call(() => client().rpc('studio.download', { modelId: m.id }), t('studio.sheet.downloadingToast'))}>
          {t('studio.sheet.download')}
        </button>
      )}
    </div>
  )
}

export function StudioSettingsSheet() {
  const kind = studioForm.use((s) => s.kind)
  const form = studioForm.use((s) => s[s.kind])
  const memoryAck = studioForm.use((s) => s.memoryAck)
  const { data: s } = useRpc('studio.status', {})
  const img = kind === 'image'
  const sizes = s?.sizes[kind] ?? []
  return (
    <>
      <Grab />
      <h3>{img ? t('studio.sheet.imageSettings') : t('studio.sheet.videoSettings')}</h3>
      {s && !s.supported && <p className="sh">{t('studio.sheet.unsupported')}</p>}
      {s?.supported && s.models.filter((m) => m.kind === kind).map((m) => <ModelRow key={m.id} m={m} s={s} />)}
      {sizes.length > 0 && (
        <>
          <div className="ssec">{t('studio.sheet.shape')}</div>
          <Pills
            items={sizes.map((z, i) => ({ id: String(i), label: z.label }))}
            value={String(Math.min(form.sizeIndex, sizes.length - 1))}
            onChange={(v) => setStudioForm({ sizeIndex: Number(v) })}
          />
        </>
      )}
      <div className="ssec">{img ? t('studio.sheet.count') : t('studio.sheet.length')}</div>
      {img ? (
        <Pills items={['1', '2', '4'].map((n) => ({ id: n, label: n }))} value={String(form.count)} onChange={(v) => setStudioForm({ count: Number(v) })} />
      ) : (
        <Pills
          items={(s?.videoSeconds ?? [1, 2, 3, 5]).map((n) => ({ id: String(n), label: t('studio.sheet.seconds', { n }) }))}
          value={String(form.seconds)}
          onChange={(v) => setStudioForm({ seconds: Number(v) })}
        />
      )}
      <label className="field">
        {t('studio.sheet.seed')}
        <input inputMode="numeric" placeholder={t('studio.sheet.random')} value={form.seed} onChange={(e) => setStudioForm({ seed: e.target.value.replace(/\D/g, '').slice(0, 10) })} />
      </label>
      <label className="field">
        {t('studio.sheet.avoid')}
        <input placeholder={t('studio.sheet.avoidExample')} value={form.negative} onChange={(e) => setStudioForm({ negative: e.target.value })} />
      </label>
      {!img && s?.memoryWarning && (
        <div className="mcpoff" data-testid="memory-warning">
          <b>{t('studio.sheet.memory', { gb: s.memoryGb ?? t('studio.sheet.little') })}</b>
          <span>{t('studio.sheet.memoryBody', { warning: s.memoryWarning })}</span>
          {memoryAck ? (
            <span>{t('studio.sheet.understood')}</span>
          ) : (
            <button type="button" className="btn sm" onClick={() => studioForm.set({ memoryAck: true })}>
              {t('studio.sheet.understand')}
            </button>
          )}
        </div>
      )}
      {s && (
        <>
          <div className="ssec">{t('models.crumb')}</div>
          <Kv k={s.engineBackend ? s.engineBackend.toUpperCase() : t('models.crumb')} v={s.supported ? (s.engineTag ? t('studio.sheet.installed', { tag: s.engineTag }) : t('studio.sheet.notInstalled')) : t('studio.sheet.notAvailable')} />
          {s.error && <p className="sh" style={{ color: 'var(--destructive)' }}>{s.error}</p>}
        </>
      )}
    </>
  )
}

export function StudioItemSheet({ item }: { item?: StudioItemWire }) {
  const media = useRpc('studio.media', item ? { kind: item.kind, id: item.id } : { kind: 'image', id: '' }, !!item)
  const [busy, setBusy] = useState(false)
  if (!item) return null
  const r = item.recipe
  const save = () => {
    const url = media.data?.dataUrl
    if (!url) return toast(t('studio.sheet.stillLoading'))
    const a = document.createElement('a')
    a.href = url
    a.download = `${item.id}.${item.kind === 'video' ? 'webm' : 'png'}`
    a.click()
    toast(t('studio.sheet.saved'))
  }
  return (
    <>
      <Grab />
      <div className="gi" style={{ cursor: 'default' }}>
        <Media item={item} controls />
      </div>
      <p className="sh" style={{ marginTop: 6 }}>{r.prompt}</p>
      <Kv k={t('studio.sheet.seed')} v={r.seed} />
      <Kv k={t('rightpanel.time')} v={durationText(r.durationMs)} />
      <Kv k={t('chat.model')} v={r.modelName} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
        <button type="button" className="btn" disabled={busy} onClick={() => { setBusy(true); closeSheet(); void call(() => client().rpc('studio.remix', { kind: item.kind, id: item.id }), t('studio.sheet.remixing')) }}>
          {t('studio.sheet.remix')}
        </button>
        <button type="button" className="btn" onClick={save}>
          {t('studio.sheet.save')}
        </button>
        <button type="button" className="btn dan" disabled={busy} onClick={() => { setBusy(true); closeSheet(); void call(() => client().rpc('studio.delete', { kind: item.kind, id: item.id }), t('studio.sheet.deleted')) }}>
          {t('common.delete')}
        </button>
      </div>
    </>
  )
}

export function VoiceSetupSheet() {
  const check = async () => {
    try {
      const r = await client().rpc('voice.status', {})
      invalidate(['voice.status'])
      if (r.ready) {
        closeSheet()
        toast(t('studio.sheet.voiceReady'))
      } else toast(t('studio.sheet.notSetUp'))
    } catch {
      toast(t('pairing.unreachable'))
    }
  }
  return (
    <>
      <Grab />
      <h3>{t('studio.sheet.voiceTitle')}</h3>
      <p className="sh">
        {t('studio.sheet.voiceBody')}
      </p>
      <button type="button" className="btn pri" onClick={() => void check()}>
        {t('pairing.checkAgain')}
      </button>
    </>
  )
}
