import { getProviderLogo, getProviderTitle } from '@/lib/utils'

const ProvidersAvatar = ({ provider }: { provider: ProviderObject }) => {
  return (
    <>
      {getProviderLogo(provider.provider) === undefined ? (
        <div className="flex size-4.5 shrink-0 items-center justify-center rounded-full border border-line-strong bg-card">
          <p className="text-xs leading-0 capitalize text-ink-2">
            {getProviderTitle(provider.provider).charAt(0)}
          </p>
        </div>
      ) : (
        <img
          src={getProviderLogo(provider.provider)}
          alt={`${provider.provider} - Logo`}
          className="size-4.5 object-contain rounded-full"
          style={{
            imageRendering: '-webkit-optimize-contrast',
          }}
          loading="eager"
          decoding="sync"
          draggable={false}
        />
      )}
    </>
  )
}

export default ProvidersAvatar
