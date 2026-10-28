import { events } from '../../events'
import { Model, ModelEvent } from '../../../types'
import { OAIEngine } from './OAIEngine'

/**
 * Base OAI Local Inference Provider
 * Added the implementation of loading and unloading model (applicable to local inference providers)
 */
export abstract class LocalOAIEngine extends OAIEngine {
  // The inference engine
  abstract nodeModule: string
  loadModelFunctionName: string = 'loadModel'
  unloadModelFunctionName: string = 'unloadModel'

  /**
   * This class represents a base for local inference providers in the OpenAI architecture.
   * It extends the OAIEngine class and provides the implementation of loading and unloading models locally.
   * The loadModel function subscribes to the ModelEvent.OnModelInit event, loading models when initiated.
   * The unloadModel function subscribes to the ModelEvent.OnModelStop event, unloading models when stopped.
   */
  // Kept as fields so onUnload can remove exactly what onLoad added.
  private readonly onModelInit = (model: Model) => this.loadModel(model)
  private readonly onModelStop = (model: Model) => this.unloadModel(model)

  override onLoad() {
    super.onLoad()
    // These events are applicable to local inference providers
    events.off(ModelEvent.OnModelInit, this.onModelInit)
    events.off(ModelEvent.OnModelStop, this.onModelStop)
    events.on(ModelEvent.OnModelInit, this.onModelInit)
    events.on(ModelEvent.OnModelStop, this.onModelStop)
  }

  override onUnload(): void {
    super.onUnload()
    events.off(ModelEvent.OnModelInit, this.onModelInit)
    events.off(ModelEvent.OnModelStop, this.onModelStop)
  }

  /**
   * Load the model.
   */
  async loadModel(model: Model & { file_path?: string }): Promise<void> {
    // Implementation of loading the model
  }

  /**
   * Stops the model.
   */
  async unloadModel(model?: Model) {
    // Implementation of unloading the model
  }
}
