import { getProviderTitle } from '@/lib/utils'
import { providerLogo } from '@/lib/brandLogos'
import { BrandMark } from '@/containers/engine/BrandMark'

/**
 * A provider's mark at text size, for menus and lists. Uses the shared
 * brand logos (LobeHub set, falling back to the bundled provider images),
 * and the provider's initial when it has neither.
 */
const ProvidersAvatar = ({ provider }: { provider: ProviderObject }) => {
  const logo = providerLogo(provider.provider)
  const title = getProviderTitle(provider.provider)
  return logo ? (
    <BrandMark
      logo={logo}
      name={title}
      size={18}
      tone="bare"
      className="[&_img]:size-full"
    />
  ) : (
    <BrandMark name={title} size={18} className="rounded-full" />
  )
}

export default ProvidersAvatar
