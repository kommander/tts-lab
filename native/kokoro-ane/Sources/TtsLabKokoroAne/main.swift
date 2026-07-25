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

@main
private struct TtsLabKokoroAne {
    private static let encoder = JSONEncoder()

    static func main() async {
        guard SystemInfo.isAppleSilicon else {
            emit(Event(type: "fatal", error: "The CoreML ANE runtime requires Apple Silicon"))
            return
        }

        let manager = KokoroAneManager(defaultVoice: "af_heart")
        let loadStarted = Date()
        emit(Event(type: "status", detail: "Downloading and loading Kokoro CoreML models on ANE"))
        do {
            try await manager.initialize()
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
            await synthesize(request, with: manager)
        }
        await manager.cleanup()
    }

    private static func synthesize(_ request: Request, with manager: KokoroAneManager) async {
        let voice = request.voice ?? "af_heart"
        guard voice == "af_heart" else {
            emit(Event(type: "error", requestId: request.id, error: "CoreML ANE currently supports only af_heart"))
            return
        }

        emit(Event(type: "status", requestId: request.id, detail: "Synthesizing with Kokoro af_heart on CoreML ANE"))
        let started = Date()
        do {
            let wav = try await manager.synthesize(text: request.text, voice: voice)
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
