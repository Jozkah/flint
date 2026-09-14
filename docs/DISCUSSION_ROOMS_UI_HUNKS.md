# Discussion rooms: proposed navigation hunks

The rooms UI lane does not edit the shell (`lib/shellNavigation.ts`,
`components/shell/AppRail.tsx`, `components/left-sidebar/*`), because another
session owns the restyle. These hunks add a **Rooms** rail item for whoever
integrates the two branches.

The files do not exist on `feature/discussion-rooms` (commit `7898fd2b4`). The
hunks were written against `feat/atelier-design` as it stood on 2026-09-13
(`git show feat/atelier-design:<path>`). Re-check the context lines against the
design owner's current branch before applying.

Routes already exist on the rooms branch: `route.rooms = '/rooms'` and
`route.roomDetail = '/rooms/$roomId'` in `web-app/src/constants/routes.ts`.

## `web-app/src/lib/shellNavigation.ts`

```diff
@@ export type RailArea =
 export type RailArea =
   | 'workspace'
+  | 'rooms'
   | 'library'
   | 'models'
   | 'tools'
   | 'search'
   | 'system'
   | 'settings'
@@ export const RAIL_ITEMS: readonly RailItem[] = [
 export const RAIL_ITEMS: readonly RailItem[] = [
   { id: 'workspace', labelKey: 'common:appRail.workspace', group: 'top', to: route.home },
+  { id: 'rooms', labelKey: 'common:appRail.rooms', group: 'top', to: route.rooms },
   { id: 'library', labelKey: 'common:appRail.library', group: 'top', to: route.artifacts },
@@ export function areaForPath(pathname: string): RailArea {
 export function areaForPath(pathname: string): RailArea {
   const path = pathname.replace(/\/+$/, '') || '/'
+  if (within(path, route.rooms)) return 'rooms'
   if (within(path, route.artifacts)) return 'library'
```

`within(path, route.rooms)` matches `/rooms` and `/rooms/<id>`. Rooms is not a
settings area, so `isSettingsArea` needs no change.

## `web-app/src/components/shell/AppRail.tsx`

```diff
@@ import {
 import {
   Activity,
   BookOpen,
   Box,
   Folder,
+  MessagesSquare,
   Search,
   Settings,
   Wrench,
   type LucideIcon,
 } from 'lucide-react'
@@ const ICONS: Record<RailArea, LucideIcon> = {
 const ICONS: Record<RailArea, LucideIcon> = {
   workspace: Folder,
+  rooms: MessagesSquare,
   library: BookOpen,
```

`ICONS` is `Record<RailArea, LucideIcon>`, so tsc fails until the icon is added
alongside the new `RailArea` member. The rail test id becomes `rail-rooms`
through the existing `` `rail-${item.id}` `` fallback.

## `web-app/src/locales/en/common.json`

Add the label next to the other rail keys under `appRail`:

```diff
   "appRail": {
     "workspace": "Workspace",
+    "rooms": "Rooms",
     "library": "Library",
```

The `appRail` block exists only on the design branch. The key test
(`src/i18n/__tests__/keys.test.ts`) does not catch a missing key here, because
`RAIL_ITEMS` stores the key as data, not as a literal `t('…')` call.

## Things to check after applying

- With five top items the rail is 5 × 72px tall plus the wordmark. The
  `[@media(max-height:620px)]` rule already shrinks items, but check short
  windows.
- The rooms pages use `h-[calc(100%-var(--ctx-h,52px))]`. `--ctx-h` is defined
  only on the design branch; the `52px` fallback keeps the layout correct
  without it.
- Phone navigation reuses `RAIL_ITEMS`, so the sheet gets the item as well.
