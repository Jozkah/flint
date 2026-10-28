import { Switch } from '@/components/ui/switch'

// Checkbox or switch component
type CheckboxControlProps = {
  checked: boolean
  title?: string
  onChange: (checked: boolean) => void
}

export function CheckboxControl({
  checked,
  title,
  onChange,
}: CheckboxControlProps) {
  return (
    <Switch
      checked={checked}
      aria-label={title}
      onCheckedChange={(value) => onChange(value)}
    />
  )
}
