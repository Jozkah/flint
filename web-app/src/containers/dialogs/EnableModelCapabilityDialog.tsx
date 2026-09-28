import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { EnableableCapability } from '@/lib/modelCapabilityEnable'

type Props = {
  open: boolean
  modelName: string
  capabilities: readonly EnableableCapability[]
  onEnable: () => void
  onCancel: () => void
}

export function EnableModelCapabilityDialog({
  open,
  modelName,
  capabilities,
  onEnable,
  onCancel,
}: Props) {
  const { t } = useTranslation()
  const labels = capabilities.map((capability) =>
    t(`common:modelCapability.${capability}`)
  )

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('common:modelCapability.title', {
              capabilities: labels.join(', '),
            })}
          </DialogTitle>
          <DialogDescription>
            {t('common:modelCapability.description', {
              model: modelName,
              capabilities: labels.join(', '),
            })}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t('common:modelCapability.warning')}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t('common:cancel')}
          </Button>
          <Button onClick={onEnable} data-testid="enable-model-capability">
            {t('common:modelCapability.enable')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
