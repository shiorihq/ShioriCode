// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ShioriComputerUse",
    platforms: [
        .macOS(.v15)
    ],
    products: [
        .executable(name: "ShioriComputerUseHelper", targets: ["ShioriComputerUseHelper"])
    ],
    targets: [
        .executableTarget(name: "ShioriComputerUseHelper")
    ]
)
