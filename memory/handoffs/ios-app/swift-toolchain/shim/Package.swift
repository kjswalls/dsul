// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "DsulShim",
    platforms: [.macOS(.v15)],
    dependencies: [.package(path: "/work/ios/DsulCore")],
    targets: [
        .target(name: "Accessibility"),
        .target(name: "SwiftUI"),
        .target(name: "Dsul", dependencies: ["Accessibility", "SwiftUI", .product(name: "DsulCore", package: "DsulCore")]),
        .testTarget(name: "DsulTests", dependencies: ["Dsul", .product(name: "DsulCore", package: "DsulCore")]),
    ]
)
