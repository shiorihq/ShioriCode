import AppKit
import ApplicationServices
import BackgroundComputerUse
import CoreGraphics
import Foundation
import Permiso

enum HelperExitCode: Int32 {
    case ok = 0
    case failed = 1
}

struct HelperFailure: Error {
    let code: String
    let message: String
}

struct PermissionGuideRequest: Sendable {
    let kind: String
    let hostAppBundlePath: String?
    let hostAppDisplayName: String?
    let durationSeconds: Double
}

let defaultPermissionGuideDurationSeconds = 18.0
let maximumPermissionGuideDurationSeconds = 22.0

func readInputObject() throws -> [String: Any] {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard !data.isEmpty else { return [:] }
    let value = try JSONSerialization.jsonObject(with: data)
    guard let object = value as? [String: Any] else {
        throw HelperFailure(code: "actionFailed", message: "Expected a JSON object on stdin.")
    }
    return object
}

func writeJSON(_ object: [String: Any], exitCode: HelperExitCode = .ok) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [])) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(exitCode.rawValue)
}

func writeEncodableJSON<T: Encodable>(_ value: T, exitCode: HelperExitCode = .ok) -> Never {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    let data = (try? encoder.encode(value)) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(exitCode.rawValue)
}

/// Serve-mode variant of `writeJSON` that keeps the process alive.
func writeJSONLine(_ object: [String: Any]) {
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [])) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func encodableJSONObject<T: Encodable>(_ value: T) throws -> [String: Any] {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    let data = try encoder.encode(value)
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw HelperFailure(code: "actionFailed", message: "Helper produced a non-object result.")
    }
    return object
}

func fail(_ code: String, _ message: String) -> Never {
    writeJSON(["code": code, "error": message], exitCode: .failed)
}

/// Snapshot of the login-session state so callers can tell whether the screen
/// is locked or the session lost the console. Accessibility actions and
/// per-window capture keep working while locked; global HID input does not
/// (it would land on the lock screen), so the legacy input commands refuse to
/// run in that state and every bcu result carries this snapshot as context.
func loginSessionStateSnapshot() -> [String: Any] {
    guard let dictionary = CGSessionCopyCurrentDictionary() as? [String: Any] else {
        // No WindowServer session dictionary (e.g. SSH-only login). Report the
        // degraded state instead of guessing.
        return ["screenLocked": false, "onConsole": false, "sessionAvailable": false]
    }
    return [
        "screenLocked": (dictionary["CGSSessionScreenIsLocked"] as? Bool) ?? false,
        "onConsole": (dictionary["kCGSSessionOnConsoleKey"] as? Bool) ?? true,
        "sessionAvailable": true,
    ]
}

func requireUnlockedScreenForGlobalInput(actionName: String) throws {
    let state = loginSessionStateSnapshot()
    guard (state["screenLocked"] as? Bool) != true else {
        throw HelperFailure(
            code: "permissionDenied",
            message: "The macOS screen is locked, so Computer Use \(actionName) is blocked: global input events would target the lock screen instead of the app. Use the app-scoped Shiori Computer Use tools (get_app_state, click, type_text, ...) which deliver input directly to the app, or unlock the Mac."
        )
    }
}

func requireAccessibility() throws {
    guard AXIsProcessTrusted() else {
        throw HelperFailure(
            code: "permissionDenied",
            message: "Accessibility permission is required before the ShioriCode Computer Use helper can control the macOS desktop."
        )
    }
}

func requireScreenRecording() throws {
    guard CGPreflightScreenCaptureAccess() else {
        throw HelperFailure(
            code: "permissionDenied",
            message: "Screen Recording permission is required before the ShioriCode Computer Use helper can capture the macOS desktop."
        )
    }
}

func finiteNumberValue(_ raw: Any) -> Double? {
    if raw is Bool { return nil }
    if let value = raw as? Double { return value }
    if let value = raw as? Int { return Double(value) }
    if let value = raw as? NSNumber { return value.doubleValue }
    return nil
}

func number(_ input: [String: Any], _ key: String, fallback: Double? = nil) throws -> Double {
    guard let raw = input[key] else {
        if let fallback { return fallback }
        throw HelperFailure(code: "actionFailed", message: "Missing numeric field '\(key)'.")
    }
    guard let value = finiteNumberValue(raw), value.isFinite else {
        throw HelperFailure(code: "actionFailed", message: "Field '\(key)' must be a finite number.")
    }
    return value
}

func optionalNumber(_ input: [String: Any], _ key: String) throws -> Double? {
    guard let raw = input[key] else { return nil }
    guard let value = finiteNumberValue(raw), value.isFinite else {
        throw HelperFailure(code: "actionFailed", message: "Field '\(key)' must be a finite number.")
    }
    return value
}

func integer(
    _ input: [String: Any],
    _ key: String,
    fallback: Int,
    min minimum: Int,
    max maximum: Int
) throws -> Int {
    let value = try number(input, key, fallback: Double(fallback))
    guard value >= Double(minimum), value <= Double(maximum) else {
        throw HelperFailure(
            code: "actionFailed",
            message: "Field '\(key)' must be between \(minimum) and \(maximum)."
        )
    }
    return Int(value.rounded())
}

func optionalString(_ input: [String: Any], _ key: String, fallback: String? = nil) throws -> String? {
    guard let raw = input[key] else { return fallback }
    guard let value = raw as? String else {
        throw HelperFailure(code: "actionFailed", message: "Field '\(key)' must be a string.")
    }
    return value
}

func optionalStringArray(_ input: [String: Any], _ key: String) throws -> [String]? {
    guard let raw = input[key] else { return nil }
    guard let values = raw as? [String] else {
        throw HelperFailure(code: "actionFailed", message: "Field '\(key)' must be an array of strings.")
    }
    return values
}

func approvedAppBundleIdentifierSet(_ input: [String: Any]) throws -> Set<String>? {
    guard input["approvedAppBundleIdentifiers"] != nil else { return nil }
    let values = try optionalStringArray(input, "approvedAppBundleIdentifiers") ?? []
    return Set(
        values
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    )
}

func string(_ input: [String: Any], _ key: String, fallback: String? = nil) throws -> String {
    if let value = try optionalString(input, key, fallback: fallback) {
        return value
    }
    if let fallback { return fallback }
    throw HelperFailure(code: "actionFailed", message: "Missing string field '\(key)'.")
}

