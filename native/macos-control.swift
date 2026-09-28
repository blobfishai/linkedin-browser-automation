// Optional macOS accessibility controller. The main outreach CLI uses Playwright.
import AppKit
import ApplicationServices
import Foundation

func fail(_ message: String) -> NSError { NSError(domain: message, code: 1) }
let args = CommandLine.arguments
if args.contains("--help") || args.count != 3 {
    print("Usage: swift native/macos-control.swift CHROME_PID EXACT_PAGE_URL")
    print("Accepts JSON lines: snapshot, press, scroll, type. Commands select a unique role and title.")
    exit(args.contains("--help") ? 0 : 1)
}
guard let pid = Int32(args[1]), pid > 0, let expectedURL = URL(string: args[2]), expectedURL.scheme == "https" else {
    throw fail("Provide a positive Chrome PID and an HTTPS page URL")
}
guard NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == "com.google.Chrome" else {
    throw fail("The supplied PID does not identify Google Chrome")
}
guard AXIsProcessTrusted() else {
    throw fail("Allow Accessibility access for the terminal running this script in macOS Privacy & Security")
}
let app = AXUIElementCreateApplication(pid)

func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, key as CFString, &value)
    return result == .success ? value : nil
}
func text(_ element: AXUIElement, _ key: String) -> String {
    attribute(element, key).map { String(describing: $0) } ?? ""
}
func children(_ element: AXUIElement) -> [AXUIElement] {
    attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
}
func find(_ element: AXUIElement, _ predicate: (AXUIElement) -> Bool, _ depth: Int = 0) -> [AXUIElement] {
    if depth > 40 { return [] }
    var found = predicate(element) ? [element] : []
    for child in children(element) { found += find(child, predicate, depth + 1) }
    return found
}
func root() throws -> AXUIElement {
    guard let value = attribute(app, kAXFocusedWindowAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() else {
        throw fail("No focused Chrome window")
    }
    let window = unsafeBitCast(value, to: AXUIElement.self)
    let roots = find(window, { text($0, kAXRoleAttribute) == "AXWebArea" && text($0, "AXURL") == expectedURL.absoluteString })
    guard roots.count == 1 else { throw fail("The focused window must contain exactly one matching page") }
    return roots[0]
}
func control(_ root: AXUIElement, _ request: [String: Any]) throws -> AXUIElement {
    guard let role = request["role"] as? String, let title = request["title"] as? String else {
        throw fail("Provide role and title from a current snapshot")
    }
    let matches = find(root, { text($0, kAXRoleAttribute) == role && text($0, kAXTitleAttribute) == title })
    guard matches.count == 1 else { throw fail("Control is missing or ambiguous: " + title) }
    return matches[0]
}
func snapshot(_ element: AXUIElement, _ path: [Int], _ rows: inout [[String: Any]]) {
    if path.count > 40 || rows.count >= 10000 { return }
    let role = text(element, kAXRoleAttribute)
    if ["AXLink", "AXStaticText", "AXButton", "AXHeading", "AXTextField", "AXTextArea", "AXWebArea", "AXScrollBar"].contains(role) {
        rows.append(["path": path, "role": role, "title": text(element, kAXTitleAttribute), "value": text(element, kAXValueAttribute), "url": text(element, "AXURL")])
    }
    for (index, child) in children(element).enumerated() { snapshot(child, path + [index], &rows) }
}
func handle(_ request: [String: Any]) throws -> [String: Any] {
    let page = try root()
    guard let command = request["command"] as? String else { throw fail("Missing command") }
    if command == "snapshot" {
        var rows: [[String: Any]] = []
        snapshot(page, [], &rows)
        return ["rows": rows, "truncated": rows.count >= 10000]
    }
    guard ["press", "scroll", "type"].contains(command) else { throw fail("Unknown command") }
    let element = try control(page, request)
    if command == "press" || command == "scroll" {
        let action = command == "press" ? kAXPressAction : "AXScrollToVisible"
        let result = AXUIElementPerformAction(element, action as CFString)
        guard result == .success else { throw fail("Accessibility action failed: " + String(result.rawValue)) }
    } else {
        guard let value = request["text"] as? String, !value.contains("\n"), !value.contains("\r") else {
            throw fail("Provide text without Return characters; type never submits a message")
        }
        guard ["AXTextArea", "AXTextField"].contains(text(element, kAXRoleAttribute)) else { throw fail("Control is not a text field") }
        guard text(element, kAXValueAttribute).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw fail("The text field already contains a draft") }
        NSRunningApplication(processIdentifier: pid)?.activate(options: [])
        let focused = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        guard focused == .success else { throw fail("Could not focus the selected text field") }
        let utf16 = Array(value.utf16)
        var offset = 0
        while offset < utf16.count {
            var end = min(utf16.count, offset + 16)
            if end < utf16.count && (0xD800...0xDBFF).contains(utf16[end - 1]) { end -= 1 }
            let chunk = Array(utf16[offset..<end])
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { throw fail("Could not create keyboard events") }
            chunk.withUnsafeBufferPointer { down.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress!) }
            down.postToPid(pid)
            up.postToPid(pid)
            offset = end
        }
    }
    return ["ok": true, "command": command]
}
func emit(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
    fflush(stdout)
}
emit(["ready": true, "pid": pid, "url": expectedURL.absoluteString])
while let line = readLine() {
    do {
        guard let request = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { throw fail("Expected a JSON object") }
        emit(try handle(request))
    } catch { emit(["error": String(describing: error)]) }
}
