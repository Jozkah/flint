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
    case 'groq':
      return `${IMAGES}/groq.svg`
    case 'cohere':
      return `${IMAGES}/cohere.svg`
    case 'azure':
      return `${IMAGES}/azure.svg`
    case 'minimax':
      return `${IMAGES}/minimax.svg`
    case 'nvidia':
      return `${IMAGES}/nvidia.svg`
    case 'litellm':
      return `${IMAGES}/litellm.svg`
    default:
      return undefined
  }
}