func sessionId(_ input: [String: Any]) -> String {
    (input["sessionId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "computer-default"
}

func activeDisplayIds() -> [CGDirectDisplayID] {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else {
        return [CGMainDisplayID()]
    }
    var displays = Array(repeating: CGDirectDisplayID(), count: Int(count))
    guard CGGetActiveDisplayList(count, &displays, &count) == .success else {
        return [CGMainDisplayID()]
    }
    return Array(displays.prefix(Int(count)))
}

func activeDisplayBounds() -> [CGRect] {
    activeDisplayIds().map(CGDisplayBounds)
}

func virtualScreenBounds() -> CGRect {
    activeDisplayBounds().reduce(CGRect.null) { partial, bounds in
        partial.union(bounds)
    }
}

func rectSnapshot(_ rect: CGRect) -> [String: Any] {
    [
        "x": Double(rect.minX),
        "y": Double(rect.minY),
        "width": Double(rect.width),
        "height": Double(rect.height)
    ]
}

func screenshotBackingScale() -> CGFloat {
    activeDisplayIds().reduce(CGFloat(1)) { current, display in
        let bounds = CGDisplayBounds(display)
        guard bounds.width > 0, bounds.height > 0 else { return current }
        let scaleX = CGFloat(CGDisplayPixelsWide(display)) / bounds.width
        let scaleY = CGFloat(CGDisplayPixelsHigh(display)) / bounds.height
        return max(current, scaleX, scaleY, 1)
    }
}

func screenshotPixelSize(virtualBounds bounds: CGRect, backingScale: CGFloat) -> CGSize {
    CGSize(
        width: max(1, ceil(bounds.width * backingScale)),
        height: max(1, ceil(bounds.height * backingScale))
    )
}

func screenshotBounds(forDisplayBounds bounds: CGRect, virtualBounds: CGRect, backingScale: CGFloat) -> CGRect {
    CGRect(
        x: ((bounds.minX - virtualBounds.minX) * backingScale).rounded(),
        y: ((bounds.minY - virtualBounds.minY) * backingScale).rounded(),
        width: max(1, (bounds.width * backingScale).rounded()),
        height: max(1, (bounds.height * backingScale).rounded())
    )
}

func displaySnapshots(virtualBounds: CGRect? = nil, backingScale: CGFloat? = nil) -> [[String: Any]] {
    let mainDisplay = CGMainDisplayID()
    let resolvedVirtualBounds = virtualBounds ?? virtualScreenBounds()
    let resolvedBackingScale = backingScale ?? screenshotBackingScale()
    return activeDisplayIds().map { display in
        let bounds = CGDisplayBounds(display)
        let pixelsWide = CGDisplayPixelsWide(display)
        let pixelsHigh = CGDisplayPixelsHigh(display)
        let scaleX = bounds.width > 0 ? CGFloat(pixelsWide) / bounds.width : 1
        let scaleY = bounds.height > 0 ? CGFloat(pixelsHigh) / bounds.height : 1
        return [
            "id": Double(display),
            "bounds": rectSnapshot(bounds),
            "screenshotBounds": rectSnapshot(
                screenshotBounds(
                    forDisplayBounds: bounds,
                    virtualBounds: resolvedVirtualBounds,
                    backingScale: resolvedBackingScale
                )
            ),
            "pixelsWide": Double(pixelsWide),
            "pixelsHigh": Double(pixelsHigh),
            "scaleX": Double(scaleX),
            "scaleY": Double(scaleY),
            "isMain": display == mainDisplay
        ]
    }
}

func pointSnapshot(_ point: CGPoint) -> [String: Any] {
    [
        "x": Double(point.x),
        "y": Double(point.y)
    ]
}

func pointIsInsideActiveDisplay(_ point: CGPoint) -> Bool {
    activeDisplayBounds().contains { bounds in
        bounds.insetBy(dx: -0.5, dy: -0.5).contains(point)
    }
}

func pointFromInput(_ input: [String: Any], xKey: String = "x", yKey: String = "y") throws -> CGPoint {
    let point = CGPoint(x: try number(input, xKey), y: try number(input, yKey))
    let coordinateSpace = (try optionalString(input, "coordinateSpace", fallback: "screenshot") ?? "screenshot")
        .lowercased()
    if coordinateSpace == "screen" {
        return point
    }
    guard coordinateSpace == "screenshot" else {
        throw HelperFailure(code: "actionFailed", message: "Unsupported coordinateSpace '\(coordinateSpace)'.")
    }

    let bounds = virtualScreenBounds()
    guard !bounds.isNull, bounds.width > 0, bounds.height > 0 else {
        throw HelperFailure(code: "actionFailed", message: "Could not resolve the active macOS display bounds.")
    }
    let fallbackSize = screenshotPixelSize(virtualBounds: bounds, backingScale: screenshotBackingScale())
    let screenshotWidth = try optionalNumber(input, "screenshotWidth") ?? Double(fallbackSize.width)
    let screenshotHeight = try optionalNumber(input, "screenshotHeight") ?? Double(fallbackSize.height)
    guard screenshotWidth > 0, screenshotHeight > 0 else {
        throw HelperFailure(code: "actionFailed", message: "Screenshot dimensions must be positive.")
    }
    guard point.x >= 0, point.y >= 0, point.x <= CGFloat(screenshotWidth), point.y <= CGFloat(screenshotHeight) else {
        throw HelperFailure(code: "actionFailed", message: "Screenshot coordinates must be inside the screenshot bounds.")
    }

    let scaleX = CGFloat(screenshotWidth) / bounds.width
    let scaleY = CGFloat(screenshotHeight) / bounds.height
    let screenPoint = CGPoint(
        x: bounds.minX + point.x / scaleX,
        y: bounds.minY + point.y / scaleY
    )
    guard pointIsInsideActiveDisplay(screenPoint) else {
        throw HelperFailure(code: "actionFailed", message: "Screenshot coordinates must target an active display.")
    }
    return screenPoint
}

func cursorPointInScreenshot(width: CGFloat, height: CGFloat) -> CGPoint? {
    guard let location = CGEvent(source: nil)?.location else { return nil }
    let bounds = virtualScreenBounds()
    guard !bounds.isNull, bounds.width > 0, bounds.height > 0 else { return nil }
    guard pointIsInsideActiveDisplay(location) else { return nil }
    let scaleX = width / bounds.width
    let scaleY = height / bounds.height
    let point = CGPoint(x: (location.x - bounds.minX) * scaleX, y: (location.y - bounds.minY) * scaleY)
    guard point.x.isFinite, point.y.isFinite else { return nil }
    return point
}

func cursorPointInScreenshot(bitmap: NSBitmapImageRep) -> CGPoint? {
    cursorPointInScreenshot(width: CGFloat(bitmap.pixelsWide), height: CGFloat(bitmap.pixelsHigh))
}

func drawShioriCursor(context: CGContext, tip: CGPoint, scale: CGFloat) {
    context.saveGState()
    context.translateBy(x: tip.x, y: tip.y)
    context.scaleBy(x: scale, y: scale)

    context.setLineCap(.round)
    context.setLineJoin(.round)
    context.setShadow(
        offset: CGSize(width: 0, height: -2),
        blur: 12,
        color: NSColor.black.withAlphaComponent(0.32).cgColor
    )

    let glow = CGMutablePath()
    glow.addEllipse(in: CGRect(x: -10, y: -30, width: 42, height: 42))
    context.addPath(glow)
    context.setStrokeColor(NSColor.systemCyan.withAlphaComponent(0.24).cgColor)
    context.setLineWidth(2)
    context.strokePath()

    let cursor = CGMutablePath()
    cursor.move(to: CGPoint(x: 0, y: 0))
    cursor.addLine(to: CGPoint(x: 7, y: -24))
    cursor.addCurve(
        to: CGPoint(x: 13, y: -14),
        control1: CGPoint(x: 8.2, y: -20.2),
        control2: CGPoint(x: 10.2, y: -16.8)
    )
    cursor.addLine(to: CGPoint(x: 23, y: -12))
    cursor.addCurve(
        to: CGPoint(x: 25, y: -7),
        control1: CGPoint(x: 26.2, y: -11.3),
        control2: CGPoint(x: 27.1, y: -8.7)
    )
    cursor.addCurve(
        to: CGPoint(x: 20, y: -5),
        control1: CGPoint(x: 23.8, y: -5.6),
        control2: CGPoint(x: 22.1, y: -5)
    )
    cursor.addLine(to: CGPoint(x: 11, y: -7))
    cursor.addLine(to: CGPoint(x: 5, y: 1))
    cursor.addCurve(
        to: CGPoint(x: 0, y: 0),
        control1: CGPoint(x: 3.1, y: 3.5),
        control2: CGPoint(x: 0.1, y: 2.7)
    )
    cursor.closeSubpath()

    context.addPath(cursor)
    context.setFillColor(NSColor(calibratedWhite: 0.06, alpha: 0.94).cgColor)
    context.fillPath()

    context.addPath(cursor)
    context.setStrokeColor(NSColor.white.withAlphaComponent(0.94).cgColor)
    context.setLineWidth(2.2)
    context.strokePath()

    let highlight = CGMutablePath()
    highlight.move(to: CGPoint(x: 4.8, y: -5.5))
    highlight.addLine(to: CGPoint(x: 8.8, y: -17.4))
    context.addPath(highlight)
    context.setStrokeColor(NSColor.white.withAlphaComponent(0.45).cgColor)
    context.setLineWidth(1.1)
    context.strokePath()

    context.setShadow(offset: .zero, blur: 0, color: nil)
    context.addEllipse(in: CGRect(x: -2.6, y: -2.6, width: 5.2, height: 5.2))
    context.setFillColor(NSColor.systemCyan.cgColor)
    context.fillPath()

    context.restoreGState()
}

func dataWithCursorOverlay(_ png: Data, bitmap: NSBitmapImageRep) -> Data {
    guard
        let image = NSImage(data: png),
        let cursorPoint = cursorPointInScreenshot(bitmap: bitmap)
    else {
        return png
    }

    let outputSize = NSSize(width: bitmap.pixelsWide, height: bitmap.pixelsHigh)
    let output = NSImage(size: outputSize)
    output.lockFocus()
    image.draw(in: NSRect(origin: .zero, size: outputSize))
    if let context = NSGraphicsContext.current?.cgContext {
        let minimumDimension = min(outputSize.width, outputSize.height)
        let scale = max(0.9, min(1.8, minimumDimension / 900))
        drawShioriCursor(
            context: context,
            tip: CGPoint(x: cursorPoint.x, y: outputSize.height - cursorPoint.y),
            scale: scale
        )
    }
    output.unlockFocus()

    guard
        let tiff = output.tiffRepresentation,
        let representation = NSBitmapImageRep(data: tiff),
        let cursorPng = representation.representation(using: .png, properties: [:])
    else {
        return png
    }
    return cursorPng
}

func actionResult(_ input: [String: Any], _ message: String? = nil) -> [String: Any] {
    var result: [String: Any] = [
        "sessionId": sessionId(input),
        "ok": true,
        "message": message ?? NSNull()
    ]
    if let cursorScreenPosition = CGEvent(source: nil)?.location {
        result["cursorScreenPosition"] = pointSnapshot(cursorScreenPosition)
    }
    let approvedBundleIds: Set<String>? = (try? approvedAppBundleIdentifierSet(input)) ?? nil
    if let activeApp = activeApplicationSnapshot(approvedBundleIds: approvedBundleIds) {
        result["activeApp"] = activeApp
    }
    return result
}

func activationPolicyName(_ policy: NSApplication.ActivationPolicy) -> String {
    switch policy {
    case .regular:
        return "regular"
    case .accessory:
        return "accessory"
    case .prohibited:
        return "prohibited"
    @unknown default:
        return "unknown"
    }
}

func appSnapshot(_ app: NSRunningApplication) -> [String: Any] {
    [
        "processIdentifier": Int(app.processIdentifier),
        "name": appDisplayName(app),
        "bundleIdentifier": app.bundleIdentifier ?? NSNull(),
        "bundlePath": app.bundleURL?.path ?? NSNull(),
        "activationPolicy": activationPolicyName(app.activationPolicy),
        "isActive": app.isActive,
        "isHidden": app.isHidden,
        "windows": axWindows(for: app)
    ]
}

func appIsApproved(_ app: NSRunningApplication, approvedBundleIds: Set<String>?) -> Bool {
    guard let approvedBundleIds else { return true }
    guard !approvedBundleIds.isEmpty else { return false }
    guard let bundleIdentifier = app.bundleIdentifier else {
        return false
    }
    return approvedBundleIds.contains(bundleIdentifier)
}

func activeApplicationSnapshot(approvedBundleIds: Set<String>? = nil) -> [String: Any]? {
    guard let app = NSWorkspace.shared.frontmostApplication, !app.isTerminated else {
        return nil
    }
    guard appIsApproved(app, approvedBundleIds: approvedBundleIds) else {
        return nil
    }
    return appSnapshot(app)
}

func requireApprovedActiveApp(input: [String: Any], actionName: String) throws {
    let approvedBundleIds = try approvedAppBundleIdentifierSet(input)
    guard let approvedBundleIds else { return }
    try requireNonEmptyApprovedApps(approvedBundleIds: approvedBundleIds, actionName: actionName)

    guard let app = NSWorkspace.shared.frontmostApplication, !app.isTerminated else {
        throw HelperFailure(
            code: "permissionDenied",
            message: "Computer Use \(actionName) requires an approved foreground app, but no foreground app was detected."
        )
    }

    guard appIsApproved(app, approvedBundleIds: approvedBundleIds) else {
        let appName = appDisplayName(app)
        let bundleIdentifier = app.bundleIdentifier ?? "unknown bundle"
        throw HelperFailure(
            code: "permissionDenied",
            message: "Computer Use \(actionName) is blocked because the foreground app '\(appName)' (\(bundleIdentifier)) is not approved in Settings > Computer Use."
        )
    }
}

func requireNonEmptyApprovedApps(approvedBundleIds: Set<String>?, actionName: String) throws {
    guard let approvedBundleIds else { return }
    guard !approvedBundleIds.isEmpty else {
        throw HelperFailure(
            code: "permissionDenied",
            message: "Computer Use \(actionName) is blocked because no apps are approved in Settings > Computer Use."
        )
    }
}

func axStringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
        return nil
    }
    return value as? String
}

