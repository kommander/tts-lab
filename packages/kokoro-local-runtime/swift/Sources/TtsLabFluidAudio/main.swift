import Darwin
import FluidAudio
import Foundation

private struct Request: Decodable {
    let id: String
    let text: String
    let output: String
    let voice: String?
}

private struct ResourceUsage: Encodable {
    let rssBytes: UInt64?
    let peakRssBytes: UInt64?
}

private struct Event: Encodable {
    let type: String
    var requestId: String?
    var detail: String?
    var output: String?
    var loadMs: Double?
    var generationMs: Double?
    var error: String?
    var resource: ResourceUsage?

    enum CodingKeys: String, CodingKey {
        case type
        case requestId = "request_id"
        case detail
        case output
        case loadMs = "load_ms"
        case generationMs = "generation_ms"
        case error
        case resource
    }
}

private protocol SpeechBackend: Sendable {
    var loadStatus: String { get }
    func initialize() async throws
    func synthesize(text: String, voice: String?) async throws -> Data
    func status(for voice: String?) -> String
    func cleanup() async
}

private actor KokoroBackend: SpeechBackend {
    nonisolated let loadStatus = "Downloading and loading Kokoro CoreML models on ANE"
    private let manager = KokoroAneManager(defaultVoice: "af_heart")

    func initialize() async throws {
        try await manager.initialize()
    }

    func synthesize(text: String, voice: String?) async throws -> Data {
        let selected = voice ?? "af_heart"
        guard selected == "af_heart" else {
            throw BackendError.unsupportedVoice("Kokoro CoreML ANE currently supports only af_heart")
        }
        return try await manager.synthesize(text: text, voice: selected)
    }

    nonisolated func status(for voice: String?) -> String {
        "Synthesizing with Kokoro \(voice ?? "af_heart") on CoreML ANE"
    }

    func cleanup() async {
        await manager.cleanup()
    }
}

private actor PocketBackend: SpeechBackend {
    nonisolated let loadStatus = "Loading pinned Pocket TTS FP16 models on CoreML ANE"
    nonisolated private static let allowedVoices: Set<String> = [
        "alba", "estelle", "marius", "javert", "bill_boerst", "caro_davy",
        "peter_yearsley", "stuart_bell",
    ]
    private let manager: PocketTtsManager

    init(assets: URL) {
        ModelHub.offlineMode = true
        manager = PocketTtsManager(
            defaultVoice: "alba",
            language: .english,
            directory: assets,
            precision: .fp16,
            placement: .ane
        )
    }

    func initialize() async throws {
        try await manager.initialize()
    }

    func synthesize(text: String, voice: String?) async throws -> Data {
        let selected = voice ?? "alba"
        guard Self.allowedVoices.contains(selected) else {
            throw BackendError.unsupportedVoice("Pocket TTS voice is not in the pinned catalog: \(selected)")
        }
        return try await manager.synthesize(
            text: text,
            voice: selected,
            temperature: 0.3,
            deEss: true,
            maxTokensPerChunk: 50
        )
    }

    nonisolated func status(for voice: String?) -> String {
        "Synthesizing with Pocket TTS \(voice ?? "alba") on CoreML ANE"
    }

    func cleanup() async {
        await manager.cleanup()
    }
}

private enum BackendError: LocalizedError {
    case invalidArguments(String)
    case unsupportedVoice(String)

    var errorDescription: String? {
        switch self {
        case .invalidArguments(let message), .unsupportedVoice(let message): message
        }
    }
}

@main
private struct TtsLabFluidAudio {
    private static let encoder = JSONEncoder()

    static func main() async {
        guard SystemInfo.isAppleSilicon else {
            emit(Event(type: "fatal", error: "The CoreML ANE runtime requires Apple Silicon"))
            return
        }

        let backend: any SpeechBackend
        do {
            backend = try makeBackend(arguments: Array(CommandLine.arguments.dropFirst()))
        } catch {
            emit(Event(type: "fatal", error: error.localizedDescription))
            return
        }

        let loadStarted = Date()
        emit(Event(type: "status", detail: backend.loadStatus))
        do {
            try await backend.initialize()
        } catch {
            emit(Event(type: "fatal", error: error.localizedDescription))
            return
        }
        emit(Event(
            type: "ready",
            loadMs: Date().timeIntervalSince(loadStarted) * 1000,
            resource: resourceUsage()
        ))

        while let line = readLine() {
            guard let data = line.data(using: .utf8) else { continue }
            let request: Request
            do {
                request = try JSONDecoder().decode(Request.self, from: data)
            } catch {
                emit(Event(type: "error", error: "Invalid request: \(error.localizedDescription)"))
                continue
            }
            await synthesize(request, with: backend)
        }
        await backend.cleanup()
    }

    private static func makeBackend(arguments: [String]) throws -> any SpeechBackend {
        var backendName: String?
        var assetsPath: String?
        var index = 0
        while index < arguments.count {
            guard index + 1 < arguments.count else {
                throw BackendError.invalidArguments("Missing value for \(arguments[index])")
            }
            switch arguments[index] {
            case "--backend": backendName = arguments[index + 1]
            case "--assets": assetsPath = arguments[index + 1]
            default: throw BackendError.invalidArguments("Unknown argument: \(arguments[index])")
            }
            index += 2
        }

        switch backendName {
        case "kokoro": return KokoroBackend()
        case "pocket":
            guard let assetsPath else {
                throw BackendError.invalidArguments("Pocket TTS requires --assets")
            }
            return PocketBackend(assets: URL(fileURLWithPath: assetsPath, isDirectory: true))
        default:
            throw BackendError.invalidArguments("Use --backend kokoro or --backend pocket")
        }
    }

    private static func synthesize(_ request: Request, with backend: any SpeechBackend) async {
        emit(Event(type: "status", requestId: request.id, detail: backend.status(for: request.voice)))
        let started = Date()
        do {
            let wav = try await backend.synthesize(text: request.text, voice: request.voice)
            let output = URL(fileURLWithPath: request.output)
            try FileManager.default.createDirectory(
                at: output.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try wav.write(to: output, options: .atomic)
            emit(Event(
                type: "result",
                requestId: request.id,
                output: request.output,
                generationMs: Date().timeIntervalSince(started) * 1000,
                resource: resourceUsage()
            ))
        } catch {
            emit(Event(type: "error", requestId: request.id, error: error.localizedDescription))
        }
    }

    private static func resourceUsage() -> ResourceUsage {
        ResourceUsage(
            rssBytes: SystemInfo.currentResidentMemoryBytes(),
            peakRssBytes: SystemInfo.peakResidentMemoryBytes()
        )
    }

    private static func emit(_ event: Event) {
        guard let data = try? encoder.encode(event) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
}
