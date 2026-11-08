import { create } from 'zustand'
import type { ThreadState } from '@/hooks/threads/types'
import { threadListSlice } from '@/hooks/threads/listSlice'
import { threadDeletion } from '@/hooks/threads/deletionSlice'
import { threadCreationSlice } from '@/hooks/threads/creationSlice'
import { threadUpdatesSlice } from '@/hooks/threads/updatesSlice'

export { isSummaryAssistant } from '@/hooks/threads/types'
export type { ThreadState } from '@/hooks/threads/types'

export const useThreads = create<ThreadState>()((set, get) => ({
  threads: {},
  isLoadingThreads: true,
  setThreadsLoading: (loading) => set({ isLoadingThreads: loading }),
  searchIndex: null,
  ...threadListSlice(set, get),
  ...threadDeletion(set, get),
  ...threadCreationSlice(set, get),
  ...threadUpdatesSlice(set, get),
}))