func axWindowBounds(_ window: AXUIElement) -> [String: Any]? {
    var positionValue: CFTypeRef?
    var sizeValue: CFTypeRef?
    guard
        AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &positionValue) == .success,
        AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &sizeValue) == .success,
        let rawPosition = positionValue,
        let rawSize = sizeValue,
        CFGetTypeID(rawPosition) == AXValueGetTypeID(),
        CFGetTypeID(rawSize) == AXValueGetTypeID()
    else {
        return nil
    }

    var position = CGPoint.zero
    var size = CGSize.zero
    guard
        AXValueGetValue(rawPosition as! AXValue, .cgPoint, &position),
        AXValueGetValue(rawSize as! AXValue, .cgSize, &size)
    else {
        return nil
    }

    return [
        "x": Double(position.x),
        "y": Double(position.y),
        "width": Double(size.width),
        "height": Double(size.height)
    ]
}

func axWindows(for app: NSRunningApplication) -> [[String: Any]] {
    axWindowElements(for: app)
        .prefix(12)
        .enumerated()
        .map { index, window in
            axWindowSnapshot(window, index: index)
        }
}

func axWindowElements(for app: NSRunningApplication) -> [AXUIElement] {
    guard AXIsProcessTrusted() else {
        return []
    }

    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    var value: CFTypeRef?
    guard
        AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &value) == .success,
        let windows = value as? [AXUIElement]
    else {
        return []
    }

    return windows
}

