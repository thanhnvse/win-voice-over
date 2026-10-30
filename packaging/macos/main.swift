// The executable inside win-voice-over.app: a menu bar app that runs the VieNeu-TTS server
// behind the extension's VieNeu engine. Launching it starts the server; its one menu item,
// Stop VieNeu, stops the server and quits.
//
// VieNeuDir and VieNeuPython come from Info.plist, written by scripts/build_macos_app.py.
// `win-voice-over --render-icon DIR` writes the icon as an .iconset for that script.

import AppKit

// The extension always uses 8000; tests run a second copy with `open --env VIENEU_PORT=…`.
let port = Int(ProcessInfo.processInfo.environment["VIENEU_PORT"] ?? "") ?? 8000
let healthURL = URL(string: "http://127.0.0.1:\(port)/health")!
let logURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Logs/win-voice-over.log")
// Time the server gets to shut down after SIGTERM before it is killed.
let stopGraceSeconds = 5.0

// MARK: - Icon

enum Icon {
    static let blue = NSColor(srgbRed: 37 / 255, green: 99 / 255, blue: 235 / 255, alpha: 1)

    /// A white "W" on a blue rounded square, with a small "vo" at the W's lower right.
    static func draw(in rect: NSRect) {
        let side = rect.width
        blue.setFill()
        NSBezierPath(roundedRect: rect, xRadius: side * 0.22, yRadius: side * 0.22).fill()

        let w = line("W", size: side * 0.62, weight: .heavy)
        let vo = line("vo", size: side * 0.3, weight: .bold)
        let wInk = CTLineGetBoundsWithOptions(w, .useGlyphPathBounds)
        let voInk = CTLineGetBoundsWithOptions(vo, .useGlyphPathBounds)
        // "vo" tucks under the W's right arm, so the pair is narrower than side by side.
        let overlap = wInk.width * 0.16
        let width = wInk.width + voInk.width - overlap
        let wX = rect.minX + (side - width) / 2
        let wY = rect.minY + (side - wInk.height) / 2 + side * 0.06
        let voX = wX + wInk.width - overlap
        let voY = wY - side * 0.06

        guard let context = NSGraphicsContext.current?.cgContext else { return }
        context.textPosition = CGPoint(x: wX - wInk.minX, y: wY - wInk.minY)
        CTLineDraw(w, context)
        context.textPosition = CGPoint(x: voX - voInk.minX, y: voY - voInk.minY)
        CTLineDraw(vo, context)
    }

