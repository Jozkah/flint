# Contributing to Flint Web App

[← Back to Main Contributing Guide](../CONTRIBUTING.md)

React frontend using TypeScript, TanStack Router, Radix UI, and Tailwind CSS. State is managed by React State and Zustand.

## Key Directories

- **`/src/components/ui`** - UI components (buttons, dialogs, inputs)
- **`/src/containers`** - Complex feature components (ChatInput, ThreadContent)  
- **`/src/hooks`** - Custom React hooks (useChat, useThreads, useAppState)
- **`/src/routes`** - TanStack Router pages
- **`/src/services`** - API layer for backend communication
- **`/src/types`** - TypeScript definitions

## Development

### Component Example

```tsx
interface Props {
  title: string
  onAction?: () => void
}

export const MyComponent: React.FC<Props> = ({ title, onAction }) => {
  return (
    <div className="flex items-center gap-2">
      <h2>{title}</h2>
      <Button onClick={onAction}>Action</Button>
    </div>
  )
}
```

### Routing

```tsx
export const Route = createFileRoute('/settings/general')({
  component: GeneralSettings
})
```

### Building & Testing

```bash
# Development
yarn dev
yarn build
yarn test
```

### State Management

```tsx
// Local state
const [value, setValue] = useState<string>('')

// Global state (Zustand)
export const useAppState = create<AppState>((set) => ({
  data: null,
  setData: (data) => set({ data })
}))
```

### Tauri Integration

```tsx
import { invoke } from '@tauri-apps/api/tauri'

const result = await invoke('command_name', { param: 'value' })
```

## Performance Tips

```tsx
// Use React.memo for expensive components
const ExpensiveComponent = React.memo(({ data }) => {
  return <div>{processData(data)}</div>
})

// Debounce frequent updates
const debouncedValue = useDebounce(searchTerm, 300)

// Virtual scrolling for large lists
import { VariableSizeList } from 'react-window'
```

## Debugging

```bash
# React DevTools
# Install browser extension, then:
# - Inspect component tree
# - Debug hooks and state
# - Profile performance

# Debug Tauri commands
console.log(await window.__TAURI__.invoke('command_name'))

# Check for console errors
# Press F12 → Console tab
```

## Phone app (remote access)

`mobile.html` + `src/mobile/` is a separate Vite entry: the web app a paired
phone opens at `https://<computer>:1340/m/`, served by the desktop's
remote-access server (`src-tauri/src/core/remote`). It runs in the phone's
browser, so it must not import Tauri or the desktop's stores (ESLint enforces
this for `src/mobile/**`). It talks to the desktop only through
`/remote/v1` (see `src/lib/remote/protocol.ts`); the desktop window answers
RPCs in `src/lib/remote/handlers.ts`.

```bash
# Build it into src-tauri/resources/mobile (bundled as a Tauri resource;
# `yarn build` does this too)
yarn build:mobile

# Develop against a running Flint with Settings > Remote access on:
# http://localhost:1430/m/ proxies /remote/v1 (HTTP + WebSocket) to it.
yarn dev:mobile
FLINT_REMOTE_URL=https://100.64.0.2:1340 yarn dev:mobile   # another address

# Pair the dev page: copy the pairing link from the desktop's QR dialog and
# open it with the dev origin, e.g. http://localhost:1430/m/#pair=<code>
```

To try the built app end to end in `yarn dev`, run `yarn build:mobile`
first: Tauri copies `src-tauri/resources/mobile` next to the binary when it
builds, and the server shows a placeholder page while the folder is empty.

## Accessibility Guidelines

- Use semantic HTML (`<button>`, `<nav>`, `<main>`)
- Add ARIA labels: `aria-label`, `aria-describedby`
- Ensure keyboard navigation works
- Test with screen readers
- Maintain color contrast ratios

## Best Practices

- Keep components small and focused
- Use TypeScript fully (no `any`)
- Handle loading and error states
- Follow accessibility guidelines
- Extract business logic into hooks

## Dependencies

- **React** - UI framework
- **TypeScript** - Type safety
- **TanStack Router** - Type-safe routing
- **Radix UI** - Accessible components
- **Tailwind CSS** - Utility-first styling
- **Zustand** - State management