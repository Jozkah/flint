import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { CardItem } from '../Card'
import { useRouter } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { isRemovableProvider, useRemoveProvider } from '@/hooks/useRemoveProvider'
import { RemoveProviderDialog } from '@/containers/engine/ProviderCardMenu'
import { getProviderTitle } from '@/lib/utils'

type Props = {
  provider?: ProviderObject
}

/**
 * The provider settings page's "Delete provider" row. It uses the same
 * removal and confirmation as the provider card menu on the Models page.
 */
const DeleteProvider = ({ provider }: Props) => {
  const { t } = useTranslation()
  const removeProvider = useRemoveProvider()
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  if (!provider || !isRemovableProvider(provider.provider)) return null

  const title = getProviderTitle(provider.provider)
  const confirm = () => {
    setConfirming(false)
    void removeProvider(provider).then(() =>
      toast.success(t('providers:removeProvider.success', { provider: title }), {
        id: `delete-provider-${provider.provider}`,
      })
    )
    setTimeout(() => {
      router.navigate({ to: route.settings.model_providers })
    }, 0)
  }

  return (
    <CardItem
      title={t('providers:deleteProvider.title')}
      description={t('providers:deleteProvider.description')}
      actions={
        <>
          <Button
            variant="destructive"
            size="sm"
            className="pointer-coarse:h-11"
            onClick={() => setConfirming(true)}
          >
            {t('providers:deleteProvider.delete')}
          </Button>
          <RemoveProviderDialog
            provider={confirming ? provider : null}
            title={title}
            onOpenChange={(o) => !o && setConfirming(false)}
            onConfirm={confirm}
          />
        </>
      }
    />
  )
}
export default DeleteProvider
