import { describe, expect, it } from 'vitest'
import { effectivePermissionMode, permissionModeField } from '../permissionMode'

describe('effectivePermissionMode', () => {
  it('is ask when nothing was chosen (rooms saved before modes existed)', () => {
    expect(effectivePermissionMode({})).toBe('ask')
    expect(effectivePermissionMode({}, {})).toBe('ask')
  })
  it("uses the room's mode, and the participant's own over it", () => {
    expect(effectivePermissionMode({ permissionMode: 'auto' }, {})).toBe('auto')
    expect(effectivePermissionMode({ permissionMode: 'auto' }, { permissionMode: 'review' })).toBe('review')
    expect(effectivePermissionMode({}, { permissionMode: 'bypass' })).toBe('bypass')
  })
  it('ignores a value that is not one of the four modes', () => {
    expect(permissionModeField('yolo')).toBeUndefined()
    expect(effectivePermissionMode({ permissionMode: 'yolo' as never })).toBe('ask')
  })
})
