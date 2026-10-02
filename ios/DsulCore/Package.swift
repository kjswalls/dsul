// swift-tools-version: 6.0
// DsulCore: the iPhone app's Swift port of the web app's pure planner logic.
// Foundation only, so `swift test` runs on Linux as well as macOS.
import PackageDescription

let package = Package(
    name: "DsulCore",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [
        .library(name: "DsulCore", targets: ["DsulCore"]),
    ],
    targets: [
        .target(name: "DsulCore"),
        .testTarget(name: "DsulCoreTests", dependencies: ["DsulCore"]),
    ]
)
