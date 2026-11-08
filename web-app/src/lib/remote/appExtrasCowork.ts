// `RemoteExtras` for Cowork: the session's files and previews, as the code
// and preview panels read them.

import { projectListDir, projectReadFile } from '@janhq/tauri-plugin-agent-tools-api'
import { collectCodeFileDiffs, changedLines } from '@/lib/coworkDiffs'
import { detectLanguage, relativeToRoot } from '@/lib/coworkCode'
import { artifactsFromTurns } from '@/lib/coworkArtifacts'
import { MAX_PREVIEW_BYTES, previewKindFor } from '@/lib/coworkPreview'
import { coworkTurnsOf } from './sessionViews'
import { currentLivePreview } from './preview'
import type { RemoteExtras } from './extras'
import type { CoworkPreviewResult } from './protocol'
import { t, dataFolder, messageOf } from './appExtrasShared'

/** Cowork: the session's files and previews. */
export const coworkExtras: Pick<RemoteExtras, 'coworkFiles' | 'coworkFile' | 'coworkPreview'> = {
  // CoworkCodePanel's explorer and viewer: the attached project, read-only.
  coworkFiles: async (id, path) => {
    const found = coworkTurnsOf(id)
    if (!found) return null
    const folder = found.session.folder
    if (!folder) return { root: null, entries: [], truncated: false }
    const listing = await projectListDir(await dataFolder(), folder, path)
    return { root: folder, entries: listing.entries, truncated: listing.truncated }
  },
  coworkFile: async (id, path) => {
    const found = coworkTurnsOf(id)
    if (!found) return null
    const folder = found.session.folder
    const diffs = collectCodeFileDiffs(found.turns, found.subagents)
    const touched = diffs.map((d) => relativeToRoot(folder, d.path))
    const diff = diffs.find((d) => relativeToRoot(folder, d.path) === path)
    const changed: Record<number, 'add' | 'mod'> = {}
    for (const [line, mark] of Object.entries(changedLines(diff))) {
      changed[Number(line)] = mark.removed ? 'mod' : 'add'
    }
    const base = { path, changed, language: detectLanguage(path).label, touched }
    if (!folder) return { ...base, status: 'missing', content: '' }
    try {
      const file = await projectReadFile(await dataFolder(), folder, path, false)
      if (file.oversized) return { ...base, status: 'oversized', content: '' }
      if (file.binary) return { ...base, status: 'binary', content: '' }
      return { ...base, status: 'ready', content: file.content }
    } catch (e) {
      const message = messageOf(e)
      return {
        ...base,
        status: message.startsWith('SENSITIVE:') ? 'sensitive' : message.startsWith('DENIED') ? 'denied' : 'missing',
        content: '',
      }
    }
  },

  // CoworkPreviewPanel: the session's artifacts, the chosen one's text.
  coworkPreview: async (id, path) => {
    const found = coworkTurnsOf(id)
    if (!found) return null
    const folder = found.session.folder
    const artifacts = artifactsFromTurns(found.turns, folder)
      .map((a) => relativeToRoot(folder, a.path))
      .filter((p) => ['html', 'svg', 'markdown', 'text'].includes(previewKindFor(p)))
    const chosen = path ?? [...artifacts].reverse().find((p) => previewKindFor(p) === 'html') ?? artifacts[artifacts.length - 1] ?? null
    const lp = currentLivePreview()
    const live = lp?.sessionId === id ? { live: { url: lp.url } } : {}
    const empty: CoworkPreviewResult = { artifacts, path: chosen, kind: null, content: null, ...live }
    if (!chosen) return empty
    const raw = previewKindFor(chosen)
    const kind: CoworkPreviewResult['kind'] = raw === 'html' || raw === 'svg' || raw === 'markdown' || raw === 'text' || raw === 'image' ? raw : 'other'
    if (!folder) return { ...empty, kind, note: t('remote:phone.previewNoFolder') }
    if (kind === 'image' || kind === 'other') return { ...empty, kind, note: t('remote:phone.previewOnComputer') }
    try {
      const file = await projectReadFile(await dataFolder(), folder, chosen, false)
      if (file.oversized || file.binary || file.content.length > MAX_PREVIEW_BYTES) {
        return { ...empty, kind, note: t('remote:phone.previewTooLarge') }
      }
      return { ...empty, kind, content: file.content }
    } catch (e) {
      return { ...empty, kind, note: messageOf(e) }
    }
  },
}
