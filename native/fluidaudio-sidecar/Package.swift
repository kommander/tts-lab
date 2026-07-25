// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "TtsLabFluidAudio",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "tts-lab-fluidaudio", targets: ["TtsLabFluidAudio"])
    ],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.15.5")
    ],
    targets: [
        .executableTarget(
            name: "TtsLabFluidAudio",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")]
        )
    ]
)
