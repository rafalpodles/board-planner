import AppKit
import SwiftUI
import XCTest

// Renders a real SwiftUI view through AppKit, so controls draw as they do on screen (ImageRenderer
// leaves Button, TextField and Picker blank). With CP_SNAPSHOT_DIR set it writes a PNG per
// appearance for the PR; without it the render still has to produce a non-empty image.
@MainActor
enum Snapshot {
    @discardableResult
    static func render<V: View>(
        _ view: V, name: String, width: CGFloat, height: CGFloat? = nil,
        file: StaticString = #filePath, line: UInt = #line
    ) -> [String: NSSize] {
        var sizes: [String: NSSize] = [:]
        for (label, appearance) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
            let host = NSHostingView(
                rootView: view
                    .frame(width: width)
                    .background(Color(nsColor: .windowBackgroundColor))
                    .environment(\.colorScheme, label == "dark" ? .dark : .light))
            let fitted = host.fittingSize
            let size = NSSize(width: width, height: height ?? max(fitted.height, 1))
            host.frame = NSRect(origin: .zero, size: size)
            let window = NSWindow(
                contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
            window.appearance = NSAppearance(named: appearance)
            window.contentView = host
            host.layoutSubtreeIfNeeded()
            guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
                XCTFail("no bitmap for \(name)", file: file, line: line)
                continue
            }
            host.cacheDisplay(in: host.bounds, to: rep)
            sizes[label] = size
            XCTAssertGreaterThan(size.height, 20, "\(name) rendered empty", file: file, line: line)
            guard let dir = ProcessInfo.processInfo.environment["CP_SNAPSHOT_DIR"],
                let png = rep.representation(using: .png, properties: [:])
            else { continue }
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? png.write(to: URL(fileURLWithPath: dir + "/\(name)-\(label).png"))
        }
        return sizes
    }
}
