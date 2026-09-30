import Foundation
import CoreGraphics
import AppKit

func output(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value), let text = String(data: data, encoding: .utf8) {
        print(text); fflush(stdout)
    }
}
// Preflight only. Permission is granted by the user in System Settings.
guard CGPreflightListenEventAccess() else {
    output(["type": "unavailable", "reason": "需要在系统设置中授予输入监控权限"]); exit(2)
}
func pointerPID(_ point: CGPoint) -> Int32? {
    guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    for window in windows {
        guard let bounds = window[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary), rect.contains(point),
              let pid = window[kCGWindowOwnerPID as String] as? Int32,
              (window[kCGWindowAlpha as String] as? Double ?? 1) > 0 else { continue }
        return pid
    }
    return nil
}
let events: [CGEventType] = [.keyDown, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown, .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel]
let mask = events.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
var lastMove: CFAbsoluteTime = 0
var dragPID: Int32?
let callback: CGEventTapCallBack = { _, type, event, _ in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        output(["type": "unavailable", "reason": "输入监控被系统停用"])
    } else if event.getIntegerValueField(.eventSourceUnixProcessID) == 0 {
        let moving = type == .mouseMoved
        let now = CFAbsoluteTimeGetCurrent()
        // Never discard a key/click just because a mouse move preceded it.
        if moving && now - lastMove < 0.05 { return Unmanaged.passUnretained(event) }
        if moving { lastMove = now }
        let key = type == .keyDown || type == .flagsChanged
        let dragging = type == .leftMouseDragged || type == .rightMouseDragged || type == .otherMouseDragged
        let pid = moving ? nil : key ? NSWorkspace.shared.frontmostApplication?.processIdentifier : dragging ? dragPID : pointerPID(event.location)
        if type == .leftMouseDown || type == .rightMouseDown || type == .otherMouseDown { dragPID = pid }
        var value: [String: Any] = ["type": "human", "kind": moving ? "move" : key ? "key" : "pointer"]
        if let pid = pid, pid > 0 { value["pid"] = pid }
        output(value)
    }
    return Unmanaged.passUnretained(event)
}
guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask, callback: callback, userInfo: nil) else {
    output(["type": "unavailable", "reason": "无法建立系统输入监控"]); exit(2)
}
let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
output(["type": "ready"])
CFRunLoopRun()
