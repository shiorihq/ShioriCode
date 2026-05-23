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
        .package(
            url: "https://github.com/zats/permiso.git",
            revision: "3012871b741f68b1b6f46e2e1936c422df703968"
        )
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