func axWindowSnapshot(_ window: AXUIElement, index: Int) -> [String: Any] {
    [
        "index": index,
        "title": axStringAttribute(window, kAXTitleAttribute) ?? NSNull(),
        "bounds": axWindowBounds(window) ?? NSNull()
    ]
}

func appDisplayName(_ app: NSRunningApplication) -> String {
    if let localizedName = app.localizedName?.trimmingCharacters(in: .whitespacesAndNewlines),
       !localizedName.isEmpty {
        return localizedName
    }
    if let bundleURL = app.bundleURL {
        return bundleURL.deletingPathExtension().lastPathComponent
    }
    if let bundleIdentifier = app.bundleIdentifier {
        return bundleIdentifier
    }
    return "Process \(app.processIdentifier)"
}

func listApps(input: [String: Any]) throws -> [String: Any] {
    let approvedBundleIds = try approvedAppBundleIdentifierSet(input)
    let apps = NSWorkspace.shared.runningApplications
        .filter { app in
            !app.isTerminated &&
                (app.activationPolicy == .regular || app.isActive) &&
                appIsApproved(app, approvedBundleIds: approvedBundleIds)
        }
        .sorted { left, right in
            if left.isActive != right.isActive {
                return left.isActive
            }
            return appDisplayName(left).localizedCaseInsensitiveCompare(appDisplayName(right)) == .orderedAscending
        }
        .map { app in
            appSnapshot(app)
        }

    var result: [String: Any] = [
        "sessionId": sessionId(input),
        "checkedAt": ISO8601DateFormatter().string(from: Date()),
        "accessibilityTrusted": AXIsProcessTrusted(),
        "apps": apps
    ]
    if approvedBundleIds != nil {
        result["filteredByApprovedApps"] = true
    }
    return result
}

func visibleRunningApps() -> [NSRunningApplication] {
    NSWorkspace.shared.runningApplications
        .filter { app in
            !app.isTerminated && (app.activationPolicy == .regular || app.isActive)
        }
}

func findAppToFocus(input: [String: Any]) throws -> NSRunningApplication {
    let bundleIdentifier = try optionalString(input, "bundleIdentifier")?
        .trimmingCharacters(in: .whitespacesAndNewlines)
    if let bundleIdentifier, !bundleIdentifier.isEmpty {
        if let app = visibleRunningApps().first(where: { $0.bundleIdentifier == bundleIdentifier }) {
            return app
        }
        throw HelperFailure(code: "actionFailed", message: "No running visible app has bundle identifier '\(bundleIdentifier)'.")
    }

    if let processIdentifier = try optionalNumber(input, "processIdentifier") {
        let pid = pid_t(processIdentifier.rounded())
        if let app = visibleRunningApps().first(where: { $0.processIdentifier == pid }) {
            return app
        }
        throw HelperFailure(code: "actionFailed", message: "No running visible app has process identifier \(Int(pid)).")
    }

    let name = try optionalString(input, "name")?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let name, !name.isEmpty {
        let matches = visibleRunningApps().filter { app in
            appDisplayName(app).caseInsensitiveCompare(name) == .orderedSame
        }
        if let app = matches.first, matches.count == 1 {
            return app
        }
        if matches.count > 1 {
            throw HelperFailure(code: "actionFailed", message: "Multiple running apps are named '\(name)'. Use bundleIdentifier or processIdentifier.")
        }
        throw HelperFailure(code: "actionFailed", message: "No running visible app is named '\(name)'.")
    }

    throw HelperFailure(
        code: "actionFailed",
        message: "Provide bundleIdentifier, processIdentifier, or name to focus a running app."
    )
}

func focusApp(input: [String: Any]) throws -> [String: Any] {
    let approvedBundleIds = try approvedAppBundleIdentifierSet(input)
    try requireNonEmptyApprovedApps(approvedBundleIds: approvedBundleIds, actionName: "focus")
    let app = try findAppToFocus(input: input)
    guard appIsApproved(app, approvedBundleIds: approvedBundleIds) else {
        let appName = appDisplayName(app)
        let bundleIdentifier = app.bundleIdentifier ?? "unknown bundle"
        throw HelperFailure(
            code: "permissionDenied",
            message: "Computer Use focus is blocked because the target app '\(appName)' (\(bundleIdentifier)) is not approved in Settings > Computer Use."
        )
    }
    if app.isHidden {
        app.unhide()
    }
    let activated = app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
    guard activated else {
        throw HelperFailure(code: "actionFailed", message: "macOS did not activate \(appDisplayName(app)).")
    }
    var result = actionResult(input, "Focused \(appDisplayName(app)).")
    result["focusedApp"] = appSnapshot(app)
    return result
}

func optionalInteger(_ input: [String: Any], _ key: String) throws -> Int? {
    guard input[key] != nil else { return nil }
    return try integer(input, key, fallback: 0, min: 0, max: 10_000)
}

