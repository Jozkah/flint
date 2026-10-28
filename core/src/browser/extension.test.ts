import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { BaseExtension } from './extension'
import { SettingComponentProps } from '../types'
vi.mock('./core')
vi.mock('./fs')

class TestBaseExtension extends BaseExtension {
  onLoad(): void {}
  onUnload(): void {}
}

describe('BaseExtension', () => {
  let baseExtension: TestBaseExtension

  beforeEach(() => {
    baseExtension = new TestBaseExtension('https://example.com', 'TestExtension')
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('should have the correct properties', () => {
    expect(baseExtension.name).toBe('TestExtension')
    expect(baseExtension.productName).toBeUndefined()
    expect(baseExtension.url).toBe('https://example.com')
    expect(baseExtension.active).toBeUndefined()
    expect(baseExtension.description).toBeUndefined()
    expect(baseExtension.version).toBeUndefined()
  })

  it('should return undefined for type()', () => {
    expect(baseExtension.type()).toBeUndefined()
  })

  it('should have abstract methods onLoad() and onUnload()', () => {
    expect(baseExtension.onLoad).toBeDefined()
    expect(baseExtension.onUnload).toBeDefined()
  })

  it('should install the extension', async () => {
    await baseExtension.install()
    // Add your assertions here
  })
})

describe('BaseExtension', () => {
  class TestBaseExtension extends BaseExtension {
    onLoad(): void {}
    onUnload(): void {}
  }

  let baseExtension: TestBaseExtension

  beforeEach(() => {
    baseExtension = new TestBaseExtension('https://example.com', 'TestExtension')
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('should have the correct properties', () => {
    expect(baseExtension.name).toBe('TestExtension')
    expect(baseExtension.productName).toBeUndefined()
    expect(baseExtension.url).toBe('https://example.com')
    expect(baseExtension.active).toBeUndefined()
    expect(baseExtension.description).toBeUndefined()
    expect(baseExtension.version).toBeUndefined()
  })

  it('should return undefined for type()', () => {
    expect(baseExtension.type()).toBeUndefined()
  })

  it('should have abstract methods onLoad() and onUnload()', () => {
    expect(baseExtension.onLoad).toBeDefined()
    expect(baseExtension.onUnload).toBeDefined()
  })

  it('should install the extension', async () => {
    await baseExtension.install()
    // Add your assertions here
  })

  it('should register settings', async () => {
    const settings: SettingComponentProps[] = [
      { key: 'setting1', controllerProps: { value: 'value1' } } as any,
      { key: 'setting2', controllerProps: { value: 'value2' } } as any,
    ]

    const localStorageMock = (() => {
      let store: Record<string, string> = {}

      return {
        getItem: (key: string) => store[key] || null,
        setItem: (key: string, value: string) => {
          store[key] = value
        },
        removeItem: (key: string) => {
          delete store[key]
        },
        clear: () => {
          store = {}
        },
      }
    })()

    Object.defineProperty(global, 'localStorage', {
      value: localStorageMock,
    })
    const mock = vi.spyOn(localStorage, 'setItem')
    await baseExtension.registerSettings(settings)

    expect(mock).toHaveBeenCalledWith(
      'TestExtension',
      JSON.stringify(settings)
    )
  })

  it('should get setting with default value', async () => {
    const settings: SettingComponentProps[] = [
      { key: 'setting1', controllerProps: { value: 'value1' } } as any,
    ]

    vi.spyOn(baseExtension, 'getSettings').mockResolvedValue(settings)

    const value = await baseExtension.getSetting('setting1', 'defaultValue')
    expect(value).toBe('value1')

    const defaultValue = await baseExtension.getSetting('setting2', 'defaultValue')
    expect(defaultValue).toBe('defaultValue')
  })

  it('should update settings', async () => {
    const settings: SettingComponentProps[] = [
      { key: 'setting1', controllerProps: { value: 'value1' } } as any,
    ]

    vi.spyOn(baseExtension, 'getSettings').mockResolvedValue(settings)
    const mockSetItem = vi.spyOn(localStorage, 'setItem')

    await baseExtension.updateSettings([
      { key: 'setting1', controllerProps: { value: 'newValue' } } as any,
    ])

    expect(mockSetItem).toHaveBeenCalledWith(
      'TestExtension',
      JSON.stringify([{ key: 'setting1', controllerProps: { value: 'newValue' } }])
    )
  })

  it('should reset dropdown value when persisted value is no longer valid', async () => {
    localStorage.clear()

    const oldSettings = [
      {
        key: 'flash_attn',
        controllerProps: {
          value: 'ON',
          options: [
            { value: 'auto', name: 'Auto' },
            { value: 'on', name: 'ON' },
            { value: 'off', name: 'OFF' },
          ],
        },
      },
    ]

    localStorage.setItem('TestExtension', JSON.stringify(oldSettings))

    const newSettings: SettingComponentProps[] = [
      {
        key: 'flash_attn',
        controllerProps: {
          value: 'auto',
          options: [
            { value: 'auto', name: 'Auto' },
            { value: 'on', name: 'On' },
            { value: 'off', name: 'Off' },
          ],
        },
      } as any,
    ]

    const setItemSpy = vi.spyOn(localStorage, 'setItem')

    await baseExtension.registerSettings(newSettings)

    expect(setItemSpy).toHaveBeenCalled()
    const [, latestPayload] = setItemSpy.mock.calls[setItemSpy.mock.calls.length - 1]
    const persistedSettings = JSON.parse(latestPayload)
    const flashSetting = persistedSettings.find(
      (setting: any) => setting.key === 'flash_attn'
    )

    expect(flashSetting.controllerProps.value).toBe('auto')

    setItemSpy.mockRestore()
    localStorage.clear()
  })

  it('partial patch keeps the full saved list and notifies only changed keys', async () => {
    const saved = [
      { key: 'a', controllerProps: { value: 1 } },
      { key: 'b', controllerProps: { value: 2 } },
    ]
    vi.spyOn(baseExtension, 'getSettings').mockResolvedValue(saved as any)
    const setItem = vi.spyOn(localStorage, 'setItem')
    const notify = vi.spyOn(baseExtension, 'onSettingUpdate')

    await baseExtension.updateSettings([
      { key: 'a', controllerProps: { value: 9 } } as any,
    ])

    const [, payload] = setItem.mock.calls[setItem.mock.calls.length - 1]
    expect(JSON.parse(payload).map((s: any) => s.key)).toEqual(['a', 'b'])
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('a', 9)
  })

  it('registerSettings heals a corrupt blob and skips entries without controllerProps', async () => {
    localStorage.setItem('TestExtension', '{"not":"an array"}')
    const fresh: any[] = [
      { key: 'x', controllerProps: { value: 'v' } },
      { key: 'broken' },
    ]
    await expect(baseExtension.registerSettings(fresh)).resolves.toBeUndefined()
    const stored = JSON.parse(localStorage.getItem('TestExtension') as string)
    expect(stored.find((s: any) => s.key === 'x').controllerProps.value).toBe('v')
    localStorage.clear()
  })
})
