// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CPMenubar",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "CPMenubarCore"),
        .executableTarget(name: "CPMenubar", dependencies: ["CPMenubarCore"]),
        .testTarget(name: "CPMenubarCoreTests", dependencies: ["CPMenubarCore"]),
    ]
)
