import { createRootRoute, Outlet } from '@tanstack/react-router'
// import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'

import { Fragment } from 'react/jsx-runtime'
import { ThemeProvider } from '@/providers/ThemeProvider'
import { InterfaceProvider } from '@/providers/InterfaceProvider'
import { KeyboardShortcutsProvider } from '@/providers/KeyboardShortcuts'
import { DataProvider } from '@/providers/DataProvider'
import { route } from '@/constants/routes'
import { ExtensionProvider } from '@/providers/ExtensionProvider'
import { ToasterProvider } from '@/providers/ToasterProvider'
import { SearchDialog } from '@/containers/dialogs/SearchDialog'
import { CommandPalette } from '@/containers/CommandPalette'
import { useSearchDialog } from '@/hooks/useSearchDialog'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { useClearSettingsSearchOnExit } from '@/hooks/useSettingsSearch'
import { TranslationProvider } from '@/i18n/TranslationContext'
import OutOfContextPromiseModal from '@/containers/dialogs/OutOfContextDialog'
import AttachmentIngestionDialog from '@/containers/dialogs/AttachmentIngestionDialog'
import GlobalError from '@/containers/GlobalError'
import { GlobalEventHandler } from '@/providers/GlobalEventHandler'
import { ServiceHubProvider } from '@/providers/ServiceHubProvider'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { LeftSidebar } from '@/components/left-sidebar'
import { WindowControls } from '@/components/WindowControls'
import { WindowResizeGrips } from '@/components/WindowResizeGrips'
import ErrorDialog from '@/containers/dialogs/ErrorDialog'
import LlamacppBusyOnExitDialog from '@/containers/dialogs/LlamacppBusyOnExitDialog'
import LlamacppOomListener from '@/containers/dialogs/LlamacppOomListener'
import MissingDependenciesDialog from '@/containers/dialogs/MissingDependenciesDialog'
import { TemporaryChatGuard } from '@/containers/TemporaryChatGuard'

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: ({ error }) => <GlobalError error={error} />,
})

const AppLayout = () => {
  // The settings-search query outlives each settings page on purpose; it must
  // not outlive the section. Mounted here because this layout stays put.
  useClearSettingsSearchOnExit()
  const {
    open: isLeftPanelOpen,
    setLeftPanel,
    width: sidebarWidth,
    setLeftPanelWidth,
  } = useLeftPanel()

  return (
    <div className="bg-neutral-50 dark:bg-background size-full relative">
      <SidebarProvider
        open={isLeftPanelOpen}
        onOpenChange={setLeftPanel}
        defaultWidth={sidebarWidth}
        onWidthChange={setLeftPanelWidth}
      >
        <KeyboardShortcutsProvider />
        <TemporaryChatGuard />
        {/* Fake absolute panel top to enable window drag */}
        {(IS_WINDOWS || IS_LINUX) && <WindowControls />}
        {IS_LINUX && <WindowResizeGrips />}
        {IS_TAURI && (
          // `pointer-events-none`: this strip spans the top 48px of the window,
          // which is exactly where the header's own controls sit. While it
          // accepted pointer events every one of them was unclickable -- the
          // press became a window drag, cursor and all. Dragging now comes from
          // the header itself (see HeaderPage), where Tauri's own rule that the
          // drag target must carry the attribute means a button on top of it
          // still behaves like a button.
          <div
            className="pointer-events-none fixed w-full h-12 z-20 top-0"
            aria-hidden
          />
        )}
        <LeftSidebar />
        <SidebarInset>
          <div className="bg-neutral-50 dark:bg-background size-full">
            <Outlet />
          </div>
        </SidebarInset>
      </SidebarProvider>
    </div>
  )
}

const LogsLayout = () => {
  return (
    <Fragment>
      <main className="relative h-svh text-sm antialiased select-text bg-app">
        <div className="flex h-full">
          {/* Main content panel */}
          <div className="h-full flex w-full">
            <div className="bg-background text-foreground border w-full overflow-hidden">
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
    <Fragment>
      <ServiceHubProvider>
        <ThemeProvider />
        <InterfaceProvider />
        <ToasterProvider />
        <TranslationProvider>
          <ExtensionProvider>
            <DataProvider />
            <GlobalEventHandler />
            {/* One mount, above every route: Search is offered from the
                sidebar and from Cowork's own header, and a dialog that lived
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
          <OutOfContextPromiseModal />
        </TranslationProvider>
      </ServiceHubProvider>
    </Fragment>
  )
}
