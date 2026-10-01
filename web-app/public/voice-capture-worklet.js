// Delivers microphone audio to the page in chunks. Loaded as a file, not from
// a blob, because the app's content security policy only allows scripts from
// its own origin.
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    if (input && input.length > 0 && input[0].length > 0) {
      this.port.postMessage(input.map((channel) => channel.slice()))
    }
    return true
  }
}
registerProcessor('flint-capture', CaptureProcessor)
