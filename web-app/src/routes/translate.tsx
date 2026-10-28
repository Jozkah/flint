
import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { TranslatePage } from '@/containers/translate/TranslatePage'

export const Route = createFileRoute(route.translate)({
  component: TranslatePage,
})
