// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "TtsLabKokoroAne",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "tts-lab-kokoro-ane", targets: ["TtsLabKokoroAne"])
    ],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.15.5")
    ],
    targets: [
        .executableTarget(
            name: "TtsLabKokoroAne",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")]
        )
    ]
)