func findWindowToFocus(app: NSRunningApplication, input: [String: Any]) throws -> (AXUIElement, Int) {
    let windows = axWindowElements(for: app)
    guard !windows.isEmpty else {
        throw HelperFailure(
            code: "actionFailed",
            message: "No windows are available for \(appDisplayName(app))."
        )
    }

    if let requestedIndex = try optionalInteger(input, "windowIndex") {
        guard requestedIndex < windows.count else {
            throw HelperFailure(
                code: "actionFailed",
                message: "Window index \(requestedIndex) is out of range for \(appDisplayName(app))."
            )
        }
        return (windows[requestedIndex], requestedIndex)
    }

    let requestedTitle = try optionalString(input, "windowTitle")?
        .trimmingCharacters(in: .whitespacesAndNewlines)
    if let requestedTitle, !requestedTitle.isEmpty {
        let matches = windows.enumerated().filter { _, window in
            (axStringAttribute(window, kAXTitleAttribute) ?? "")
                .caseInsensitiveCompare(requestedTitle) == .orderedSame
        }
        if let match = matches.first, matches.count == 1 {
            return (match.element, match.offset)
        }
        if matches.count > 1 {
            throw HelperFailure(
                code: "actionFailed",
                message: "Multiple windows are titled '\(requestedTitle)'. Use windowIndex from computer_list_apps."
            )
        }
        throw HelperFailure(
            code: "actionFailed",
            message: "No window titled '\(requestedTitle)' was found for \(appDisplayName(app))."
        )
    }

    return (windows[0], 0)
}

func focusWindow(input: [String: Any]) throws -> [String: Any] {
    let approvedBundleIds = try approvedAppBundleIdentifierSet(input)
    try requireNonEmptyApprovedApps(approvedBundleIds: approvedBundleIds, actionName: "window focus")
    try requireAccessibility()
    let app = try findAppToFocus(input: input)
    guard appIsApproved(app, approvedBundleIds: approvedBundleIds) else {
        let appName = appDisplayName(app)
        let bundleIdentifier = app.bundleIdentifier ?? "unknown bundle"
        throw HelperFailure(
            code: "permissionDenied",
            message: "Computer Use window focus is blocked because the target app '\(appName)' (\(bundleIdentifier)) is not approved in Settings > Computer Use."
        )
    }

    if app.isHidden {
        app.unhide()
    }
    let activated = app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
    guard activated else {
        throw HelperFailure(code: "actionFailed", message: "macOS did not activate \(appDisplayName(app)).")
    }

    let (window, windowIndex) = try findWindowToFocus(app: app, input: input)
    _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    _ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
    _ = AXUIElementSetAttributeValue(window, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    usleep(80_000)

    let title = axStringAttribute(window, kAXTitleAttribute)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
    var result = actionResult(
        input,
        title?.isEmpty == false
            ? "Focused window '\(title!)' in \(appDisplayName(app))."
            : "Focused window \(windowIndex) in \(appDisplayName(app))."
    )
    result["focusedApp"] = appSnapshot(app)
    result["focusedWindow"] = axWindowSnapshot(window, index: windowIndex)
    return result
}

func permissionSubject() -> [String: Any] {
    let displayName =
        Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ??
        Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ??
        ProcessInfo.processInfo.processName
    let subject: [String: Any] = [
        "kind": "helper",
        "displayName": displayName,
        "path": CommandLine.arguments.first ?? NSNull()
    ]
    return subject
}

func permissions() -> [String: Any] {
    let accessibility = AXIsProcessTrusted()
    let screenRecording = CGPreflightScreenCaptureAccess()
    return [
        "platform": "darwin",
        "supported": true,
        "helperAvailable": true,
        "helperPath": CommandLine.arguments.first ?? NSNull(),
        "permissionSubject": permissionSubject(),
        "checkedAt": ISO8601DateFormatter().string(from: Date()),
        "message": NSNull(),
        "permissions": [
            [
                "kind": "accessibility",
                "label": "Accessibility",
                "state": accessibility ? "granted" : "denied",
                "detail": accessibility
                    ? "The ShioriCode Computer Use helper can post keyboard and pointer events."
                    : "Enable Accessibility for the ShioriCode Computer Use helper so it can click, type, scroll, and press keys."
            ],
            [
                "kind": "screen-recording",
                "label": "Screen Recording",
                "state": screenRecording ? "granted" : "denied",
                "detail": screenRecording
                    ? "The ShioriCode Computer Use helper can capture screenshots for Computer Use."
                    : "Enable Screen Recording for the ShioriCode Computer Use helper so it can see the desktop before acting."
            ]
        ]
    ]
}

func screenshot(input: [String: Any]) throws -> [String: Any] {
    try requireScreenRecording()
    try requireApprovedActiveApp(input: input, actionName: "screenshot")
    let displays = activeDisplayIds()
    let virtualBounds = virtualScreenBounds()
    guard !virtualBounds.isNull, virtualBounds.width > 0, virtualBounds.height > 0 else {
        throw HelperFailure(code: "actionFailed", message: "Could not resolve the active macOS display bounds.")
    }
    let backingScale = screenshotBackingScale()
    let outputSize = screenshotPixelSize(virtualBounds: virtualBounds, backingScale: backingScale)
    let width = Int(outputSize.width)
    let height = Int(outputSize.height)
    guard
        let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )
    else {
        throw HelperFailure(code: "actionFailed", message: "Failed to allocate a screenshot buffer.")
    }

    context.setFillColor(NSColor.black.cgColor)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.interpolationQuality = .high

    for display in displays {
        guard let image = CGDisplayCreateImage(display) else { continue }
        let displayBounds = screenshotBounds(
            forDisplayBounds: CGDisplayBounds(display),
            virtualBounds: virtualBounds,
            backingScale: backingScale
        )
        let drawRect = CGRect(
            x: displayBounds.minX,
            y: CGFloat(height) - displayBounds.maxY,
            width: displayBounds.width,
            height: displayBounds.height
        )
        context.draw(image, in: drawRect)
    }

    let cursorPoint = cursorPointInScreenshot(width: CGFloat(width), height: CGFloat(height))
    if let cursorPoint {
        let minimumDimension = min(CGFloat(width), CGFloat(height))
        let scale = max(0.9, min(1.8, minimumDimension / 900))
        drawShioriCursor(
            context: context,
            tip: CGPoint(x: cursorPoint.x, y: CGFloat(height) - cursorPoint.y),
            scale: scale
        )
    }

    guard
        let image = context.makeImage(),
        let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
    else {
        throw HelperFailure(code: "actionFailed", message: "Failed to encode the captured PNG.")
    }

    return [
        "sessionId": sessionId(input),
        "imageDataUrl": "data:image/png;base64,\(png.base64EncodedString())",
        "width": width,
        "height": height,
        "coordinateSpace": "screenshot",
        "screenBounds": rectSnapshot(virtualBounds),
        "displays": displaySnapshots(virtualBounds: virtualBounds, backingScale: backingScale),
        "cursorPosition": cursorPoint.map(pointSnapshot) ?? NSNull(),
        "capturedAt": ISO8601DateFormatter().string(from: Date())
    ]
}

func postMouse(type: CGEventType, point: CGPoint, button: CGMouseButton) {
    CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button)?
        .post(tap: .cghidEventTap)
}

