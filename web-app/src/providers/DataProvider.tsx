import { useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { repoFromDeepLink } from '@/lib/huggingface'
import { promptFromDeepLink } from '@/lib/deepLinkPrompt'
import { usePrompt } from '@/hooks/usePrompt'
import { useServiceHub } from '@/hooks/useServiceHub'
import {
  useBedrockCredentialRefresh,
  useBootHydration,
  useInterruptedDownloadRestore,
  useLocalApiAutoStart,
  useProviderBackendSync,
  useSleepInhibit,
  useThreadsHydration,
  useTraySettingsSync,
} from './dataProviderHooks'

export function DataProvider() {
  const navigate = useNavigate()
  const serviceHub = useServiceHub()
  /**
   * A model link opens that model's page in Discover. Opening the page is the
   * only thing it does: Hugging Face is contacted when the page loads, and a
   * download still needs the user's own click. Anything that is not a plain
   * owner/name model link is ignored.
   */
  const handleDeepLink = (urls: string[] | null) => {
    // A prompt link fills a new chat's composer and stops there: nothing is
    // sent until the user reads it and presses Send.
    const prompt = urls?.length ? promptFromDeepLink(urls[0]) : null
    if (prompt) {
      usePrompt.getState().setPrompt(prompt)
      navigate({ to: route.home })
      return
    }
    const repo = urls?.length ? repoFromDeepLink(urls[0]) : null
    if (!repo) return
    navigate({ to: route.hub.model, params: { modelId: repo }, search: { repo } })
  }

  // Order matters: effects run in the order these hooks are called.
  useBedrockCredentialRefresh()
  useInterruptedDownloadRestore(serviceHub)
  useBootHydration(serviceHub, handleDeepLink)
  useThreadsHydration(serviceHub)
  useProviderBackendSync(serviceHub)
  useSleepInhibit()
  useTraySettingsSync(serviceHub)
  useLocalApiAutoStart(serviceHub)

  return null
}
