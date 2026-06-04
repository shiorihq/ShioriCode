// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ShioriComputerUse",
    platforms: [
        .macOS(.v12)
    ],
    products: [
        .executable(name: "ShioriComputerUseHelper", targets: ["ShioriComputerUseHelper"])
    ],
    targets: [
        .target(
            name: "Permiso",
            exclude: ["README.md"]
        ),
        .executableTarget(
            name: "ShioriComputerUseHelper",
            dependencies: [
                "Permiso"
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
