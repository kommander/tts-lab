import Darwin
import FluidAudio
import Foundation

struct Request: Decodable {
    let id: String
    let text: String
    let output: String
    let voice: String?
    let parameters: [String: JSONScalar]?

    private enum CodingKeys: String, CodingKey {
        case id, text, output, voice, parameters
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        text = try container.decode(String.self, forKey: .text)
        output = try container.decode(String.self, forKey: .output)
        voice = try container.decodeIfPresent(String.self, forKey: .voice)
        if container.contains(.parameters) {
            parameters = try container.decode([String: JSONScalar].self, forKey: .parameters)
        } else {
            parameters = nil
        }
    }
}

private struct RequestIdentifier: Decodable {
    let id: String
}

func requestID(in data: Data) -> String? {
    try? JSONDecoder().decode(RequestIdentifier.self, from: data).id
}

enum JSONScalar: Decodable, Sendable, Equatable {
    case number(Double)
    case boolean(Bool)
    case string(String)

    init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(Bool.self) {
            self = .boolean(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else {
            throw DecodingError.typeMismatch(JSONScalar.self, .init(
                codingPath: decoder.codingPath,
                debugDescription: "Synthesis parameter values must be numbers, booleans, or strings"
            ))
        }
    }
}

enum KokoroParameters {
    static func parse(_ parameters: [String: JSONScalar]?) throws -> Float {
        let supplied = parameters ?? [:]
        if let unknown = supplied.keys.first(where: { $0 != "speed" }) {
            throw BackendError.invalidParameters("Unknown synthesis parameter: \(unknown)")
        }
        let speed: Double
        if let value = supplied["speed"] {
            guard case .number(let number) = value else {
                throw BackendError.invalidParameters("speed must be a finite number")
            }
            speed = number
        } else {
            speed = 1.0
        }
        guard speed.isFinite else {
            throw BackendError.invalidParameters("speed must be a finite number")
        }
        guard speed >= 0.5, speed <= 2.0 else {
            throw BackendError.invalidParameters("speed must be between 0.5 and 2")
        }
        let steps = (speed - 0.5) / 0.1
        guard abs(steps - steps.rounded()) <= 0.000001 else {
            throw BackendError.invalidParameters("speed must use increments of 0.1")
        }
        return Float(speed)
    }
}

struct PocketParameters: Equatable {
    let temperature: Float
    let deEss: Bool

    static func parse(_ parameters: [String: JSONScalar]?) throws -> PocketParameters {
        let supplied = parameters ?? [:]
        let allowed = Set(["temperature", "deEss"])
        if let unknown = supplied.keys.first(where: { !allowed.contains($0) }) {
            throw BackendError.invalidParameters("Unknown synthesis parameter: \(unknown)")
        }
        let temperature: Float
        switch supplied["temperature"] {
        case nil, .string("stable"): temperature = 0.3
        case .string("deterministic"): temperature = 0.0
        case .string("upstream"): temperature = 0.7
        case .string:
            throw BackendError.invalidParameters("temperature must be one of: deterministic, stable, upstream")
        default:
            throw BackendError.invalidParameters("temperature must be an enum string")
        }
        let deEss: Bool
        switch supplied["deEss"] {
        case nil: deEss = true
        case .boolean(let value): deEss = value
        default: throw BackendError.invalidParameters("deEss must be a boolean")
        }
        return PocketParameters(temperature: temperature, deEss: deEss)
    }
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
    func synthesize(text: String, voice: String?, parameters: [String: JSONScalar]?) async throws -> Data
    func status(for voice: String?) -> String
    func cleanup() async
}

private actor KokoroBackend: SpeechBackend {
    nonisolated let loadStatus = "Downloading and loading Kokoro CoreML models on ANE"
    private let manager = KokoroAneManager(defaultVoice: "af_heart")

    func initialize() async throws {
        try await manager.initialize()
    }

    func synthesize(text: String, voice: String?, parameters: [String: JSONScalar]?) async throws -> Data {
        let selected = voice ?? "af_heart"
        guard selected == "af_heart" else {
            throw BackendError.unsupportedVoice("Kokoro CoreML ANE currently supports only af_heart")
        }
        return try await manager.synthesize(text: text, voice: selected, speed: KokoroParameters.parse(parameters))
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

    func synthesize(text: String, voice: String?, parameters: [String: JSONScalar]?) async throws -> Data {
        let selected = voice ?? "alba"
        guard Self.allowedVoices.contains(selected) else {
            throw BackendError.unsupportedVoice("Pocket TTS voice is not in the pinned catalog: \(selected)")
        }
        let parsed = try PocketParameters.parse(parameters)
        return try await manager.synthesize(
            text: text,
            voice: selected,
            temperature: parsed.temperature,
            deEss: parsed.deEss,
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
    case invalidParameters(String)
    case unsupportedVoice(String)

    var errorDescription: String? {
        switch self {
        case .invalidArguments(let message), .invalidParameters(let message), .unsupportedVoice(let message): message
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
                emit(Event(
                    type: "error",
                    requestId: requestID(in: data),
                    error: "Invalid request: \(error.localizedDescription)"
                ))
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
            let wav = try await backend.synthesize(
                text: request.text,
                voice: request.voice,
                parameters: request.parameters
            )
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
