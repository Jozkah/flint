import { useServiceStore } from '@/hooks/useServiceHub'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { startHuggingFaceBundle } from '@/hooks/useHuggingFaceDownloads'
import { recordHuggingFaceInstall } from '@/lib/huggingfaceRegistry'
import {
  VOICE_BUNDLE_ID,
  VOICE_MMPROJ_BYTES,
  VOICE_MMPROJ_FILE,
  VOICE_MODEL_BYTES,
  VOICE_MODEL_FILE,
  VOICE_MODEL_ID,
  VOICE_MODEL_REPO,
  VOICE_MODEL_SETTINGS,
} from '@/lib/voice/voiceModel'

/**
 * Download the voice model and import it, through the same Hugging Face bundle
 * download every GGUF uses (so it is paused, resumed, retried and shown in the
 * same way), then give it the fixed settings it needs to transcribe.
 */
export async function installVoiceModel(): Promise<void> {
  const hub = useServiceStore.getState().serviceHub
  if (!hub) throw new Error('Flint is still starting. Try again in a moment.')
  const token = useGeneralSetting.getState().huggingfaceToken

  await startHuggingFaceBundle({
    id: VOICE_BUNDLE_ID,
    repo: VOICE_MODEL_REPO,
    label: 'Voice input model',
    files: [
      { name: VOICE_MODEL_FILE, size: VOICE_MODEL_BYTES },
      { name: VOICE_MMPROJ_FILE, size: VOICE_MMPROJ_BYTES },
    ],
    token,
    onComplete: async (paths) => {
      const [modelPath, mmprojPath] = paths
      if (!modelPath || !mmprojPath) {
        throw new Error('The voice model download finished without all its files.')
      }
      await hub
        .models()
        .pullModel(
          VOICE_MODEL_ID,
          modelPath,
          undefined,
          VOICE_MODEL_BYTES,
          mmprojPath,
          undefined,
          VOICE_MMPROJ_BYTES
        )
      await hub.models().updateModelSettings(VOICE_MODEL_ID, {
        chat_template: VOICE_MODEL_SETTINGS.chat_template,
        ctx_len: VOICE_MODEL_SETTINGS.ctx_len,
      })
      recordHuggingFaceInstall({
        modelId: VOICE_MODEL_ID,
        repo: VOICE_MODEL_REPO,
        revision: null,
        files: [VOICE_MODEL_FILE, VOICE_MMPROJ_FILE],
        installedAt: Date.now(),
        provider: 'llamacpp',
      })
    },
  })
}
