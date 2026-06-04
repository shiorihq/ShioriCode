// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ShioriComputerUse",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "ShioriComputerUseHelper", targets: ["ShioriComputerUseHelper"])
    ],
    dependencies: [
        .package(path: "../BackgroundComputerUse")
    ],
    targets: [
        .target(
            name: "Permiso",
            exclude: ["README.md"]
        ),
        .executableTarget(
            name: "ShioriComputerUseHelper",
            dependencies: [
                "Permiso",
                .product(name: "BackgroundComputerUseKit", package: "BackgroundComputerUse")
            ],
            exclude: ["Info.plist"],
            linkerSettings: [
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Sources/ShioriComputerUseHelper/Info.plist"
                ])
            ]
        )
    ]
)
