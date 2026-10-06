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

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`

async function call(run: () => Promise<unknown>, ok?: string) {
  try {
    await run()
    if (ok) toast(ok)
  } catch (e) {
    toast(e instanceof Error ? e.message : 'That did not work')
  } finally {
    invalidate(['studio.'])
  }
}

function ModelRow({ m, s }: { m: StudioModelWire; s: StudioStatusResult }) {
  const loaded = s.resident?.modelId === m.id
  const dl = s.download?.modelId === m.id ? s.download : null
  const sub = loaded
    ? `Loaded${s.engineBackend ? ` · ${s.engineBackend === 'cuda12' ? 'CUDA' : s.engineBackend === 'vulkan' ? 'Vulkan' : 'CPU'}` : ''}`
    : dl
      ? `Downloading ${Math.round((dl.bytes / Math.max(1, dl.total)) * 100)}% · ${gb(dl.bytes)} of ${gb(dl.total)}`
      : m.installed
        ? 'Not loaded'
        : `Not downloaded · ${gb(m.totalBytes)}`
  return (
    <div className="opt" style={{ borderColor: 'var(--border)' }}>
      <I n={m.kind === 'video' ? 'video' : 'image'} />
      <span className="tx">
        <b>{m.name}</b>
        <small>{sub}</small>
      </span>
      {loaded ? (
        <button type="button" className="btn sm" onClick={() => void call(() => client().rpc('studio.unload', {}), 'Unloaded')}>
          Unload
        </button>
      ) : m.installed ? (
        <button type="button" className="btn sm" disabled={!!s.job} onClick={() => void call(() => client().rpc('studio.load', { modelId: m.id }), 'Loaded')}>
          Load
        </button>
      ) : (
        <button type="button" className="btn sm" disabled={!!dl} onClick={() => void call(() => client().rpc('studio.download', { modelId: m.id }), 'Downloading on the computer')}>
          Download
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
      <h3>{img ? 'Image' : 'Video'} settings</h3>
      {s && !s.supported && <p className="sh">Studio is not available on this system yet.</p>}
      {s?.supported && s.models.filter((m) => m.kind === kind).map((m) => <ModelRow key={m.id} m={m} s={s} />)}
      {sizes.length > 0 && (
        <>
          <div className="ssec">Shape</div>
          <Pills
            items={sizes.map((z, i) => ({ id: String(i), label: z.label }))}
            value={String(Math.min(form.sizeIndex, sizes.length - 1))}
            onChange={(v) => setStudioForm({ sizeIndex: Number(v) })}
          />
        </>
      )}
      <div className="ssec">{img ? 'Number of images' : 'Clip length'}</div>
      {img ? (
        <Pills items={['1', '2', '4'].map((n) => ({ id: n, label: n }))} value={String(form.count)} onChange={(v) => setStudioForm({ count: Number(v) })} />
      ) : (
        <Pills
          items={(s?.videoSeconds ?? [1, 2, 3, 5]).map((n) => ({ id: String(n), label: `${n} s` }))}
          value={String(form.seconds)}
          onChange={(v) => setStudioForm({ seconds: Number(v) })}
        />
      )}
      <label className="field">
        Seed
        <input inputMode="numeric" placeholder="Random" value={form.seed} onChange={(e) => setStudioForm({ seed: e.target.value.replace(/\D/g, '').slice(0, 10) })} />
      </label>
      <label className="field">
        Things to avoid
        <input placeholder="blurry, text" value={form.negative} onChange={(e) => setStudioForm({ negative: e.target.value })} />
      </label>
      {!img && s?.memoryWarning && (
        <div className="mcpoff" data-testid="memory-warning">
          <b>This computer has {s.memoryGb ?? 'little'} GB of memory</b>
          <span>Video may run out of memory below 32 GB. {s.memoryWarning}</span>
          {memoryAck ? (
            <span>Understood.</span>
          ) : (
            <button type="button" className="btn sm" onClick={() => studioForm.set({ memoryAck: true })}>
              I understand
            </button>
          )}
        </div>
      )}
      {s && (
        <>
          <div className="ssec">Engine</div>
          <Kv k={s.engineBackend ? s.engineBackend.toUpperCase() : 'Engine'} v={s.supported ? (s.engineTag ? `Installed · ${s.engineTag}` : 'Not installed (set it up on the computer)') : 'Not available'} />
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
    if (!url) return toast('Still loading')
    const a = document.createElement('a')
    a.href = url
    a.download = `${item.id}.${item.kind === 'video' ? 'webm' : 'png'}`
    a.click()
    toast('Saved')
  }
  return (
    <>
      <Grab />
      <div className="gi" style={{ cursor: 'default' }}>
        <Media item={item} controls />
      </div>
      <p className="sh" style={{ marginTop: 6 }}>{r.prompt}</p>
      <Kv k="Seed" v={r.seed} />
      <Kv k="Time" v={durationText(r.durationMs)} />
      <Kv k="Model" v={r.modelName} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
        <button type="button" className="btn" disabled={busy} onClick={() => { setBusy(true); closeSheet(); void call(() => client().rpc('studio.remix', { kind: item.kind, id: item.id }), 'Remixing with a new seed') }}>
          Remix
        </button>
        <button type="button" className="btn" onClick={save}>
          Save
        </button>
        <button type="button" className="btn dan" disabled={busy} onClick={() => { setBusy(true); closeSheet(); void call(() => client().rpc('studio.delete', { kind: item.kind, id: item.id }), 'Deleted') }}>
          Delete
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
        toast('Voice input is ready')
      } else toast('Not set up yet')
    } catch {
      toast("Can't reach your computer")
    }
  }
  return (
    <>
      <Grab />
      <h3>Set up voice input on your computer</h3>
      <p className="sh">
        Your words are turned into text by a voice model on your computer. On the computer, open Flint, press the microphone beside Send in any message box and follow the setup to download the voice model. Then dictation works from this phone too.
      </p>
      <button type="button" className="btn pri" onClick={() => void check()}>
        Check again
      </button>
    </>
  )
}
