import React, { memo } from 'react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * Checks if an avatar is a custom image (starts with '/images/')
 */
const isCustomImageAvatar = (avatar: React.ReactNode): avatar is string => {
  return typeof avatar === 'string' && avatar.startsWith('/images/')
}

/**
 * Built-in icons drawn dark on dark (Coal's grey lump, the Flint mark): in the
 * dark theme they get a brightness lift and a faint light rim so they read on
 * a dark tile. Other icons are already bright and stay as they are.
 */
const DIM_IN_DARK = new Set([
  '/images/assistants/coal.png',
  '/images/flint-logo.png',
])
const DARK_LIFT =
  'dark:[filter:brightness(1.9)_drop-shadow(0_0_1px_rgb(255_255_255/0.45))]'

/**
 * Built-in icons drawn pale on pale (Quartz's white crystal): a faint dark rim,
 * `--icon-rim`, keeps them visible on a light tile; the dark theme sets the
 * token transparent (C061).
 */
const PALE_IN_LIGHT = new Set(['/images/assistants/quartz.png'])
const LIGHT_RIM = '[filter:drop-shadow(0_0_1px_var(--icon-rim))]'

/**
 * Component for rendering assistant avatars with consistent styling
 */
interface AvatarEmojiProps {
  avatar?: React.ReactNode
  imageClassName?: string
  textClassName?: string
}

export const AvatarEmoji: React.FC<AvatarEmojiProps> = memo(({
  avatar,
  imageClassName = 'w-5 h-5 object-contain',
  textClassName = 'text-base',
}) => {
  const { t } = useTranslation()
  if (!avatar) return null
  if (isCustomImageAvatar(avatar)) {
    return (
      <img
        src={avatar}
        alt={t('common:customAvatar')}
        className={cn(
          imageClassName,
          DIM_IN_DARK.has(avatar) && DARK_LIFT,
          PALE_IN_LIGHT.has(avatar) && LIGHT_RIM
        )}
      />
    )
  }

  return <span className={textClassName}>{avatar}</span>
})
