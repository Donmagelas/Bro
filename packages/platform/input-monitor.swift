import Foundation
import CoreGraphics

func output(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value), let text = String(data: data, encoding: .utf8) {
        print(text); fflush(stdout)
    }
}
// Preflight only. Permission is granted by the user in System Settings.
guard CGPreflightListenEventAccess() else {
    output(["type": "unavailable", "reason": "需要在系统设置中授予输入监控权限"]); exit(2)
}
let events: [CGEventType] = [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .mouseMoved, .leftMouseDragged, .rightMouseDragged, .scrollWheel]
let mask = events.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
var last: CFAbsoluteTime = 0
let callback: CGEventTapCallBack = { _, type, event, _ in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        output(["type": "unavailable", "reason": "输入监控被系统停用"])
    } else if event.getIntegerValueField(.eventSourceUnixProcessID) == 0 {
        let now = CFAbsoluteTimeGetCurrent()
        if now - last > 0.05 { last = now; output(["type": "human", "at": Date().timeIntervalSince1970]) }
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
