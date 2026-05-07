import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

enum HelperExitCode: Int32 {
    case ok = 0
    case failed = 1
}

struct HelperFailure: Error {
    let code: String
    let message: String
}

func readInputObject() throws -> [String: Any] {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard !data.isEmpty else { return [:] }
    let value = try JSONSerialization.jsonObject(with: data)
    return value as? [String: Any] ?? [:]
}

func writeJSON(_ object: [String: Any], exitCode: HelperExitCode = .ok) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [])) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(exitCode.rawValue)
}

func fail(_ code: String, _ message: String) -> Never {
    writeJSON(["code": code, "error": message], exitCode: .failed)
}

func requireAccessibility() throws {
    guard AXIsProcessTrusted() else {
        throw HelperFailure(
            code: "permissionDenied",
            message: "Accessibility permission is required before ShioriCode can control the macOS desktop."
        )
    }
}

func requireScreenRecording() throws {
    guard CGPreflightScreenCaptureAccess() else {
        throw HelperFailure(
            code: "permissionDenied",
            message: "Screen Recording permission is required before ShioriCode can capture the macOS desktop."
        )
    }
}

func number(_ input: [String: Any], _ key: String, fallback: Double? = nil) throws -> Double {
    if let value = input[key] as? Double { return value }
    if let value = input[key] as? Int { return Double(value) }
    if let fallback { return fallback }
    throw HelperFailure(code: "actionFailed", message: "Missing numeric field '\(key)'.")
}

func string(_ input: [String: Any], _ key: String, fallback: String? = nil) throws -> String {
    if let value = input[key] as? String { return value }
    if let fallback { return fallback }
    throw HelperFailure(code: "actionFailed", message: "Missing string field '\(key)'.")
}

func sessionId(_ input: [String: Any]) -> String {
    (input["sessionId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "computer-default"
}

func actionResult(_ input: [String: Any], _ message: String? = nil) -> [String: Any] {
    [
        "sessionId": sessionId(input),
        "ok": true,
        "message": message ?? NSNull()
    ]
}

func permissions() -> [String: Any] {
    let accessibility = AXIsProcessTrusted()
    let screenRecording = CGPreflightScreenCaptureAccess()
    return [
        "platform": "darwin",
        "supported": true,
        "helperAvailable": true,
        "helperPath": CommandLine.arguments.first ?? NSNull(),
        "checkedAt": ISO8601DateFormatter().string(from: Date()),
        "message": NSNull(),
        "permissions": [
            [
                "kind": "accessibility",
                "label": "Accessibility",
                "state": accessibility ? "granted" : "denied",
                "detail": accessibility
                    ? "ShioriCode can post keyboard and pointer events."
                    : "Enable Accessibility so ShioriCode can click, type, scroll, and press keys."
            ],
            [
                "kind": "screen-recording",
                "label": "Screen Recording",
                "state": screenRecording ? "granted" : "denied",
                "detail": screenRecording
                    ? "ShioriCode can capture screenshots for Computer Use."
                    : "Enable Screen Recording so ShioriCode can see the desktop before acting."
            ]
        ]
    ]
}

func screenshot(input: [String: Any]) throws -> [String: Any] {
    try requireScreenRecording()
    let fileURL = FileManager.default.temporaryDirectory
        .appendingPathComponent("shiori-computer-\(UUID().uuidString)")
        .appendingPathExtension("png")
    defer {
        try? FileManager.default.removeItem(at: fileURL)
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", "-t", "png", fileURL.path]
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
        throw HelperFailure(code: "actionFailed", message: "screencapture failed with status \(process.terminationStatus).")
    }
    let png = try Data(contentsOf: fileURL)
    guard let bitmap = NSBitmapImageRep(data: png) else {
        throw HelperFailure(code: "actionFailed", message: "Failed to decode the captured PNG.")
    }
    return [
        "sessionId": sessionId(input),
        "imageDataUrl": "data:image/png;base64,\(png.base64EncodedString())",
        "width": bitmap.pixelsWide,
        "height": bitmap.pixelsHigh,
        "capturedAt": ISO8601DateFormatter().string(from: Date())
    ]
}

func postMouse(type: CGEventType, point: CGPoint, button: CGMouseButton) {
    CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button)?
        .post(tap: .cghidEventTap)
}

func click(input: [String: Any]) throws -> [String: Any] {
    try requireAccessibility()
    let point = CGPoint(x: try number(input, "x"), y: try number(input, "y"))
    let buttonName = (input["button"] as? String) ?? "left"
    let button: CGMouseButton = buttonName == "right" ? .right : .left
    let downType: CGEventType = button == .right ? .rightMouseDown : .leftMouseDown
    let upType: CGEventType = button == .right ? .rightMouseUp : .leftMouseUp
    let clickCount = max(1, min(Int(try number(input, "clickCount", fallback: 1)), 3))
    for _ in 0..<clickCount {
        postMouse(type: downType, point: point, button: button)
        usleep(35_000)
        postMouse(type: upType, point: point, button: button)
        usleep(55_000)
    }
    return actionResult(input, "Clicked at \(Int(point.x)), \(Int(point.y)).")
}

func move(input: [String: Any]) throws -> [String: Any] {
    try requireAccessibility()
    let point = CGPoint(x: try number(input, "x"), y: try number(input, "y"))
    postMouse(type: .mouseMoved, point: point, button: .left)
    return actionResult(input, "Moved pointer to \(Int(point.x)), \(Int(point.y)).")
}

func typeText(input: [String: Any]) throws -> [String: Any] {
    try requireAccessibility()
    let text = try string(input, "text")
    for character in text {
        var utf16 = Array(String(character).utf16)
        guard !utf16.isEmpty else { continue }
        let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
        down?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
        down?.post(tap: .cghidEventTap)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        up?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
        up?.post(tap: .cghidEventTap)
        usleep(8_000)
    }
    return actionResult(input, "Typed \(text.count) character\(text.count == 1 ? "" : "s").")
}

let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
    "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28,
    "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36,
    "enter": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
    "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50, "delete": 51,
    "backspace": 51, "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125,
    "up": 126, "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121
]

