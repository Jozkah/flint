import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { cn } from '@/lib/utils'
import { Icon } from '@/components/ui/icon'

const hostOptions = [
  { value: '127.0.0.1', label: '127.0.0.1' },
  { value: '0.0.0.0', label: '0.0.0.0' },
]

export function ServerHostSwitcher({
  isServerRunning,
}: {
  isServerRunning?: boolean
}) {
  const { serverHost, setServerHost } = useLocalApiServer()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        asChild
        className={cn(isServerRunning && 'opacity-50 pointer-events-none')}
      >
        <Button variant="outline" className="w-full min-w-[140px] justify-between pointer-coarse:h-11" title="Edit Server Host">
          {serverHost}
          <Icon name="arrow-down" size={12} className="ml-2 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-24">
        {hostOptions.map((item) => (
          <DropdownMenuItem
            key={item.value}
            className={cn(
              'cursor-pointer my-0.5',
              serverHost === item.value && 'bg-seconday'
            )}
            onClick={() => setServerHost(item.value as '127.0.0.1' | '0.0.0.0')}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
