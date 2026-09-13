import { Star } from 'lucide-react'
import { useFavoriteModel } from '@/hooks/useFavoriteModel'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface FavoriteModelActionProps {
  model: Model
}

export function FavoriteModelAction({ model }: FavoriteModelActionProps) {
  const { isFavorite, toggleFavorite } = useFavoriteModel()
  const isModelFavorite = isFavorite(model.id)

  return (
    <Button
      aria-label="Toggle favorite"
      aria-pressed={isModelFavorite}
      variant="ghost"
      size="icon-sm"
      className="pointer-coarse:size-11"
      onClick={() => toggleFavorite(model)}
    >
      <Star
        aria-hidden
        className={cn(
          'size-4',
          isModelFavorite
            ? 'fill-current text-brand-text'
            : 'text-muted-foreground'
        )}
      />
    </Button>
  )
}
