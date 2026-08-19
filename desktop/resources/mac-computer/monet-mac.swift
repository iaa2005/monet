/*
 * monet-mac — the macOS side of Computer Use, one small CLI.
 *
 * The Windows implementation drives everything through PowerShell (user32,
 * UI Automation, Windows.Media.Ocr) precisely so the app needs no native
 * build step. This is the same bargain on macOS: one Swift file, compiled
 * once on the user's machine by the swiftc that ships with the Xcode
 * Command Line Tools, cached in the app's data dir. No node addon, no
 * prebuilds, nothing to notarize separately in dev.
 *
 * Subcommands (all output on stdout, one JSON document or plain line):
 *   check                      → {"ax":bool,"screen":bool}
 *   cursor                     → "x,y"  (points, global, top-left origin)
 *   move X Y
 *   click X Y [left|right|middle] [single|double]
 *   scroll X Y [up|down] [clicks]
 *   type B64 [expectedApp]     → <<OK>> | <<MISMATCH>>name
 *   key COMBO [expectedApp]    → <<OK>> | <<MISMATCH>>name   e.g. cmd+shift+a
 *   frontmost                  → app name, lower-case
 *   focus B64TITLE             → matched window title | <<NOTFOUND>>
 *   launch B64NAME             → app name | <<NOTFOUND>>
 *   windows                    → [{"app":..,"title":..}]
 *   elements                   → {"title","app","elements":[{n,t,x,y,w,h}],
 *                                 "dialogs":[..],"focused":{..}|null}
 *   ocr PNGPATH                → [{"t","x","y","w","h"}]  (image pixels)
 *
 * Coordinates everywhere are macOS "points" with a top-left origin — the
 * same space Electron's screen API and the app's screenshots use, so unlike
 * Windows there is no DPI conversion at the TS edge.
 */

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import Vision

// ─── util ────────────────────────────────────────────────────────────────

func die(_ msg: String) -> Never {
  FileHandle.standardError.write(("monet-mac: " + msg + "\n").data(using: .utf8)!)
  exit(2)
}

func jsonOut(_ obj: Any) {
  let d = try! JSONSerialization.data(withJSONObject: obj, options: [])
  print(String(data: d, encoding: .utf8)!)
}

func b64decode(_ s: String) -> String {
  guard let d = Data(base64Encoded: s), let t = String(data: d, encoding: .utf8) else {
    die("bad base64 argument")
  }
  return t
}

func usleepMs(_ ms: Int) { usleep(useconds_t(ms * 1000)) }

// ─── permission probes ───────────────────────────────────────────────────

func cmdCheck() {
  let ax = AXIsProcessTrusted()
  // CGPreflightScreenCaptureAccess exists on 10.15+.
  let screen = CGPreflightScreenCaptureAccess()
  jsonOut(["ax": ax, "screen": screen])
}

// ─── mouse ───────────────────────────────────────────────────────────────

func post(_ e: CGEvent?) { e?.post(tap: .cghidEventTap) }

func cmdMove(_ x: Double, _ y: Double) {
  post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
               mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left))
}

func cmdClick(_ x: Double, _ y: Double, _ button: String, _ double: Bool) {
  let p = CGPoint(x: x, y: y)
  let (down, up, btn): (CGEventType, CGEventType, CGMouseButton) =
    button == "right"
      ? (.rightMouseDown, .rightMouseUp, .right)
      : button == "middle"
        ? (.otherMouseDown, .otherMouseUp, .center)
        : (.leftMouseDown, .leftMouseUp, .left)
  cmdMove(x, y)
  usleepMs(40)
  func one(_ clickCount: Int64) {
    let d = CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: p, mouseButton: btn)
    d?.setIntegerValueField(.mouseEventClickState, value: clickCount)
    post(d)
    usleepMs(30)
    let u = CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: p, mouseButton: btn)
    u?.setIntegerValueField(.mouseEventClickState, value: clickCount)
    post(u)
  }
  one(1)
  if double {
    usleepMs(60)
    one(2)
  }
}

func cmdScroll(_ x: Double, _ y: Double, _ direction: String, _ clicks: Int) {
  cmdMove(x, y)
  usleepMs(20)
  let amount = Int32((direction == "up" ? 1 : -1) * clicks * 3)
  post(CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1,
               wheel1: amount, wheel2: 0, wheel3: 0))
}

