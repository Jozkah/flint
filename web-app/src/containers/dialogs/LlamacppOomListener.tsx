import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'

import { useAppState } from '@/hooks/useAppState'
import { isPlatformTauri } from '@/lib/platform/utils'
import {
  clearActiveWork,
  hasActiveLlamacppRequest,
  stampErrorOnLastUserMessage,
} from './llamacppRouterError'

type LoadProgressPayload = {
  model: string
  stage?: string
  value: number
}

export default function LlamacppOomListener() {
  useEffect(() => {
    if (!isPlatformTauri()) return
    const unlistenOom = listen<string>('llamacpp-router-oom', (event) => {
      if (!hasActiveLlamacppRequest()) return
      const payload = event.payload ?? ''
      stampErrorOnLastUserMessage('oomError', payload)
      clearActiveWork()
      useAppState.getState().setOomError(payload)
    }).catch((e) => {
      console.warn('listen llamacpp-router-oom failed:', e)
      return () => {}
    })
    const unlistenBackend = listen<string>(
      'llamacpp-router-backend-error',
      (event) => {
        if (!hasActiveLlamacppRequest()) return
        const payload = event.payload ?? ''
        stampErrorOnLastUserMessage('backendError', payload)
        clearActiveWork()
        useAppState.getState().setBackendError(payload)
      }
    ).catch((e) => {
      console.warn('listen llamacpp-router-backend-error failed:', e)
      return () => {}
    })
    const unlistenLoadProgress = listen<LoadProgressPayload>(
      'llamacpp-model-load-progress',
      (event) => {
        const { model, stage, value } = event.payload
        const progress = { modelId: model, stage, value }
        useAppState.getState().updateModelLoadProgress(progress)
        const threadId = useAppState.getState().currentStreamThreadId
        if (threadId) {
          useAppState.getState().updateThreadModelLoadProgress(threadId, progress)
        }
      }
    ).catch((e) => {
      console.warn('listen llamacpp-model-load-progress failed:', e)
      return () => {}
    })
    return () => {
      void unlistenOom.then((fn) => fn?.())
      void unlistenBackend.then((fn) => fn?.())
      void unlistenLoadProgress.then((fn) => fn?.())
    }
  }, [])

  return null
}
