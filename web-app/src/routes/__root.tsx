import { createRootRoute, Outlet } from '@tanstack/react-router'
// import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'

import { Fragment } from 'react/jsx-runtime'
import { MotionConfig } from 'motion/react'
import { ThemeProvider } from '@/providers/ThemeProvider'
import { InterfaceProvider } from '@/providers/InterfaceProvider'
import { UsageActivityRecorder } from '@/providers/UsageActivityRecorder'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { KeyboardShortcutsProvider } from '@/providers/KeyboardShortcuts'
import { DataProvider } from '@/providers/DataProvider'
import { route } from '@/constants/routes'
import { ExtensionProvider } from '@/providers/ExtensionProvider'
import { ToasterProvider } from '@/providers/ToasterProvider'
import { SearchDialog } from '@/containers/dialogs/SearchDialog'
import { CommandPalette } from '@/containers/CommandPalette'
import { useSearchDialog } from '@/hooks/useSearchDialog'
import { useClearSettingsSearchOnExit } from '@/hooks/useSettingsSearch'
import { TranslationProvider } from '@/i18n/TranslationContext'
import OutOfContextPromiseModal from '@/containers/dialogs/OutOfContextDialog'
import AccessRequestDialog from '@/containers/dialogs/AccessRequestDialog'
import AttachmentIngestionDialog from '@/containers/dialogs/AttachmentIngestionDialog'
import GlobalError from '@/containers/GlobalError'
import { GlobalEventHandler } from '@/providers/GlobalEventHandler'
import { ServiceHubProvider } from '@/providers/ServiceHubProvider'
import { WebPreviewHost } from '@/containers/WebPreviewHost'
import { WindowControls } from '@/components/WindowControls'
import { AppSidebar } from '@/components/shell/AppSidebar'
import { TopHeader } from '@/components/shell/TopHeader'
import { ShellNavProvider } from '@/components/shell/nav-kit'
import { HeaderSlotProvider } from '@/components/shell/HeaderSlot'
import { WindowResizeGrips } from '@/components/WindowResizeGrips'
import ErrorDialog from '@/containers/dialogs/ErrorDialog'
import LlamacppBusyOnExitDialog from '@/containers/dialogs/LlamacppBusyOnExitDialog'
import LlamacppOomListener from '@/containers/dialogs/LlamacppOomListener'
import MissingDependenciesDialog from '@/containers/dialogs/MissingDependenciesDialog'
import { MigrationAssistant } from '@/containers/MigrationAssistant'
import { TemporaryChatGuard } from '@/containers/TemporaryChatGuard'
import { useWindowTitle } from '@/hooks/useWindowTitle'
import { useAppViewport } from '@/hooks/useAppViewport'
import { detectWindowChrome } from '@/lib/titlebar'

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: ({ error }) => <GlobalError error={error} />,
})

/**
 * The app shell: the sidebar (on narrow windows a navigation sheet) beside the
 * main panel, a card-coloured surface holding the top header and the page.
 * Pages supply their header controls through HeaderPage and their content
 * through the router outlet.
 */
const AppLayout = () => {
  // The settings-search query outlives each settings page on purpose; it must
  // not outlive the section. Mounted here because this layout stays put.
  useClearSettingsSearchOnExit()
  useWindowTitle()
  useAppViewport()
  const appDrawsChrome = detectWindowChrome() === 'custom'

  return (
    <ShellNavProvider>
      <HeaderSlotProvider>
        <div
          data-testid="app-shell"
          className="app-zoom relative flex h-(--app-vvh,100dvh) w-full overflow-hidden bg-background"
        >
          <KeyboardShortcutsProvider />
          <TemporaryChatGuard />
          {/* Only a borderless window draws its own caption buttons and resize
              grips. Windows has a native title bar, which owns dragging, snap,
              double-click maximise and the caption buttons; nothing here may sit
              over the page pretending to be one (see lib/titlebar). */}
          {appDrawsChrome && <WindowControls />}
          {appDrawsChrome && <WindowResizeGrips />}
          <AppSidebar />
          <main
            data-testid="app-main"
            className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-card px-3 shadow-[inset_0_0_0_0.8px_var(--border)]"
          >
            <TopHeader />
            <div className="relative min-h-0 flex-1 overflow-hidden">
              <Outlet />
            </div>
          </main>
          <WebPreviewHost />
        </div>
      </HeaderSlotProvider>
    </ShellNavProvider>
  )
}

const LogsLayout = () => {
  return (
    <Fragment>
      <main className="app-zoom relative h-svh text-sm antialiased select-text bg-background p-2">
        <div className="flex h-full">
          {/* Main content panel */}
          <div className="h-full flex w-full">
            <div className="bg-card text-foreground w-full overflow-hidden rounded-xl shadow-[inset_0_0_0_0.8px_var(--border)]">
              <Outlet />
            </div>
          </div>
        </div>
      </main>
    </Fragment>
  )
}

function RootLayout() {
  const searchOpen = useSearchDialog((s) => s.open)
  const setSearchOpen = useSearchDialog((s) => s.setOpen)
  // Motion components follow Flint's Reduce motion setting, not the OS.
  const reduceMotion = useInterfaceSettings((s) => s.reduceMotion)
  const getInitialLayoutType = () => {
    const pathname = window.location.pathname
    return (
      pathname === route.localApiServerlogs ||
      pathname === route.systemMonitor ||
      pathname === route.appLogs
    )
  }

  const IS_LOGS_ROUTE = getInitialLayoutType()

  return (
    <MotionConfig reducedMotion={reduceMotion ? 'always' : 'never'}>
      <ServiceHubProvider>
        <ThemeProvider />
        <InterfaceProvider />
        <UsageActivityRecorder />
        <ToasterProvider />
        <TranslationProvider>
          <ExtensionProvider>
            <DataProvider />
            <GlobalEventHandler />
            {/* One mount, above every route: Search is offered from the
                rail and from Cowork's own header, and a dialog that lived
                inside the sidebar simply did not exist on a surface that did
                not render it. */}
            <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
            <CommandPalette />
            {IS_LOGS_ROUTE ? <LogsLayout /> : <AppLayout />}
          </ExtensionProvider>
          {/* <TanStackRouterDevtools position="bottom-right" /> */}
          <AttachmentIngestionDialog />
          <ErrorDialog />
          <LlamacppBusyOnExitDialog />
          <LlamacppOomListener />
          <MissingDependenciesDialog />
          <MigrationAssistant />
          <OutOfContextPromiseModal />
          <AccessRequestDialog />
        </TranslationProvider>
      </ServiceHubProvider>
    </MotionConfig>
  )
}
