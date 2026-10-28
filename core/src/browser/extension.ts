import { Model, SettingComponentProps } from '../types'
import { ModelManager } from './models'
import { logger } from './logger'

export enum ExtensionTypeEnum {
  Assistant = 'assistant',
  Conversational = 'conversational',
  Inference = 'inference',
  Model = 'model',
  SystemMonitoring = 'systemMonitoring',
  MCP = 'mcp',
  HuggingFace = 'huggingFace',
  Engine = 'engine',
  Hardware = 'hardware',
  RAG = 'rag',
  VectorDB = 'vectorDB',
}

export interface ExtensionType {
  type(): ExtensionTypeEnum | undefined
}

export interface Compatibility {
  platform: string[]
  version: string
}

/**
 * Represents a base extension.
 * This class should be extended by any class that represents an extension.
 */
export abstract class BaseExtension implements ExtensionType {
  protected settingFolderName = 'settings'
  protected settingFileName = 'settings.json'

  /** @type {string} Name of the extension. */
  name: string

  /** @type {string} Product Name of the extension. */
  productName?: string

  /** @type {string} The URL of the extension to load. */
  url: string

  /** @type {boolean} Whether the extension is activated or not. */
  active

  /** @type {string} Extension's description. */
  description

  /** @type {string} Extension's version. */
  version

  constructor(
    url: string,
    name: string,
    productName?: string,
    active?: boolean,
    description?: string,
    version?: string
  ) {
    this.name = name
    this.productName = productName
    this.url = url
    this.active = active
    this.description = description
    this.version = version
  }

  /**
   * Returns the type of the extension.
   * @returns {ExtensionType} The type of the extension
   * Undefined means its not extending any known extension by the application.
   */
  type(): ExtensionTypeEnum | undefined {
    return undefined
  }

  /**
   * Called when the extension is loaded.
   * Any initialization logic for the extension should be put here.
   */
  abstract onLoad(): void

  /**
   * Called when the extension is unloaded.
   * Any cleanup logic for the extension should be put here.
   */
  abstract onUnload(): void

  /**
   * The compatibility of the extension.
   * This is used to check if the extension is compatible with the current environment.
   * @property {Array} platform
   */
  compatibility(): Compatibility | undefined {
    return undefined
  }

  /**
   * Registers models - it persists in-memory shared ModelManager instance's data map.
   * @param models
   */
  async registerModels(models: Model[]): Promise<void> {
    for (const model of models) {
      ModelManager.instance().register(model)
    }
  }

  /**
   * Register settings for the extension.
   * @param settings
   * @returns
   */
  async registerSettings(settings: SettingComponentProps[]): Promise<void> {
    if (!this.name) {
      logger.error('Extension name is not defined')
      return
    }

    settings.forEach((setting) => {
      setting.extensionName = this.name
    })
    try {
      const oldSettingsJson = localStorage.getItem(this.name)
      // Persists new settings
      if (oldSettingsJson) {
        // A corrupt or foreign blob is treated as "no saved settings" so the
        // fresh list below overwrites it instead of throwing every time.
        let parsed: unknown
        try {
          parsed = JSON.parse(oldSettingsJson)
        } catch {
          parsed = []
        }
        const oldSettings: any[] = Array.isArray(parsed) ? parsed : []
        settings.forEach((setting) => {
          const props = setting.controllerProps
          if (!props) return
          const old = oldSettings.find((e: any) => e?.key === setting.key)
          // Keep setting value
          props.value = old?.controllerProps?.value ?? props.value
          if ('options' in props) {
            props.options = props.options?.length
              ? props.options
              : old?.controllerProps?.options
            if (!props.options?.some((e) => e.value === props.value)) {
              props.value = props.options?.[0]?.value ?? props.value
            }
          }
          if ('recommended' in props) {
            const oldRecommended = old?.controllerProps?.recommended
            if (oldRecommended !== undefined && oldRecommended !== '') {
              props.recommended = oldRecommended
            }
          }
        })
      }
      localStorage.setItem(this.name, JSON.stringify(settings))
    } catch (err) {
      logger.error(err)
    }
  }

  /**
   * Get the setting value for the key.
   * @param key
   * @param defaultValue
   * @returns
   */
  async getSetting<T>(key: string, defaultValue: T) {
    const keySetting = (await this.getSettings()).find((setting) => setting.key === key)

    const value = keySetting?.controllerProps.value
    return (value as T) ?? defaultValue
  }

  onSettingUpdate<T>(key: string, value: T) {
    return
  }

  /**
   * Install the prerequisites for the extension.
   *
   * @returns {Promise<void>}
   */
  async install(): Promise<void> {
    return
  }

  /**
   * Get the settings for the extension.
   * @returns
   */
  async getSettings(): Promise<SettingComponentProps[]> {
    if (!this.name) return []

    try {
      const settingsString = localStorage.getItem(this.name)
      if (!settingsString) return []
      const settings: SettingComponentProps[] = JSON.parse(settingsString)
      return settings
    } catch (err) {
      logger.warn(err)
      return []
    }
  }

  /**
   * Update the settings for the extension.
   * @param componentProps
   * @returns
   */
  async updateSettings(componentProps: Partial<SettingComponentProps>[]): Promise<void> {
    if (!this.name) return

    const settings = (await this.getSettings()).filter((s) => s && s.controllerProps)
    const changed: SettingComponentProps[] = []

    let updatedSettings = settings.map((setting) => {
      const updatedSetting = componentProps.find(
        (componentProp) => componentProp.key === setting.key
      )
      if (updatedSetting && updatedSetting.controllerProps) {
        if (setting.controllerProps.value !== updatedSetting.controllerProps.value) {
          changed.push(setting)
        }
        setting.controllerProps.value = updatedSetting.controllerProps.value
      }
      return setting
    })

    if (!updatedSettings.length) {
      // Nothing saved yet: the patch itself is the list, minus entries that
      // cannot be read back later.
      updatedSettings = (componentProps as SettingComponentProps[]).filter(
        (s) => s && s.controllerProps
      )
      changed.push(...updatedSettings)
    }

    localStorage.setItem(this.name, JSON.stringify(updatedSettings))

    changed.forEach((setting) => {
      this.onSettingUpdate<typeof setting.controllerProps.value>(
        setting.key,
        setting.controllerProps.value
      )
    })
  }
}
