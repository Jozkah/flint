/**
 * The older per-provider images, for providers the LobeHub set in
 * `brandLogos` does not cover. Kept free of app imports so the phone app
 * (src/mobile) can use it; paths follow Vite's base, which is `/` on the
 * desktop and `/m/` on the phone.
 */
const IMAGES = `${import.meta.env.BASE_URL}images/model-provider`

export function getProviderLogo(provider: string) {
  switch (provider) {
    case 'jan':
      return `${IMAGES}/jan.png`
    case 'llamacpp':
      return `${IMAGES}/llamacpp.svg`
    case 'mlx':
      return `${IMAGES}/mlx.png`
    case 'anthropic':
      return `${IMAGES}/anthropic.svg`
    case 'huggingface':
      return `${IMAGES}/huggingface.svg`
    case 'mistral':
      return `${IMAGES}/mistral.svg`
    case 'openrouter':
      return `${IMAGES}/open-router.svg`
    case 'groq':
      return `${IMAGES}/groq.svg`
    case 'cohere':
      return `${IMAGES}/cohere.svg`
    case 'gemini':
      return `${IMAGES}/gemini.svg`
    case 'openai':
      return `${IMAGES}/openai.svg`
    case 'azure':
      return `${IMAGES}/azure.svg`
    case 'xai':
      return `${IMAGES}/xai.svg`
    case 'minimax':
      return `${IMAGES}/minimax.svg`
    case 'nvidia':
      return `${IMAGES}/nvidia.svg`
    default:
      return undefined
  }
}
