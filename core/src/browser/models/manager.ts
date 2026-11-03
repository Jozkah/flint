import { Model, ModelEvent } from '../../types'
import { events } from '../events'

/**
 * Manages the registered models across extensions.
 */
export class ModelManager {
  public models = new Map<string, Model>()

  constructor() {
    if (typeof window !== 'undefined' && window.core) {
      window.core.modelManager = this
    }
  }

  private upsert<T extends Model>(model: T) {
    // Precedence is deliberate: a model that is already registered keeps its
    // stored values (user edits survive re-registration); the incoming entry
    // only fills in fields the stored one lacks.
    const existing = this.models.get(model.id)
    this.models.set(model.id, existing ? { ...model, ...existing } : model)
  }

  /**
   * Registers a model.
   * @param model - The model to register.
   */
  register<T extends Model>(model: T) {
    this.upsert(model)
    events.emit(ModelEvent.OnModelsUpdate, {})
  }

  /**
   * Registers several models and emits a single update event.
   * @param models - The models to register.
   */
  registerMany<T extends Model>(models: T[]) {
    if (!models.length) return
    for (const model of models) this.upsert(model)
    events.emit(ModelEvent.OnModelsUpdate, {})
  }

  /**
   * Retrieves a model by it's id.
   * @param id - The id of the model to retrieve.
   * @returns The model, if found.
   */
  get<T extends Model>(id: string): T | undefined {
    return this.models.get(id) as T | undefined
  }

  
  /**
   * Shared instance of ExtensionManager.
   */
  static instance() {
    if (!window.core.modelManager)
      window.core.modelManager = new ModelManager()
    return window.core.modelManager as ModelManager
  }
}
