import { AIEngine } from './AIEngine'
import {
  InferenceEvent,
  MessageEvent,
  MessageRequest,
  Model,
} from '../../../types'
import { events } from '../../events'

/**
 * Base OAI Inference Provider
 * Applicable to all OAI compatible inference providers
 */
export abstract class OAIEngine extends AIEngine {
  // The inference engine
  abstract inferenceUrl: string

  // Controller to handle stop requests
  controller = new AbortController()
  isCancelled = false

  // The loaded model instance
  loadedModel: Model | undefined

  // Transform the payload
  transformPayload?: Function

  // Transform the response
  transformResponse?: Function

  /**
   * On extension load, subscribe to events.
   */
  // Kept as fields so onUnload can remove exactly what onLoad added.
  private readonly onMessageSent = (data: MessageRequest) =>
    this.inference(data)
  private readonly onInferenceStopped = () => this.stopInference()

  override onLoad() {
    super.onLoad()
    // A second load without an unload must not stack another listener.
    events.off(MessageEvent.OnMessageSent, this.onMessageSent)
    events.off(InferenceEvent.OnInferenceStopped, this.onInferenceStopped)
    events.on(MessageEvent.OnMessageSent, this.onMessageSent)
    events.on(InferenceEvent.OnInferenceStopped, this.onInferenceStopped)
  }

  /**
   * On extension unload
   */
  override onUnload(): void {
    events.off(MessageEvent.OnMessageSent, this.onMessageSent)
    events.off(InferenceEvent.OnInferenceStopped, this.onInferenceStopped)
  }

  inference(data: MessageRequest) {}

  /**
   * Stops the inference.
   */
  stopInference() {
    this.isCancelled = true
    this.controller?.abort()
  }

  /**
   * Headers for the inference request
   */
  async headers(): Promise<HeadersInit> {
    return {}
  }
}
