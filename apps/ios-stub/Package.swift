// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "MosaicCore",
    platforms: [
        .iOS(.v16),
        .macOS(.v13)
    ],
    products: [
        .library(
            name: "MosaicCore",
            targets: ["MosaicCore"]
        )
    ],
    targets: [
        .target(
            name: "MosaicCore",
            dependencies: ["MosaicUniFFI"]
        ),
        .binaryTarget(
            name: "MosaicUniFFI",
            path: "Generated/MosaicUniFFI.xcframework"
        ),
        .testTarget(
            name: "MosaicCoreTests",
            dependencies: ["MosaicCore"]
        )
    ]
)
