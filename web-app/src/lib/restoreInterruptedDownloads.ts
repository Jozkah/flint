// Bring back, as paused rows, the Hugging Face downloads a quit or crash cut
// off (see lib/interruptedDownloads). Runs once per app start, in the main
// window only; Resume then continues from the files already finished and the
// partial file of the current one.

import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { restoreHuggingFaceBundle } from '@/hooks/useHuggingFaceDownloads'
import { ggufFinish, mlxFinish } from '@/lib/huggingfaceStart'
import {
  readInterruptedDownloads,
  type InterruptedDownload,
} from '@/lib/interruptedDownloads'
import { voiceFinish } from '@/lib/voice/installVoiceModel'
import type { ServiceHub } from '@/services'

let restored = false

function finishFor(
  saved: InterruptedDownload,
  hub: Pick<ServiceHub, 'models'>
): ((paths: string[]) => Promise<void>) | undefined {
  const finish = saved.finish
  switch (finish.kind) {
    case 'gguf':
      return ggufFinish(finish, hub.models())
    case 'mlx':
      return mlxFinish(
        finish,
        saved.files.map((file) => file.name),
        hub.models()
      )
    case 'voice':
      return voiceFinish(hub)
  }
}

export function restoreInterruptedDownloads(hub: Pick<ServiceHub, 'models'>): void {
  if (restored) return
  restored = true
  for (const saved of readInterruptedDownloads()) {
    restoreHuggingFaceBundle(
      {
        id: saved.id,
        repo: saved.repo,
        label: saved.label,
        files: saved.files,
        revision: saved.revision,
        // Read when the download resumes, so a token saved in Settings after
        // the relaunch is used; it is never written to the saved list.
        get token() {
          return useGeneralSetting.getState().huggingfaceToken
        },
        finish: saved.finish,
        onComplete: finishFor(saved, hub),
      },
      saved
    )
  }
}

/** Test seam: allow another restore in the same module instance. */
export function resetRestoreForTests(): void {
  restored = false
}
