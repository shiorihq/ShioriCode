// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ShioriComputerUse",
    platforms: [
        .macOS(.v26)
    ],
    products: [
        .executable(name: "ShioriComputerUseHelper", targets: ["ShioriComputerUseHelper"])
    ],
    dependencies: [
        .package(url: "https://github.com/zats/permiso.git", branch: "main")
    ],
    targets: [
        .executableTarget(
            name: "ShioriComputerUseHelper",
            dependencies: [
                .product(name: "Permiso", package: "permiso")
            ]
        )
    ]
)