func cmdCursor() {
  // CGEvent(source:nil) captures the current hardware cursor location.
  let loc = CGEvent(source: nil)?.location ?? .zero
  print("\(Int(loc.x)),\(Int(loc.y))")
}

// ─── foreground guard ────────────────────────────────────────────────────

func frontmostName() -> String {
  NSWorkspace.shared.frontmostApplication?.localizedName?.lowercased() ?? ""
}

/** Same contract as the Windows guard: wait out our own helper flashes, then
 * refuse with <<MISMATCH>> when the app under the cursor is not the one the
 * model last looked at. */
func guardExpected(_ expected: String?) -> Bool {
  guard let want = expected?.lowercased(), !want.isEmpty else { return true }
  let helpers = ["monet-mac", "terminal", "iterm2"]
  var front = ""
  for _ in 0..<6 {
    front = frontmostName()
    if front == want { return true }
    if !helpers.contains(front) { break }
    usleepMs(120)
  }
  if front != want {
    print("<<MISMATCH>>\(front)")
    return false
  }
  return true
}

// ─── keyboard ────────────────────────────────────────────────────────────

// Virtual key codes (kVK_*), US layout for letters — the unicode path below
// is what carries real text, these are only for named keys and shortcuts.
let KEYCODES: [String: CGKeyCode] = [
  "enter": 36, "return": 36, "tab": 48, "space": 49, "delete": 51,
  "backspace": 51, "esc": 53, "escape": 53, "forwarddelete": 117, "del": 117,
  "home": 115, "end": 119, "pageup": 116, "page_up": 116, "pagedown": 121,
  "page_down": 121, "left": 123, "right": 124, "down": 125, "up": 126,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98,
  "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
  "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4, "i": 34,
  "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35, "q": 12,
  "r": 15, "s": 1, "t": 17, "u": 32, "v": 9, "w": 13, "x": 7, "y": 16,
  "z": 6, "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22,
  "7": 26, "8": 28, "9": 25, "-": 27, "=": 24, "[": 33, "]": 30, ";": 41,
  "'": 39, ",": 43, ".": 47, "/": 44, "\\": 42, "`": 50,
]

func modifierFlag(_ name: String) -> CGEventFlags? {
  switch name {
  case "cmd", "meta", "command", "win", "super": return .maskCommand
  case "ctrl", "control": return .maskControl
  case "alt", "option": return .maskAlternate
  case "shift": return .maskShift
  default: return nil
  }
}

func cmdKey(_ combo: String, _ expected: String?) {
  guard guardExpected(expected) else { return }
  var flags: CGEventFlags = []
  var mainKey: CGKeyCode? = nil
  for raw in combo.split(separator: "+") {
    let part = raw.trimmingCharacters(in: .whitespaces).lowercased()
    if let f = modifierFlag(part) {
      flags.insert(f)
    } else if let k = KEYCODES[part] {
      mainKey = k
    } else {
      die("unsupported key: \(part)")
    }
  }
  guard let key = mainKey else {
    // A bare modifier tap (e.g. "cmd") — press and release it alone.
    print("<<OK>>")
    return
  }
  let down = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: true)
  down?.flags = flags
  post(down)
  usleepMs(40)
  let up = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false)
  up?.flags = flags
  post(up)
  print("<<OK>>")
}

func cmdType(_ text: String, _ expected: String?) {
  guard guardExpected(expected) else { return }
  // CGEventKeyboardSetUnicodeString types arbitrary unicode independent of
  // the user's layout — Cyrillic included, which is exactly where synthetic
  // keycodes fall apart. Chunked: the field holds at most 20 UTF-16 units.
  // The string rides the DOWN event only — mirrored onto the UP it inserts
  // nothing and some apps (TextEdit) then drop the whole pair. Verified live:
  // down+up-with-string typed nothing; down-with-string + plain up types.
  let units = Array(text.utf16)
  var i = 0
  while i < units.count {
    let chunk = Array(units[i..<min(i + 16, units.count)])
    let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
    down?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
    post(down)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
    post(up)
    usleepMs(8)
    i += 16
  }
  print("<<OK>>")
}

