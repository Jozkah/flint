import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { fontSizeOptions, useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'

export function FontSizeSwitcher({
  renderAsRadio = false,
}: {
  renderAsRadio?: boolean
}) {
  const { fontSize, setFontSize } = useInterfaceSettings()
  const { t } = useTranslation()

  if (renderAsRadio) {
    return (
      <RadioGroup
        value={fontSize}
        onValueChange={(value) => setFontSize(value as FontSize)}
        className="grid grid-cols-1 gap-3"
      >
        {fontSizeOptions.map((item) => (
          <Label
            key={item.value}
            htmlFor={item.value}
            className="cursor-pointer [&:has([data-state=checked])>div]:border-primary [&:has([data-state=checked])>div]:bg-accent"
          >
            <Card className="w-full border transition-colors shadow-none">
              <CardContent className="flex flex-row items-center justify-start gap-4 p-4">
                <RadioGroupItem value={item.value} id={item.value} />
                <span className="text-sm font-medium">{item.label}</span>
              </CardContent>
            </Card>
          </Label>
        ))}
      </RadioGroup>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="w-full min-w-36 justify-between font-normal pointer-coarse:h-11" title={t('common:adjustFontSize')}>
          <span>
            {fontSizeOptions.find(
              (item: { value: string; label: string }) => item.value === fontSize
            )?.label || t('common:medium')}{' '}
            <span className="text-muted-foreground">{fontSize}</span>
          </span>
          <Icon name="arrow-down" size={12} className="ml-2 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {fontSizeOptions.map((item: { value: string; label: string }) => (
          <DropdownMenuItem
            key={item.value}
            className={cn(
              'cursor-pointer my-0.5',
              fontSize === item.value && 'bg-accent font-medium'
            )}
            onClick={() => setFontSize(item.value as FontSize)}
          >
            <span className="flex-1">{item.label}</span>
            <span className="text-xs text-muted-foreground">{item.value}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