func click(input: [String: Any]) throws -> [String: Any] {
    try requireAccessibility()
    try requireUnlockedScreenForGlobalInput(actionName: "click")
    try requireApprovedActiveApp(input: input, actionName: "click")
    let point = try pointFromInput(input)
    let buttonName = (try optionalString(input, "button", fallback: "left") ?? "left").lowercased()
    let button: CGMouseButton
    switch buttonName {
    case "left":
        button = .left
    case "right":
        button = .right
    default:
        throw HelperFailure(code: "actionFailed", message: "Unsupported mouse button '\(buttonName)'.")
    }
    let downType: CGEventType = button == .right ? .rightMouseDown : .leftMouseDown
    let upType: CGEventType = button == .right ? .rightMouseUp : .leftMouseUp
    let clickCount = try integer(input, "clickCount", fallback: 1, min: 1, max: 3)
    for _ in 0..<clickCount {
        postMouse(type: downType, point: point, button: button)
        usleep(35_000)
        postMouse(type: upType, point: point, button: button)
        usleep(55_000)
    }
    let actionName = button == .right
        ? "Right-clicked"
        : clickCount > 1
            ? "Double-clicked"
            : "Clicked"
    return actionResult(input, "\(actionName) at \(Int(point.x)), \(Int(point.y)).")
}

func move(input: [String: Any]) throws -> [String: Any] {
    try requireAccessibility()
    try requireUnlockedScreenForGlobalInput(actionName: "pointer movement")
    try requireApprovedActiveApp(input: input, actionName: "pointer movement")
    let point = try pointFromInput(input)
    postMouse(type: .mouseMoved, point: point, button: .left)
    return actionResult(input, "Moved pointer to \(Int(point.x)), \(Int(point.y)).")
}

func drag(input: [String: Any]) throws -> [String: Any] {
    try requireAccessibility()
    try requireUnlockedScreenForGlobalInput(actionName: "drag")
    try requireApprovedActiveApp(input: input, actionName: "drag")
    let from = try pointFromInput(input, xKey: "fromX", yKey: "fromY")
    let to = try pointFromInput(input, xKey: "toX", yKey: "toY")
    let durationMs = try integer(input, "durationMs", fallback: 450, min: 50, max: 5_000)
    let steps = max(2, min(240, durationMs / 16))
    let sleepMicros = useconds_t(max(1_000, (durationMs * 1_000) / steps))

    postMouse(type: .mouseMoved, point: from, button: .left)
    usleep(20_000)
    postMouse(type: .leftMouseDown, point: from, button: .left)
    usleep(35_000)

    for step in 1...steps {
        let progress = CGFloat(step) / CGFloat(steps)
        let point = CGPoint(
            x: from.x + ((to.x - from.x) * progress),
            y: from.y + ((to.y - from.y) * progress)
        )
        postMouse(type: .leftMouseDragged, point: point, button: .left)
        usleep(sleepMicros)
    }

    postMouse(type: .leftMouseUp, point: to, button: .left)
    return actionResult(
        input,
        "Dragged from \(Int(from.x)), \(Int(from.y)) to \(Int(to.x)), \(Int(to.y))."
    )
}

