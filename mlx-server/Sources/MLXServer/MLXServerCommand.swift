import ArgumentParser
import Foundation
import Hummingbird
import MLX

@main
struct MLXServerCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "mlx-server",
        abstract: "MLX-Swift inference server with OpenAI-compatible API"
    )

    @Option(name: [.long, .short], help: "Path to the model directory, or a file inside it")
    var model: String

    @Option(name: .long, help: "Port to listen on")
    var port: Int = 8080

    /// Optional on purpose: MLX's `maxKVSize` is a rotating sliding window, not
    /// a hard cap, so a default here would silently drop every session's
    /// oldest tokens past it (#70). Only an explicit `--ctx-size` applies it.
    @Option(name: .long, help: "Context window size (bounds the KV cache when given)")
    var ctxSize: Int?

    @Option(name: .long, help: "API key for authentication (optional)")
    var apiKey: String = ""

    @Option(name: .long, help: "Model ID reported by the API (defaults to parent directory name)")
    var modelId: String = ""

    /// MLX buffer cache limit: 20 GiB. It was `20 * 1024 * 1024`, 20 MiB,
    /// which made the allocator churn buffers on every step (#75).
    static let gpuCacheLimitBytes: Int = {
        // A quarter of physical memory, capped at 20 GiB: on an 8-16 GB Mac a
        // flat 20 GiB is no limit at all.
        let ceiling = 20 * 1024 * 1024 * 1024
        let quarter = Int(ProcessInfo.processInfo.physicalMemory / 4)
        return min(ceiling, quarter)
    }()

    func run() async throws {
        // Set GPU memory limit to prevent OOM issues
        Memory.cacheLimit = Self.gpuCacheLimitBytes

        // Print startup info
        log("[mlx] MLX-Swift Server starting...")
        log("[mlx] Model path: \(model)")
        log("[mlx] Port: \(port)")
        log("[mlx] Context size: \(ctxSize.map(String.init) ?? "model default")")
        log("[mlx] Memory cache limit: \(Memory.cacheLimit / (1024 * 1024))MB")

        // Resolve model ID: use --model-id if provided, otherwise derive from parent directory
        let modelURL = URL(fileURLWithPath: model)
        let resolvedModelId = modelId.isEmpty
            ? modelURL.deletingPathExtension().lastPathComponent
            : modelId

        // Load the model
        let modelRunner = ModelRunner()
        // Apply --ctx-size, when given, to every chat session.
        await modelRunner.setContextLength(ctxSize)

        do {
            try await modelRunner.load(modelPath: model)
        } catch {
            log("[mlx] Failed to load model: \(error)")
            throw error
        }

        // Set up the HTTP server. The key comes from the environment so it is
        // not visible in the process list; `--api-key` still works.
        let resolvedKey = apiKey.isEmpty
            ? (ProcessInfo.processInfo.environment["MLX_API_KEY"] ?? "")
            : apiKey
        let server = MLXHTTPServer(
            modelRunner: modelRunner,
            modelId: resolvedModelId,
            apiKey: resolvedKey
        )

        let router = server.buildRouter()
        let listenPort = port
        let app = Application(
            router: router,
            configuration: .init(address: .hostname("127.0.0.1", port: listenPort)),
            // Fires once the socket is bound, so the readiness line the Tauri
            // plugin watches for is never printed for a port that failed to
            // bind (or before the first request could be accepted).
            onServerRunning: { _ in
                log("[mlx] http server listening on http://127.0.0.1:\(listenPort)")
                log("[mlx] server is listening on 127.0.0.1:\(listenPort)")
            }
        )

        try await app.run()
    }
}