// ─── apps and windows ────────────────────────────────────────────────────

func cmdFrontmost() { print(frontmostName()) }

struct WindowInfo {
  let app: String
  let title: String
  let pid: pid_t
}

func onScreenWindows() -> [WindowInfo] {
  guard
    let list = CGWindowListCopyWindowInfo(
      [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
  else { return [] }
  var out: [WindowInfo] = []
  for w in list {
    guard (w[kCGWindowLayer as String] as? Int) == 0 else { continue }
    let app = (w[kCGWindowOwnerName as String] as? String) ?? ""
    let title = (w[kCGWindowName as String] as? String) ?? ""
    let pid = (w[kCGWindowOwnerPID as String] as? pid_t) ?? 0
    if app.isEmpty && title.isEmpty { continue }
    out.append(WindowInfo(app: app, title: title, pid: pid))
  }
  return out
}

func cmdWindows() {
  jsonOut(onScreenWindows().map { ["app": $0.app.lowercased(), "title": $0.title] })
}

/**
 * Focus by window title OR by application name.
 *
 * Titles come from CGWindowList's kCGWindowName, which is the ONE field there
 * that needs Screen Recording — without that grant every title is empty, so a
 * title-only match could never succeed and the model was told "no open window
 * contains Word" while Word sat on screen. Owner name needs no permission at
 * all, and "focus Word" naming the app is what a person means anyway.
 *
 * Titles are still tried first: with the grant they distinguish two documents
 * of the same app, which the app name cannot.
 */
func cmdFocus(_ title: String) {
  let want = title.lowercased()
  let windows = onScreenWindows()
  for w in windows where w.title.lowercased().contains(want) {
    if let app = NSRunningApplication(processIdentifier: w.pid) {
      app.activate(options: [.activateIgnoringOtherApps])
      print(w.title.isEmpty ? w.app : w.title)
      return
    }
  }
  for w in windows where w.app.lowercased().contains(want) {
    if let app = NSRunningApplication(processIdentifier: w.pid) {
      app.activate(options: [.activateIgnoringOtherApps])
      print(w.title.isEmpty ? w.app : w.title)
      return
    }
  }
  // Running but with no window on screen (minimised, or an app that opens its
  // window only once activated) — still the app the user asked for.
  for app in NSWorkspace.shared.runningApplications
  where (app.localizedName ?? "").lowercased().contains(want)
    && app.activationPolicy == .regular
  {
    app.activate(options: [.activateIgnoringOtherApps])
    print(app.localizedName ?? want)
    return
  }
  print("<<NOTFOUND>>")
}

func cmdLaunch(_ name: String) {
  let want = name.lowercased()
  let fm = FileManager.default
  var candidates: [String] = []
  for dir in ["/Applications", "/System/Applications",
              NSString(string: "~/Applications").expandingTildeInPath] {
    if let items = try? fm.contentsOfDirectory(atPath: dir) {
      for it in items where it.hasSuffix(".app") {
        candidates.append(dir + "/" + it)
      }
    }
  }
  let named = candidates.map { path -> (String, String) in
    let base = (path as NSString).lastPathComponent.replacingOccurrences(of: ".app", with: "")
    return (base, path)
  }
  let hit = named.first { $0.0.lowercased() == want }
    ?? named.filter { $0.0.lowercased().contains(want) }
      .sorted { $0.0.count < $1.0.count }.first
  guard let (base, path) = hit else {
    print("<<NOTFOUND>>")
    return
  }
  NSWorkspace.shared.openApplication(
    at: URL(fileURLWithPath: path),
    configuration: NSWorkspace.OpenConfiguration()
  ) { _, _ in }
  // openApplication is async; give LaunchServices a beat before exiting.
  usleepMs(400)
  print(base)
}

// ─── accessibility tree ──────────────────────────────────────────────────

func axAttr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success else {
    return nil
  }
  return value
}

func axString(_ el: AXUIElement, _ name: String) -> String {
  (axAttr(el, name) as? String) ?? ""
}

func axFrame(_ el: AXUIElement) -> CGRect? {
  guard let posRef = axAttr(el, kAXPositionAttribute),
        let sizeRef = axAttr(el, kAXSizeAttribute)
  else { return nil }
  var p = CGPoint.zero
  var s = CGSize.zero
  guard AXValueGetValue(posRef as! AXValue, .cgPoint, &p),
        AXValueGetValue(sizeRef as! AXValue, .cgSize, &s)
  else { return nil }
  return CGRect(origin: p, size: s)
}

/** AX roles → the type names the ranker on the TS side already understands
 * (they came from Windows UIA; keeping them saves re-teaching the model). */
let ROLE_MAP: [String: String] = [
  "AXButton": "Button", "AXTextField": "Edit", "AXTextArea": "Edit",
  "AXSearchField": "Edit", "AXCheckBox": "CheckBox", "AXRadioButton": "RadioButton",
  "AXPopUpButton": "ComboBox", "AXComboBox": "ComboBox", "AXLink": "Hyperlink",
  "AXMenuItem": "MenuItem", "AXMenuBarItem": "MenuItem", "AXTabGroup": "TabItem",
  "AXRow": "ListItem", "AXCell": "DataItem", "AXStaticText": "Text",
  "AXSlider": "Slider", "AXWebArea": "Document", "AXTextEntryArea": "Edit",
  "AXDisclosureTriangle": "Button", "AXIncrementor": "Button",
]

struct AxEl {
  let n: String
  let t: String
  let f: CGRect
}

func walkAx(_ el: AXUIElement, depth: Int, into out: inout [AxEl], budget: inout Int) {
  if depth > 12 || budget <= 0 { return }
  budget -= 1
  let role = axString(el, kAXRoleAttribute)
  if let mapped = ROLE_MAP[role], mapped != "Text" {
    if let f = axFrame(el), f.width >= 2, f.height >= 2 {
      var name = axString(el, kAXTitleAttribute)
      if name.isEmpty { name = axString(el, kAXDescriptionAttribute) }
      if name.isEmpty { name = (axAttr(el, kAXValueAttribute) as? String) ?? "" }
      if name.isEmpty { name = axString(el, "AXPlaceholderValue") }
      if !name.isEmpty || mapped == "Edit" {
        out.append(AxEl(n: String(name.prefix(80)), t: mapped, f: f))
      }
    }
  }
  guard let kids = axAttr(el, kAXChildrenAttribute) as? [AXUIElement] else { return }
  for kid in kids {
    walkAx(kid, depth: depth + 1, into: &out, budget: &budget)
    if budget <= 0 { return }
  }
}

func elDict(_ e: AxEl) -> [String: Any] {
  [
    "n": e.n, "t": e.t,
    "x": Int(e.f.origin.x), "y": Int(e.f.origin.y),
    "w": Int(e.f.width), "h": Int(e.f.height),
  ]
}

func cmdElements() {
  guard AXIsProcessTrusted() else {
    jsonOut(["error": "accessibility-not-granted"])
    return
  }
  guard let app = NSWorkspace.shared.frontmostApplication else {
    jsonOut(["error": "no frontmost application"])
    return
  }
  let axApp = AXUIElementCreateApplication(app.processIdentifier)
  var windows = (axAttr(axApp, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  if windows.isEmpty, let focused = axAttr(axApp, kAXFocusedWindowAttribute) {
    windows = [focused as! AXUIElement]
  }
  var main: [AxEl] = []
  var dialogEls: [AxEl] = []
  var dialogs: [String] = []
  var title = ""
  for w in windows {
    let wTitle = axString(w, kAXTitleAttribute)
    let subrole = axString(w, kAXSubroleAttribute)
    let isDialog = subrole == "AXDialog" || subrole == "AXSheet" ||
      axString(w, kAXRoleAttribute) == "AXSheet"
    var budget = 3000
    var acc: [AxEl] = []
    walkAx(w, depth: 0, into: &acc, budget: &budget)
    if isDialog {
      dialogs.append(wTitle.isEmpty ? "(dialog)" : wTitle)
      dialogEls.append(contentsOf: acc)
    } else {
      if title.isEmpty { title = wTitle }
      main.append(contentsOf: acc)
    }
    // A save/confirm SHEET is a child of its window, not a window itself —
    // kAXWindowsAttribute never lists it. While one is open its buttons are
    // the only clicks that do anything, so surface it as a dialog too (the
    // TS side de-duplicates the copies the main walk collected).
    if let kids = axAttr(w, kAXChildrenAttribute) as? [AXUIElement] {
      for kid in kids where axString(kid, kAXRoleAttribute) == "AXSheet" {
        var sheetBudget = 1500
        var sheetAcc: [AxEl] = []
        walkAx(kid, depth: 0, into: &sheetAcc, budget: &sheetBudget)
        let sTitle = axString(kid, kAXTitleAttribute)
        dialogs.append(sTitle.isEmpty ? "(dialog)" : sTitle)
        dialogEls.append(contentsOf: sheetAcc)
      }
    }
  }
  var focusedDict: [String: Any]? = nil
  if let f = axAttr(axApp, kAXFocusedUIElementAttribute) {
    let fe = f as! AXUIElement
    if let fr = axFrame(fe) {
      let role = axString(fe, kAXRoleAttribute)
      focusedDict = elDict(AxEl(
        n: String(axString(fe, kAXTitleAttribute).prefix(80)),
        t: ROLE_MAP[role] ?? role, f: fr))
    }
  }
  jsonOut([
    "title": title,
    "app": app.localizedName?.lowercased() ?? "",
    "elements": main.map(elDict),
    "dialogEls": dialogEls.map(elDict),
    "dialogs": dialogs,
    "focused": focusedDict as Any,
  ])
}

// ─── OCR (Vision) ────────────────────────────────────────────────────────

func cmdOcr(_ path: String) {
  guard let img = NSImage(contentsOfFile: path),
        let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil)
  else { die("cannot read image: \(path)") }
  let W = CGFloat(cg.width)
  let H = CGFloat(cg.height)
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  // Russian + English covers this app's user base; Vision quietly ignores
  // languages the OS build does not support.
  request.recognitionLanguages = ["ru-RU", "en-US"]
  let handler = VNImageRequestHandler(cgImage: cg, options: [:])
  do { try handler.perform([request]) } catch { die("vision: \(error)") }
  var lines: [[String: Any]] = []
  for obs in request.results ?? [] {
    guard let top = obs.topCandidates(1).first else { continue }
    // Vision's box is normalized, origin bottom-left → image pixels, top-left.
    let b = obs.boundingBox
    lines.append([
      "t": top.string,
      "x": Int(b.origin.x * W),
      "y": Int((1 - b.origin.y - b.height) * H),
      "w": Int(b.width * W),
      "h": Int(b.height * H),
    ])
  }
  jsonOut(lines)
}

// ─── dispatch ────────────────────────────────────────────────────────────

let args = CommandLine.arguments
guard args.count >= 2 else { die("no subcommand") }

switch args[1] {
case "check": cmdCheck()
case "cursor": cmdCursor()
case "move":
  guard args.count >= 4, let x = Double(args[2]), let y = Double(args[3]) else { die("move X Y") }
  cmdMove(x, y)
case "click":
  guard args.count >= 4, let x = Double(args[2]), let y = Double(args[3]) else { die("click X Y") }
  let button = args.count >= 5 ? args[4] : "left"
  let double = args.count >= 6 && args[5] == "double"
  cmdClick(x, y, button, double)
case "scroll":
  guard args.count >= 5, let x = Double(args[2]), let y = Double(args[3]) else { die("scroll X Y DIR") }
  cmdScroll(x, y, args[4], args.count >= 6 ? Int(args[5]) ?? 3 : 3)
case "type":
  guard args.count >= 3 else { die("type B64 [expectedApp]") }
  cmdType(b64decode(args[2]), args.count >= 4 ? args[3] : nil)
case "key":
  guard args.count >= 3 else { die("key COMBO [expectedApp]") }
  cmdKey(args[2], args.count >= 4 ? args[3] : nil)
case "frontmost": cmdFrontmost()
case "focus":
  guard args.count >= 3 else { die("focus B64TITLE") }
  cmdFocus(b64decode(args[2]))
case "launch":
  guard args.count >= 3 else { die("launch B64NAME") }
  cmdLaunch(b64decode(args[2]))
case "windows": cmdWindows()
case "elements": cmdElements()
case "ocr":
  guard args.count >= 3 else { die("ocr PNGPATH") }
  cmdOcr(args[2])
default: die("unknown subcommand: \(args[1])")
}

