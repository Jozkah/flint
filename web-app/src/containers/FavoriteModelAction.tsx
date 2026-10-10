import { Star } from 'lucide-react'
import { useFavoriteModel } from '@/hooks/useFavoriteModel'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface FavoriteModelActionProps {
  model: Model
  /** The provider the model is listed under. */
  provider?: string
}

export function FavoriteModelAction({
  model,
  provider,
}: FavoriteModelActionProps) {
  const { isFavorite, toggleFavorite } = useFavoriteModel()
  const isModelFavorite = isFavorite(model.id, provider)

  return (
    <Button
      aria-label="Toggle favorite"
      aria-pressed={isModelFavorite}
      variant="ghost"
      size="icon-sm"
      className="pointer-coarse:size-11"
      onClick={() => toggleFavorite(model, provider)}
    >
      <Star
        aria-hidden
        className={cn(
          'size-4',
          isModelFavorite
            ? 'fill-current text-acc-text'
            : 'text-muted-foreground'
        )}
      />
    </Button>
  )
}
