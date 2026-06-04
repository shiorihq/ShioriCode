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
        .package(
            url: "https://github.com/actuallyepic/background-computer-use",
            revision: "52116acfe0f2f57174f5e0166881abe944cb6eeb"
        )
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
                .product(name: "BackgroundComputerUseKit", package: "background-computer-use")
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
