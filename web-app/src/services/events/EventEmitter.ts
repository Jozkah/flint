/**
 * EventEmitter class - matches jan-dev implementation
 * Used by ExtensionProvider to set window.core.events
 */

/* eslint-disable @typescript-eslint/no-unsafe-function-type */
export class EventEmitter {
  private handlers: Map<string, Function[]>

  constructor() {
    this.handlers = new Map<string, Function[]>()
  }

  public on(eventName: string, handler: Function): void {
    if (!this.handlers.has(eventName)) {
      this.handlers.set(eventName, [])
    }

    this.handlers.get(eventName)?.push(handler)
  }

  public off(eventName: string, handler: Function): void {
    if (!this.handlers.has(eventName)) {
      return
    }

    const handlers = this.handlers.get(eventName)
    const index = handlers?.indexOf(handler)

    if (index !== undefined && index !== -1) {
      handlers?.splice(index, 1)
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public emit(eventName: string, args: any): void {
    if (!this.handlers.has(eventName)) {
      return
    }

    const handlers = this.handlers.get(eventName)

    // A copy, so a handler that removes itself does not skip the next one,
    // and one that throws does not stop the rest.
    ;[...(handlers ?? [])].forEach((handler) => {
      try {
        handler(args)
      } catch (error) {
        console.error(`Handler for ${eventName} failed:`, error)
      }
    })
  }
}