func typeText(input: [String: Any]) throws -> [String: Any] {
    try requireAccessibility()
    try requireUnlockedScreenForGlobalInput(actionName: "typing")
    try requireApprovedActiveApp(input: input, actionName: "typing")
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

func flags(from input: [String: Any]) throws -> CGEventFlags {
    guard let modifiers = try optionalStringArray(input, "modifiers") else { return [] }
    var flags = CGEventFlags()
    for modifier in modifiers {
        switch modifier.lowercased() {
        case "command": flags.insert(.maskCommand)
        case "control": flags.insert(.maskControl)
        case "option": flags.insert(.maskAlternate)
        case "shift": flags.insert(.maskShift)
        default:
            throw HelperFailure(code: "actionFailed", message: "Unsupported key modifier '\(modifier)'.")
        }
    }
    return flags
}

func pressKey(input: [String: Any]) throws -> [String: Any] {
    try requireAccessibility()
    try requireUnlockedScreenForGlobalInput(actionName: "key press")
    try requireApprovedActiveApp(input: input, actionName: "key press")
    let rawKey = try string(input, "key").lowercased()
    guard let keyCode = keyCodes[rawKey] else {
        throw HelperFailure(code: "actionFailed", message: "Unsupported key '\(rawKey)'.")
    }
    let eventFlags = try flags(from: input)
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
    try requireUnlockedScreenForGlobalInput(actionName: "scroll")
    try requireApprovedActiveApp(input: input, actionName: "scroll")
    if input["x"] != nil || input["y"] != nil {
        let point = try pointFromInput(input)
        postMouse(type: .mouseMoved, point: point, button: .left)
        usleep(20_000)
    }
    let deltaY = Int32(try integer(input, "deltaY", fallback: 0, min: -10_000, max: 10_000))
    let deltaX = Int32(try integer(input, "deltaX", fallback: 0, min: -10_000, max: 10_000))
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

func waitForDesktop(input: [String: Any]) throws -> [String: Any] {
    try requireApprovedActiveApp(input: input, actionName: "wait")
    let durationMs = try integer(input, "durationMs", fallback: 1_000, min: 50, max: 30_000)
    usleep(useconds_t(durationMs * 1_000))
    return actionResult(input, "Waited \(durationMs)ms.")
}

func permissionKind(_ input: [String: Any]) throws -> String {
    guard let rawKind = try optionalString(input, "kind")?.trimmingCharacters(in: .whitespacesAndNewlines),
          !rawKind.isEmpty
    else {
        throw HelperFailure(
            code: "actionFailed",
            message: "Missing permission kind. Expected 'accessibility' or 'screen-recording'."
        )
    }
    let kind = rawKind.lowercased()
    switch kind {
    case "accessibility", "screen-recording":
        return kind
    default:
        throw HelperFailure(
            code: "actionFailed",
            message: "Unsupported permission kind '\(rawKind)'. Expected 'accessibility' or 'screen-recording'."
        )
    }
}

func permissionPanel(kind: String) -> PermisoPanel {
    kind == "screen-recording" ? .screenRecording : .accessibility
}

func permissionGuideRequest(input: [String: Any]) throws -> PermissionGuideRequest {
    PermissionGuideRequest(
        kind: try permissionKind(input),
        hostAppBundlePath: try optionalString(input, "hostAppBundlePath"),
        hostAppDisplayName: try optionalString(input, "hostAppDisplayName"),
        durationSeconds: min(
            max(try optionalNumber(input, "durationSeconds") ?? defaultPermissionGuideDurationSeconds, 1),
            maximumPermissionGuideDurationSeconds
        )
    )
}

func permissionGuideHostApp(request: PermissionGuideRequest) -> PermisoHostApp {
    let configuredDisplayName = request.hostAppDisplayName?
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard
        let rawBundlePath = request.hostAppBundlePath,
        !rawBundlePath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else {
        return .current()
    }

    let bundleURL = URL(fileURLWithPath: rawBundlePath)
    let displayName = configuredDisplayName?.isEmpty == false
        ? configuredDisplayName!
        : bundleURL.deletingPathExtension().lastPathComponent
    let icon = NSWorkspace.shared.icon(forFile: bundleURL.path)
    icon.size = NSSize(width: 48, height: 48)
    return PermisoHostApp(displayName: displayName, bundleURL: bundleURL, icon: icon)
}

@MainActor
func stopPermissionGuideRunLoop() {
    PermisoAssistant.shared.dismiss()
    NSApp.stop(nil)
    if let event = NSEvent.otherEvent(
        with: .applicationDefined,
        location: .zero,
        modifierFlags: [],
        timestamp: ProcessInfo.processInfo.systemUptime,
        windowNumber: 0,
        context: nil,
        subtype: 0,
        data1: 0,
        data2: 0
    ) {
        NSApp.postEvent(event, atStart: false)
    }
}

@MainActor
final class PermissionGuideTimeout: NSObject {
    @objc
    func fire(_ timer: Timer) {
        stopPermissionGuideRunLoop()
    }
}

@MainActor
func openPermissionGuide(request: PermissionGuideRequest) -> [String: Any] {
    let panel = permissionPanel(kind: request.kind)
    let hostApp = permissionGuideHostApp(request: request)

    NSApplication.shared.setActivationPolicy(.accessory)
    PermisoAssistant.shared.present(panel: panel, hostApp: hostApp)

    let timeout = PermissionGuideTimeout()
    let dismissTimer = Timer(
        timeInterval: request.durationSeconds,
        target: timeout,
        selector: #selector(PermissionGuideTimeout.fire(_:)),
        userInfo: nil,
        repeats: false
    )
    RunLoop.main.add(dismissTimer, forMode: .common)
    NSApp.run()
    withExtendedLifetime(timeout) {}
    dismissTimer.invalidate()

    return [
        "ok": true,
        "kind": request.kind,
        "message": "Opened the macOS permission guide."
    ]
}

func requestPermission(input: [String: Any]) throws -> [String: Any] {
    let kind = try permissionKind(input)
    if kind == "screen-recording" {
        let granted = CGRequestScreenCaptureAccess()
        return [
            "ok": granted,
            "kind": "screen-recording",
            "permissionSubject": permissionSubject(),
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
        "permissionSubject": permissionSubject(),
        "message": granted
            ? "Accessibility permission is enabled."
            : "Accessibility still needs to be enabled in System Settings."
    ]
}

func bcuRuntime() -> BackgroundComputerUseRuntime {
    BackgroundComputerUseRuntime(options: BackgroundComputerUseRuntimeOptions(visualCursor: .disabled))
}

func bcuImageMode(input: [String: Any], fallback: ImageMode = .base64) throws -> ImageMode {
    let raw = (try optionalString(input, "imageMode", fallback: fallback.rawValue) ?? fallback.rawValue)
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()
    switch raw {
    case "base64":
        return .base64
    case "path":
        return .path
    case "omit":
        return .omit
    default:
        throw HelperFailure(code: "actionFailed", message: "Unsupported imageMode '\(raw)'.")
    }
}

func bcuWindowID(runtime: BackgroundComputerUseRuntime, input: [String: Any]) throws -> String {
    if let window = try optionalString(input, "window")?.trimmingCharacters(in: .whitespacesAndNewlines),
       !window.isEmpty {
        return window
    }
    let app = try string(input, "app").trimmingCharacters(in: .whitespacesAndNewlines)
    let windows = try runtime.listWindows(ListWindowsRequest(app: app)).windows
    guard let window = windows.first(where: { $0.isFocused }) ??
        windows.first(where: { $0.isMain }) ??
        windows.first else {
        throw HelperFailure(code: "actionFailed", message: "No targetable window found for app '\(app)'.")
    }
    return window.windowID
}

func bcuActionTarget(input: [String: Any], key: String = "element_index") throws -> ActionTargetRequestDTO {
    let raw = try string(input, key).trimmingCharacters(in: .whitespacesAndNewlines)
    if let displayIndex = Int(raw) {
        return try ActionTargetRequestDTO.displayIndex(displayIndex)
    }
    return try ActionTargetRequestDTO.nodeID(raw)
}

func bcuMouseButton(input: [String: Any]) throws -> MouseButtonDTO? {
    guard let raw = try optionalString(input, "mouse_button")?.trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased(), !raw.isEmpty else {
        return nil
    }
    switch raw {
    case "left":
        return .left
    case "right":
        return .right
    case "middle":
        return .middle
    default:
        throw HelperFailure(code: "actionFailed", message: "Unsupported mouse_button '\(raw)'.")
    }
}

func bcuScrollDirection(input: [String: Any]) throws -> ScrollDirectionDTO {
    let raw = try string(input, "direction").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    switch raw {
    case "up":
        return .up
    case "down":
        return .down
    case "left":
        return .left
    case "right":
        return .right
    default:
        throw HelperFailure(code: "actionFailed", message: "Unsupported scroll direction '\(raw)'.")
    }
}

func bcuOptionalTarget(input: [String: Any]) throws -> ActionTargetRequestDTO? {
    guard let raw = try optionalString(input, "element_index")?.trimmingCharacters(in: .whitespacesAndNewlines),
          !raw.isEmpty else {
        return nil
    }
    if let displayIndex = Int(raw) {
        return try ActionTargetRequestDTO.displayIndex(displayIndex)
    }
    return try ActionTargetRequestDTO.nodeID(raw)
}

/// Runs one bcu-* command against a (possibly shared) runtime and returns the
/// result as a JSON object with the login-session state attached. Used by both
/// the one-shot CLI dispatch and serve mode, so both transports produce
/// identical result shapes.
func bcuCommandResult(
    command: String,
    input: [String: Any],
    runtime: BackgroundComputerUseRuntime
) throws -> [String: Any] {
    func finish<T: Encodable>(_ value: T) throws -> [String: Any] {
        var object = try encodableJSONObject(value)
        object["sessionState"] = loginSessionStateSnapshot()
        return object
    }

    switch command {
    case "bcu-list-apps":
        return try finish(runtime.listApps())
    case "bcu-list-windows":
        return try finish(try runtime.listWindows(ListWindowsRequest(app: try string(input, "app"))))
    case "bcu-get-window-state":
        let window = try bcuWindowID(runtime: runtime, input: input)
        return try finish(try runtime.getWindowState(GetWindowStateRequest(
            window: window,
            maxNodes: try optionalInteger(input, "maxNodes"),
            imageMode: try bcuImageMode(input: input)
        )))
    case "bcu-click":
        let window = try bcuWindowID(runtime: runtime, input: input)
        if let target = try bcuOptionalTarget(input: input) {
            return try finish(try runtime.click(ClickRequest(
                window: window,
                stateToken: try optionalString(input, "stateToken"),
                target: target,
                clickCount: try optionalInteger(input, "click_count"),
                mouseButton: try bcuMouseButton(input: input),
                maxNodes: try optionalInteger(input, "maxNodes"),
                imageMode: try bcuImageMode(input: input, fallback: .omit)
            )))
        }
        return try finish(try runtime.click(ClickRequest(
            window: window,
            stateToken: try optionalString(input, "stateToken"),
            x: try number(input, "x"),
            y: try number(input, "y"),
            clickCount: try optionalInteger(input, "click_count"),
            mouseButton: try bcuMouseButton(input: input),
            maxNodes: try optionalInteger(input, "maxNodes"),
            imageMode: try bcuImageMode(input: input, fallback: .omit)
        )))
    case "bcu-scroll":
        return try finish(try runtime.scroll(ScrollRequest(
            window: try bcuWindowID(runtime: runtime, input: input),
            stateToken: try optionalString(input, "stateToken"),
            target: try bcuActionTarget(input: input),
            direction: try bcuScrollDirection(input: input),
            pages: try optionalInteger(input, "pages"),
            maxNodes: try optionalInteger(input, "maxNodes"),
            imageMode: try bcuImageMode(input: input, fallback: .omit)
        )))
    case "bcu-perform-secondary-action":
        return try finish(try runtime.performSecondaryAction(PerformSecondaryActionRequest(
            window: try bcuWindowID(runtime: runtime, input: input),
            stateToken: try optionalString(input, "stateToken"),
            target: try bcuActionTarget(input: input),
            action: try string(input, "action"),
            maxNodes: try optionalInteger(input, "maxNodes"),
            imageMode: try bcuImageMode(input: input, fallback: .omit)
        )))
    case "bcu-set-value":
        return try finish(try runtime.setValue(SetValueRequest(
            window: try bcuWindowID(runtime: runtime, input: input),
            stateToken: try optionalString(input, "stateToken"),
            target: try bcuActionTarget(input: input),
            value: try string(input, "value"),
            maxNodes: try optionalInteger(input, "maxNodes"),
            imageMode: try bcuImageMode(input: input, fallback: .omit)
        )))
    case "bcu-type-text":
        return try finish(try runtime.typeText(TypeTextRequest(
            window: try bcuWindowID(runtime: runtime, input: input),
            stateToken: try optionalString(input, "stateToken"),
            target: try bcuOptionalTarget(input: input),
            text: try string(input, "text"),
            focusAssistMode: .focusAndCaretEnd,
            maxNodes: try optionalInteger(input, "maxNodes"),
            imageMode: try bcuImageMode(input: input, fallback: .omit)
        )))
    case "bcu-press-key":
        return try finish(try runtime.pressKey(PressKeyRequest(
            window: try bcuWindowID(runtime: runtime, input: input),
            stateToken: try optionalString(input, "stateToken"),
            key: try string(input, "key"),
            maxNodes: try optionalInteger(input, "maxNodes"),
            imageMode: try bcuImageMode(input: input, fallback: .omit)
        )))
    default:
        throw HelperFailure(code: "actionFailed", message: "Unsupported serve command '\(command)'.")
    }
}

/// Long-lived stdio mode: one JSON request per line ({id, command, input}),
/// one JSON response per line ({id, ok, result | code+error}). A single
/// BackgroundComputerUseRuntime is shared across requests, which keeps the
/// Accessibility runtime warm and preserves state-token continuity between
/// get_app_state and subsequent actions — the two main costs of the
/// process-per-action model. Only bcu-* commands and `permissions` are
/// servable; UI-presenting commands (permission-guide) still run one-shot.
func runServeLoop() -> Never {
    // Announce readiness so the client can distinguish a serve-capable helper
    // from an older binary (which would error out or wait for stdin EOF).
    writeJSONLine(["event": "ready", "protocol": "shiori-computer-use-serve/1"])

    var runtime: BackgroundComputerUseRuntime?

    while let line = readLine(strippingNewline: true) {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { continue }
        var requestId: Any = NSNull()
        do {
            guard
                let data = trimmed.data(using: .utf8),
                let request = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            else {
                throw HelperFailure(code: "actionFailed", message: "Serve requests must be JSON objects.")
            }
            requestId = request["id"] ?? NSNull()
            let command = try string(request, "command")
            let input = (request["input"] as? [String: Any]) ?? [:]

            if command == "permissions" {
                writeJSONLine(["id": requestId, "ok": true, "result": permissions()])
                continue
            }

            let activeRuntime: BackgroundComputerUseRuntime
            if let existing = runtime {
                activeRuntime = existing
            } else {
                let created = bcuRuntime()
                runtime = created
                activeRuntime = created
            }
            let result = try bcuCommandResult(command: command, input: input, runtime: activeRuntime)
            writeJSONLine(["id": requestId, "ok": true, "result": result])
        } catch let failure as HelperFailure {
            writeJSONLine(["id": requestId, "ok": false, "code": failure.code, "error": failure.message])
        } catch {
            writeJSONLine(["id": requestId, "ok": false, "code": "actionFailed", "error": String(describing: error)])
        }
    }
    exit(HelperExitCode.ok.rawValue)
}

do {
    let command = CommandLine.arguments.dropFirst().first ?? "permissions"
    if command == "serve" {
        runServeLoop()
    }
    let input = try readInputObject()
    switch command {
    case "permissions":
        writeJSON(permissions())
    case "screenshot":
        writeJSON(try screenshot(input: input))
    case "list-apps":
        writeJSON(try listApps(input: input))
    case "focus-app":
        writeJSON(try focusApp(input: input))
    case "focus-window":
        writeJSON(try focusWindow(input: input))
    case "click":
        writeJSON(try click(input: input))
    case "move":
        writeJSON(try move(input: input))
    case "drag":
        writeJSON(try drag(input: input))
    case "type":
        writeJSON(try typeText(input: input))
    case "key":
        writeJSON(try pressKey(input: input))
    case "scroll":
        writeJSON(try scroll(input: input))
    case "wait":
        writeJSON(try waitForDesktop(input: input))
    case "request-permission":
        writeJSON(try requestPermission(input: input))
    case "permission-guide":
        let request = try permissionGuideRequest(input: input)
        Task { @MainActor in
            writeJSON(openPermissionGuide(request: request))
        }
        dispatchMain()
    case let bcuCommand where bcuCommand.hasPrefix("bcu-"):
        writeJSON(try bcuCommandResult(command: bcuCommand, input: input, runtime: bcuRuntime()))
    default:
        fail("actionFailed", "Unsupported command '\(command)'.")
    }
} catch let error as HelperFailure {
    fail(error.code, error.message)
} catch {
    fail("actionFailed", String(describing: error))
}
