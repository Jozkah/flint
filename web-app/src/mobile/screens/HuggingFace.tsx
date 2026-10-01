// Browse Hugging Face (#55/#87): search, modality pills, what fits this
// computer, and starting a download there. Downloads stay on the computer.
import { useState } from 'react'
import type { HfModelCard, HfSearchParams } from '@/lib/remote/protocol'
import { TopBack } from '../shell/TopBar'
import { Avatar, Empty, Loading, Pills } from '../ui/bits'
import { compact } from '../ui/format'
import { I } from '../ui/icons'
import { act, useApp } from '../state/app'
import { invalidate, useRpc } from '../state/rpc'
import { DownloadCard } from './Models'

type Modality = NonNullable<HfSearchParams['modality']>
const MODALITIES: { id: Modality; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'text', label: 'Text' },
  { id: 'vision', label: 'Vision' },
  { id: 'audio', label: 'Audio' },
  { id: 'code', label: 'Code' },
  { id: 'embeddings', label: 'Embeddings' },
]

const gb = (n: number | null) => (n ? `${(n / 1e9).toFixed(1)} GB` : 'size unknown')

function ModelCard({ m }: { m: HfModelCard }) {
  const [author, name] = m.repo.includes('/') ? m.repo.split('/', 2) : [m.author ?? '', m.repo]
  const start = (quant?: string) =>
    void act('hf.download', { repo: m.repo, ...(quant ? { quant } : {}) }, `Downloading ${name} on the computer`).then(() => invalidate(['models.downloads']))
  return (
    <div className="frame" style={{ padding: '10px 12px', marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="hf-card">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Avatar id={m.repo} name={name} provider="llamacpp" size={28} square />
        <span style={{ flex: 1, minWidth: 0 }}>
          <small className="muted">{author}</small>
          <br />
          <b style={{ overflowWrap: 'anywhere' }}>{name}</b>
        </span>
        {m.installed && (
          <span className="chip ok">
            <span className="d" />
            installed
          </span>
        )}
      </div>
      <small className="muted">
        {[m.pipelineTag, `${compact(m.downloads)} downloads`, `${compact(m.likes)} likes`].filter(Boolean).join(' · ')}
      </small>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
        {m.variants.map((v) => (
          <button key={v.quant} type="button" className={`bdg${v.fits ? ' ok' : v.fits === false ? ' warn' : ''}`} style={{ border: 0, cursor: 'pointer' }} onClick={() => start(v.quant)} aria-label={`Download ${v.quant}`}>
            {v.quant} · {gb(v.sizeBytes)}
            {v.fits ? ' · Fits' : v.fits === false ? ' · Too big' : ''}
          </button>
        ))}
        {m.variants.length === 0 && <span className="bdg">No GGUF files</span>}
      </div>
    </div>
  )
}

export default function HuggingFace() {
  const computer = useApp((s) => s.computerName) ?? 'the computer'
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [modality, setModality] = useState<Modality>('all')
  const { data, loading, error } = useRpc('hf.search', { query, modality })
  const downloads = useRpc('models.downloads', {})
  const models = data?.models ?? []
  const fitting = models.filter((m) => m.variants.some((v) => v.fits))
  return (
    <>
      <TopBack crumb="Models" title="Hugging Face" />
      <div className="scroll">
        <div className="hfhead">
          <b>Discover models</b>
          <span className="chip ok">
            <span className="d" />
            Downloads stay on {computer}
          </span>
          <form
            className="sin"
            style={{ marginTop: 8 }}
            onSubmit={(e) => {
              e.preventDefault()
              setQuery(q.trim())
            }}
          >
            <I n="search" />
            <input placeholder="Search Hugging Face" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search Hugging Face" enterKeyHint="search" />
          </form>
        </div>
        <Pills items={MODALITIES} value={modality} onChange={setModality} />
        {(downloads.data?.tasks ?? []).filter((t) => !['complete', 'cancelled'].includes(t.status)).map((t) => <DownloadCard key={t.id} t={t} />)}
        {loading && !data && <Loading />}
        {error && !data && <Empty>{error.message}</Empty>}
        {data && (
          <div className="kv" style={{ fontSize: 12, marginBottom: 8 }}>
            <span>{models.length} results</span>
            <span>Trending</span>
          </div>
        )}
        {data?.device && fitting.length > 0 && (
          <div className="best">
            Best for this device · {data.device.name} {Math.round(data.device.vramBytes / 1024 ** 3)} GB
          </div>
        )}
        {[...fitting, ...models.filter((m) => !fitting.includes(m))].map((m) => (
          <ModelCard key={m.repo} m={m} />
        ))}
        {data && models.length === 0 && <Empty>No models match.</Empty>}
      </div>
    </>
  )
}
