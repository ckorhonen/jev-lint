// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "App",
    platforms: [.macOS(.v13)],
    targets: [.target(name: "App", path: "Sources/App")]
)
