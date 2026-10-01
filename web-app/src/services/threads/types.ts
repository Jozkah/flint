/**
 * Threads Service Types
 */

export interface ThreadsService {
  fetchThreads(): Promise<Thread[]>
  createThread(thread: Thread): Promise<Thread>
  updateThread(thread: Thread): Promise<void>
  /**
   * Delete a thread. It goes to the archive unless `permanent` is set (or the
   * archive is off), in which case it is destroyed.
   */
  deleteThread(threadId: string, permanent?: boolean): Promise<void>
}
