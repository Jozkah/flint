import { describe, expect, it, vi } from 'vitest'
import {
  editorCommands,
  roomCommands,
  runCommands,
  type ControllerContext,
} from '../controllerCommands'
import type { RoomSlot } from '../controller'
import type { Room } from '../types'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }))

function fakeCtx(over: Partial<ControllerContext> = {}) {
  const slots = new Map<string, RoomSlot>()
  const slot = (id: string) => {
    let s = slots.get(id)
    if (!s) {
      s = { chain: Promise.resolve(), run: null, override: null, userQueue: [], stops: 0 }
      slots.set(id, s)
    }
    return s
  }
  const store = { removeRoomLocally: vi.fn(), loadRoom: vi.fn(async () => {}) }
  const port = { deleteRoom: vi.fn(async () => {}), deleteRoomPermanently: vi.fn(async () => {}) }
  const ctx: ControllerContext = {
    persistence: () => port as never,
    store: () => store as never,
    now: () => 5,
    newId: () => 'new',
    slot,
    slots,
    enqueue: (_id, op) => op(),
    saveRoom: vi.fn(async (r: Room) => r),
    appendMessage: vi.fn(async () => {}),
    userMessage: vi.fn() as never,
    launch: vi.fn(async () => {}),
    abortRun: vi.fn(async () => false),
    guarded: vi.fn(async (_a: string, op: () => Promise<void>) => op()),
    setStatusWhenIdle: vi.fn(async () => {}),
    refuseWhileRunning: vi.fn(),
    participantDeps: { newId: () => 'p', lookup: () => undefined as never },
    workspace: { ensure: vi.fn(), changes: vi.fn(), markTurn: vi.fn(), remove: vi.fn() } as never,
    ...over,
  }
  return { ctx, store, port }
}

describe('runCommands', () => {
  it('start launches a discussion through guarded', async () => {
    const { ctx } = fakeCtx()
    await runCommands(ctx).start('r')
    expect(ctx.guarded).toHaveBeenCalledWith('start', expect.any(Function))
    expect(ctx.launch).toHaveBeenCalledWith('r', { kind: 'discuss' }, expect.any(Function))
  })

  it('stop bumps the stop counter and settles status when no run is active', async () => {
    const { ctx } = fakeCtx()
    await runCommands(ctx).stop('r')
    expect(ctx.slot('r').stops).toBe(1)
    expect(ctx.abortRun).toHaveBeenCalledWith('r', 'stop')
    expect(ctx.setStatusWhenIdle).toHaveBeenCalled()
  })

  it('callVote refuses an empty proposal', async () => {
    const { ctx } = fakeCtx()
    await expect(runCommands(ctx).callVote('r', '  ')).rejects.toMatchObject({
      code: 'invalid_room',
    })
    expect(ctx.launch).not.toHaveBeenCalled()
  })

  it('isRunning reads the slot', () => {
    const { ctx } = fakeCtx()
    expect(runCommands(ctx).isRunning('r')).toBe(false)
  })
})

describe('editorCommands', () => {
  it('createRoom refuses a blank title and saves a draft otherwise', async () => {
    const { ctx } = fakeCtx()
    const cmds = editorCommands(ctx)
    await expect(cmds.createRoom({ title: ' ' })).rejects.toMatchObject({
      code: 'invalid_room',
    })
    const room = await cmds.createRoom({ title: ' T ' })
    expect(room).toMatchObject({ id: 'new', title: 'T', status: 'draft', createdAt: 5 })
  })
})

describe('roomCommands', () => {
  it('deleteRoom stops the run, deletes, drops the slot and the local copy', async () => {
    const { ctx, store, port } = fakeCtx()
    ctx.slot('r')
    await roomCommands(ctx).deleteRoom('r', { permanent: true })
    expect(ctx.abortRun).toHaveBeenCalledWith('r', 'stop')
    expect(port.deleteRoomPermanently).toHaveBeenCalledWith('r')
    expect(ctx.slots.has('r')).toBe(false)
    expect(store.removeRoomLocally).toHaveBeenCalledWith('r')
  })
})
