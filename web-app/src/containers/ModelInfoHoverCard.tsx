import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card'
import {
  Check,
  CircleHelp,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react'
import { CatalogModel, ModelQuant } from '@/services/models/types'
import { selectDefaultQuant, extractQuantLabel } from '@/lib/models'
import { useHardware } from '@/hooks/useHardware'
import {
  DEFAULT_CTX_LENGTH,
  estimateModelFit,
  parseFileSize,
  sumMlxModelBytes,
  type FitTier,
} from '@/lib/modelCompatibility'
import { cn } from '@/lib/utils'

interface ModelInfoHoverCardProps {
  model: CatalogModel
  variant?: ModelQuant
  isDefaultVariant?: boolean
  defaultModelQuantizations: readonly string[]
  children?: React.ReactNode
}

type TriggerStyle = {
  icon: LucideIcon
  label: string
  detail: string
  pill: string
  dot: string
}

const TRIGGER_STYLES: Record<FitTier, TriggerStyle> = {
  green: {
    icon: Check,
    label: 'Fits',
    detail: 'Should run comfortably on your device',
    pill: 'bg-success-tint text-success',
    dot: 'bg-success',
  },
  yellow: {
    icon: TriangleAlert,
    label: 'May be slow',
    detail: 'Will run but leaves little memory headroom',
    pill: 'bg-warning-tint text-warning',
    dot: 'bg-warning',
  },
  red: {
    icon: X,
    label: "Won't fit",
    detail: 'Likely exceeds your available memory',
    pill: 'bg-destructive-tint text-destructive',
    dot: 'bg-destructive',
  },
  unknown: {
    icon: CircleHelp,
    label: 'Fit unknown',
    detail: 'Could not estimate memory requirements',
    pill: 'bg-sunken text-ink-2',
    dot: 'bg-line-strong',
  },
}

export const ModelInfoHoverCard = ({
  model,
  variant,
  isDefaultVariant,
  defaultModelQuantizations,
  children,
}: ModelInfoHoverCardProps) => {
  const hardwareData = useHardware((s) => s.hardwareData)

  const displayVariant = model.is_mlx
    ? undefined
    : variant ?? selectDefaultQuant(model.quants, defaultModelQuantizations)

  const fileSizeBytes = model.is_mlx
    ? sumMlxModelBytes(model) || null
    : parseFileSize(displayVariant?.file_size)
  const tier: FitTier = estimateModelFit(
    fileSizeBytes,
    DEFAULT_CTX_LENGTH,
    hardwareData
  )
  const style = TRIGGER_STYLES[tier]
  const Icon = style.icon

  const trigger = children ?? (
    <button
      type="button"
      className={cn(
        'inline-flex items-center gap-1 rounded-md font-medium cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring',
        isDefaultVariant ? 'text-xs px-2 py-1' : 'text-[11px] px-1.5 py-0.5',
        style.pill
      )}
      aria-label={`Device compatibility: ${style.label}`}
    >
      <Icon size={isDefaultVariant ? 14 : 12} />
      {isDefaultVariant && <span>{style.label}</span>}
    </button>
  )

  return (
    <HoverCard openDelay={150}>
      <HoverCardTrigger asChild>{trigger}</HoverCardTrigger>
      <HoverCardContent className="w-80 max-w-[calc(100vw-1.5rem)] bg-card p-3" side="left">
        <div className="space-y-3">
          <div className="border-b border-border pb-3">
            <h4 className="text-sm font-semibold">
              {!isDefaultVariant ? variant?.model_id : model?.model_name}
            </h4>
            <p className="text-xs text-muted-foreground mt-1">
              {!isDefaultVariant
                ? 'Model Variant Information'
                : 'Model Information'}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 text-xs">
            {!model.is_mlx && (
              <div>
                <span className="text-muted-foreground block">
                  {isDefaultVariant ? 'Default Quantization' : 'Quantization'}
                </span>
                <span className="font-medium mt-1 inline-block">
                  {extractQuantLabel(displayVariant?.model_id) || 'N/A'}
                </span>
              </div>
            )}

            <div>
              <span className="text-muted-foreground block">
                Device compatibility
              </span>
              <div className="flex items-start gap-2 mt-1">
                <div
                  className={cn(
                    'size-2 shrink-0 rounded-full mt-1',
                    style.dot
                  )}
                />
                <div>
                  <p className="font-medium">{style.label}</p>
                  <p className="text-muted-foreground mt-0.5">{style.detail}</p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Estimated from file size and your hardware. Actual performance
                depends on quantization and context length.
              </p>
            </div>
          </div>

          {((model.num_mmproj ?? 0) > 0 || model.tools) && (
            <div className="border-t border-border pt-3">
              <h5 className="text-xs font-medium text-muted-foreground mb-2">
                Features
              </h5>
              <div className="flex flex-wrap gap-2">
                {model.tools && (
                  <div className="flex items-center gap-1.5 px-1.5 py-0.5 bg-sunken text-ink-2 rounded-md">
                    <span className="text-xs font-medium">Tools</span>
                  </div>
                )}
                {(model.num_mmproj ?? 0) > 0 && (
                  <div className="flex items-center gap-1.5 px-1.5 py-0.5 bg-sunken text-ink-2 rounded-md">
                    <span className="text-xs font-medium">Vision</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}
