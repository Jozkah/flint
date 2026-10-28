import { AIEngine } from './AIEngine'

/**
 * Manages the registration and retrieval of inference engines.
 */
export class EngineManager {
  public engines = new Map<string, AIEngine>()
  public controller: AbortController | null = null

  /**
   * Registers an engine.
   * @param engine - The engine to register.
   */
  register<T extends AIEngine>(engine: T) {
    this.engines.set(engine.provider, engine)
  }

  /**
   * Retrieves a engine by provider.
   * @param provider - The name of the engine to retrieve.
   * @returns The engine, if found.
   */
  get<T extends AIEngine>(provider: string): T | undefined {
    return this.engines.get(provider) as T | undefined
  }

  /**
   * The instance of the engine manager.
   */
  static instance(): EngineManager {
    const existing = window.core?.engineManager as EngineManager | undefined
    if (existing) return existing
    // Remember the instance, so two callers share one registry of engines.
    const created = new EngineManager()
    if (window.core) {
      const core = window.core as { engineManager?: unknown }
      core.engineManager = created
    }
    return created
  }
}
