import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import {
  NOTIFICATION_POSITIONS,
  type NotificationPosition,
} from '@/utils/toastPlacement'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'

function positionLabelKey(position: NotificationPosition): string {
  switch (position) {
    case 'top-right':
      return 'settings:interface.notificationPositionTopRight'
    case 'top-left':
      return 'settings:interface.notificationPositionTopLeft'
    case 'bottom-right':
      return 'settings:interface.notificationPositionBottomRight'
    case 'bottom-left':
      return 'settings:interface.notificationPositionBottomLeft'
  }
}

export function NotificationPositionSwitcher() {
  const { notificationPosition, setNotificationPosition } =
    useInterfaceSettings()
  const { t } = useTranslation()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="w-full min-w-40 justify-between pointer-coarse:h-11"
          title={t('settings:interface.notificationPosition')}
        >
          {t(positionLabelKey(notificationPosition))}
          <Icon name="arrow-down" size={12} className="ml-2 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {NOTIFICATION_POSITIONS.map((value) => (
          <DropdownMenuItem
            key={value}
            className={cn(
              'cursor-pointer my-0.5',
              notificationPosition === value && 'bg-acc-tint'
            )}
            onClick={() => setNotificationPosition(value)}
          >
            {t(positionLabelKey(value))}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