    static func line(_ text: String, size: CGFloat, weight: NSFont.Weight) -> CTLine {
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: size, weight: weight),
            .foregroundColor: NSColor.white,
        ]
        return CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes))
    }

    static func menuBarImage() -> NSImage {
        NSImage(size: NSSize(width: 18, height: 18), flipped: false) { rect in
            draw(in: rect)
            return true
        }
    }

    /// Writes DIR/icon_NxN[@2x].png for iconutil. Apple's icon grid leaves a margin around
    /// the artwork, so it fills 80% of each image, as win-translate's does.
    static func renderIconset(to directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for size in [16, 32, 128, 256, 512] {
            for scale in [1, 2] {
                let pixels = size * scale
                guard let bitmap = NSBitmapImageRep(
                    bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8,
                    samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                    bytesPerRow: 0, bitsPerPixel: 0)
                else { throw IconError.bitmap(pixels) }
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
                let artwork = (CGFloat(pixels) * 0.8).rounded()
                let offset = (CGFloat(pixels) - artwork) / 2
                draw(in: NSRect(x: offset, y: offset, width: artwork, height: artwork))
                NSGraphicsContext.restoreGraphicsState()
                guard let png = bitmap.representation(using: .png, properties: [:])
                else { throw IconError.bitmap(pixels) }
                let name = "icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png"
                try png.write(to: directory.appendingPathComponent(name))
            }
        }
    }

    enum IconError: Error { case bitmap(Int) }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    /// The server this app started.
    private var server: Process?
    /// A VieNeu server that was already running when the app launched.
    private var adoptedPID: pid_t?
    private var quitting = false
    private var readyTimer: Timer?
    private var signalSources: [DispatchSourceSignal] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = Icon.menuBarImage()
        let menu = NSMenu()
        let stop = NSMenuItem(title: "Stop VieNeu", action: #selector(stopVieneu), keyEquivalent: "q")
        stop.target = self
        menu.addItem(stop)
        statusItem.menu = menu
        showStarting(since: Date())
        quitOnSignals()

        checkHealth { ready in
            if ready {
                self.adoptedPID = Self.vieneuListener()
                self.showReady()
            } else {
                self.startServer()
                self.waitUntilReady()
            }
        }
    }

    @objc private func stopVieneu() {
        NSApp.terminate(nil)
    }

    // Quit from the menu, Activity Monitor or logout all come here: stop the server first.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if quitting { return .terminateNow }
        quitting = true
        readyTimer?.invalidate()
        if let server, server.isRunning {
            statusItem.button?.toolTip = "Stopping VieNeu…"
            server.terminate()  // SIGTERM; serverExited() then lets the app quit
            DispatchQueue.main.asyncAfter(deadline: .now() + stopGraceSeconds) {
                if server.isRunning { kill(server.processIdentifier, SIGKILL) }
            }
            return .terminateLater
        }
        if let pid = adoptedPID {
            statusItem.button?.toolTip = "Stopping VieNeu…"
            kill(pid, SIGTERM)
            waitForExit(of: pid, started: Date())
            return .terminateLater
        }
        return .terminateNow
    }

    private func waitForExit(of pid: pid_t, started: Date) {
        if kill(pid, 0) != 0 {  // gone
            NSApp.reply(toApplicationShouldTerminate: true)
            return
        }
        if Date().timeIntervalSince(started) > stopGraceSeconds { kill(pid, SIGKILL) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.waitForExit(of: pid, started: started) }
    }

    private func startServer() {
        let info = Bundle.main.infoDictionary ?? [:]
        guard let directory = info["VieNeuDir"] as? String, let python = info["VieNeuPython"] as? String else {
            fail("This build has no VieNeu-TTS path. Rebuild it with scripts/build_macos_app.py.")
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: python)
        process.arguments = ["-m", "apps.openai_speech"]
        process.currentDirectoryURL = URL(fileURLWithPath: directory)
        var environment = ProcessInfo.processInfo.environment
        // Loopback only, whatever the environment says: the API has no key.
        environment["HOST"] = "127.0.0.1"
        environment["PORT"] = String(port)
        process.environment = environment
        process.terminationHandler = { finished in
            DispatchQueue.main.async { self.serverExited(finished) }
        }
        do {
            let log = try openLog()
            process.standardOutput = log
            process.standardError = log
            try process.run()
            server = process
        } catch {
            fail("Could not start VieNeu: \(error.localizedDescription)")
        }
    }

    private func serverExited(_ process: Process) {
        if quitting {
            NSApp.reply(toApplicationShouldTerminate: true)
            return
        }
        fail("VieNeu stopped by itself (exit code \(process.terminationStatus)). "
            + "See ~/Library/Logs/win-voice-over.log.")
    }

    private func openLog() throws -> FileHandle {
        let files = FileManager.default
        try files.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !files.fileExists(atPath: logURL.path) { files.createFile(atPath: logURL.path, contents: nil) }
        let handle = try FileHandle(forWritingTo: logURL)
        try handle.seekToEnd()
        return handle
    }

    // The model loads before the server opens its port: about 10 s, minutes on the first run.
    private func waitUntilReady() {
        let started = Date()
        readyTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] timer in
            guard let self else { return }
            self.checkHealth { ready in
                guard timer.isValid else { return }
                if ready {
                    timer.invalidate()
                    self.showReady()
                } else {
                    self.showStarting(since: started)
                }
            }
        }
    }

    private func checkHealth(_ done: @escaping (Bool) -> Void) {
        let request = URLRequest(url: healthURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 1.5)
        URLSession.shared.dataTask(with: request) { _, response, _ in
            // Refused or timed out both mean the same here: not ready to speak yet.
            let ready = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { done(ready) }
        }.resume()
    }

    private func showStarting(since started: Date) {
        statusItem.button?.appearsDisabled = true
        statusItem.button?.toolTip = "VieNeu is starting… \(Int(Date().timeIntervalSince(started))) s"
    }

    private func showReady() {
        statusItem.button?.appearsDisabled = false
        statusItem.button?.toolTip = "VieNeu running on 127.0.0.1:\(port)"
    }

    private func fail(_ message: String) {
        quitting = true
        readyTimer?.invalidate()
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "win-voice-over"
        alert.informativeText = message
        alert.runModal()
        NSApp.terminate(nil)
    }

    private func quitOnSignals() {
        for number in [SIGTERM, SIGINT, SIGHUP] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            // Not terminate() right here: this handler is a main-queue block, and terminate()
            // would wait inside it for serverExited(), another main-queue block that cannot
            // run until this one returns. From the run loop, it is like quitting from the menu.
            source.setEventHandler {
                NSApp.perform(#selector(NSApplication.terminate(_:)), with: nil, afterDelay: 0)
            }
            source.resume()
            signalSources.append(source)
        }
    }

    /// The VieNeu server listening on the port, if the listener is one.
    static func vieneuListener() -> pid_t? {
        let listeners = output("/usr/sbin/lsof", ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-t"])
        guard let pid = listeners.split(separator: "\n").first.flatMap({ pid_t($0) }) else { return nil }
        let command = output("/bin/ps", ["-o", "command=", "-p", String(pid)])
        return command.contains("apps.openai_speech") ? pid : nil
    }

    static func output(_ tool: String, _ arguments: [String]) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            NSLog("win-voice-over: could not run \(tool): \(error)")
            return ""
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(decoding: data, as: UTF8.self)
    }
}

// MARK: - Entry point

let arguments = CommandLine.arguments
if arguments.count == 3, arguments[1] == "--render-icon" {
    do {
        try Icon.renderIconset(to: URL(fileURLWithPath: arguments[2]))
        exit(0)
    } catch {
        FileHandle.standardError.write("could not render the icon: \(error)\n".data(using: .utf8)!)
        exit(1)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