func flags(from input: [String: Any]) -> CGEventFlags {
    guard let modifiers = input["modifiers"] as? [String] else { return [] }
    var flags = CGEventFlags()
    for modifier in modifiers {
        switch modifier.lowercased() {
        case "command": flags.insert(.maskCommand)
        case "control": flags.insert(.maskControl)
        case "option": flags.insert(.maskAlternate)
        case "shift": flags.insert(.maskShift)
        default: break
        }
    }
    return flags
}

func pressKey(input: [String: Any]) throws -> [String: Any] {
    try requireAccessibility()
    let rawKey = try string(input, "key").lowercased()
    guard let keyCode = keyCodes[rawKey] else {
        throw HelperFailure(code: "actionFailed", message: "Unsupported key '\(rawKey)'.")
    }
    let eventFlags = flags(from: input)
    let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true)
    down?.flags = eventFlags
    down?.post(tap: .cghidEventTap)
    usleep(25_000)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false)
    up?.flags = eventFlags
    up?.post(tap: .cghidEventTap)
    return actionResult(input, "Pressed \(rawKey).")
}

func scroll(input: [String: Any]) throws -> [String: Any] {
    try requireAccessibility()
    let deltaY = Int32(try number(input, "deltaY", fallback: 0))
    let deltaX = Int32(try number(input, "deltaX", fallback: 0))
    CGEvent(
        scrollWheelEvent2Source: nil,
        units: .line,
        wheelCount: 2,
        wheel1: deltaY,
        wheel2: deltaX,
        wheel3: 0
    )?.post(tap: .cghidEventTap)
    return actionResult(input, "Scrolled.")
}

func permissionKind(_ input: [String: Any]) -> String {
    (input["kind"] as? String) == "screen-recording" ? "screen-recording" : "accessibility"
}

func permissionSettingsURL(kind: String) -> URL {
    let pane = kind == "screen-recording" ? "Privacy_ScreenCapture" : "Privacy_Accessibility"
    return URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)")!
}

func openPermissionGuide(input: [String: Any]) -> [String: Any] {
    let kind = permissionKind(input)
    let opened = NSWorkspace.shared.open(permissionSettingsURL(kind: kind))
    return [
        "ok": opened,
        "kind": kind,
        "message": opened
            ? "Opened macOS Privacy & Security settings."
            : "Could not open macOS Privacy & Security settings."
    ]
}

func requestPermission(input: [String: Any]) -> [String: Any] {
    let kind = permissionKind(input)
    if kind == "screen-recording" {
        let granted = CGRequestScreenCaptureAccess()
        return [
            "ok": granted,
            "kind": "screen-recording",
            "message": granted
                ? "Screen Recording permission is enabled."
                : "Screen Recording still needs to be enabled in System Settings."
        ]
    }

    let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
    let granted = AXIsProcessTrustedWithOptions(options)
    return [
        "ok": granted,
        "kind": "accessibility",
        "message": granted
            ? "Accessibility permission is enabled."
            : "Accessibility still needs to be enabled in System Settings."
    ]
}

do {
    let command = CommandLine.arguments.dropFirst().first ?? "permissions"
    let input = try readInputObject()
    switch command {
    case "permissions":
        writeJSON(permissions())
    case "screenshot":
        writeJSON(try screenshot(input: input))
    case "click":
        writeJSON(try click(input: input))
    case "move":
        writeJSON(try move(input: input))
    case "type":
        writeJSON(try typeText(input: input))
    case "key":
        writeJSON(try pressKey(input: input))
    case "scroll":
        writeJSON(try scroll(input: input))
    case "request-permission":
        writeJSON(requestPermission(input: input))
    case "permission-guide":
        writeJSON(openPermissionGuide(input: input))
    default:
        fail("actionFailed", "Unsupported command '\(command)'.")
    }
} catch let error as HelperFailure {
    fail(error.code, error.message)
} catch {
    fail("actionFailed", String(describing: error))
}
