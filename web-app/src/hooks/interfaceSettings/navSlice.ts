// The interface settings store's sidebar items and presets.

import type { StoreApi } from 'zustand'
import { hiddenForPreset, hideableSidebarIds, resolveSidebarDefaults } from '@/lib/sidebarItems'
import type { InterfaceSettingsState } from './types'

/** Which sidebar items show, and the presets that set them. */
export const navActions = (
  set: StoreApi<InterfaceSettingsState>['setState'],
  get: StoreApi<InterfaceSettingsState>['getState']
): Pick<
  InterfaceSettingsState,
  'setNavItemHidden'
  | 'showAllNavItems'
  | 'applyNavPreset'
  | 'resolveNavDefaults'
> => ({
  setNavItemHidden: (id, hidden) =>
    set((state) => {
      if (!hideableSidebarIds().includes(id)) return state
      const rest = state.hiddenNavItems.filter((h) => h !== id)
      return { hiddenNavItems: hidden ? [...rest, id] : rest }
    }),

  // Ids this version does not know are kept: they may belong to a newer
  // build the person goes back to.
  showAllNavItems: () =>
    set((state) => ({
      hiddenNavItems: state.hiddenNavItems.filter(
        (h) => !hideableSidebarIds().includes(h)
      ),
    })),

  // Unknown ids are kept, as in showAllNavItems.
  applyNavPreset: (preset) =>
    set((state) => ({
      hiddenNavItems: [
        ...state.hiddenNavItems.filter(
          (h) => !hideableSidebarIds().includes(h)
        ),
        ...hiddenForPreset(preset),
      ],
    })),

  resolveNavDefaults: (existingInstall) => {
    const state = get()
    const next = resolveSidebarDefaults({
      decidedVersion: state.sidebarDefaultsVersion,
      hidden: state.hiddenNavItems,
      existingInstall,
    })
    if (!next) return
    set({
      hiddenNavItems: next.hidden,
      sidebarDefaultsVersion: next.decidedVersion,
    })
  },
})
