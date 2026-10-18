import AppKit
import XCTest
@testable import CPMenubar
@testable import CPMenubarCore

@MainActor
final class MenuBarGlyphTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    private func glyph(stage phase: String? = nil, health: Health? = nil) -> IconGlyph {
        var state = WorkerState()
        if let phase { state.apply(.progress(Progress(phase: phase, taskKey: "BP-1")), at: t0) }
        if let health { state.forceHealth(health) }
        return state.iconGlyph(now: t0)
    }

    private func bitmap(_ image: NSImage) -> NSBitmapImageRep {
        let width = 280, height = 220
        let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
            samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
            bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        image.draw(in: NSRect(x: 0, y: 0, width: width, height: height))
        NSGraphicsContext.restoreGraphicsState()
        return rep
    }

    // Alpha at a point given in the logo's own coordinates
    private func alpha(_ rep: NSBitmapImageRep, x: CGFloat, y: CGFloat) -> CGFloat {
        let px = Int((x - 3) / 28 * CGFloat(rep.pixelsWide))
        let py = Int((y - 4) / 22 * CGFloat(rep.pixelsHigh))
        return rep.colorAt(x: px, y: py)?.alphaComponent ?? -1
    }

    private func card(_ index: Int) -> (x: CGFloat, y: CGFloat) {
        (Brand.cards[index].x + 3, Brand.cards[index].y + 2)
    }

    func testItIsATemplateSoTheSystemTintsItForTheMenuBar() {
        XCTAssertTrue(MenuBarGlyph.image(glyph()).isTemplate)
    }

    func testStageThreeLightsThreeCardsAndDimsTheRest() {
        let rep = bitmap(MenuBarGlyph.image(glyph(stage: "gates"), breath: 0))

        for lit in 0..<3 {
            XCTAssertEqual(alpha(rep, x: card(lit).x, y: card(lit).y), 1, accuracy: 0.05, "card \(lit)")
        }
        for dim in 4..<6 {
            XCTAssertEqual(alpha(rep, x: card(dim).x, y: card(dim).y), 0.25, accuracy: 0.05, "card \(dim)")
        }
    }

    func testTheActiveCardBreathesBetweenDimAndLit() {
        let stage = glyph(stage: "gates")
        let dim = bitmap(MenuBarGlyph.image(stage, breath: 0))
        let lit = bitmap(MenuBarGlyph.image(stage, breath: 1))
        let breathing = card(3)

        XCTAssertEqual(alpha(dim, x: breathing.x, y: breathing.y), 0.25, accuracy: 0.05)
        XCTAssertEqual(alpha(lit, x: breathing.x, y: breathing.y), 1, accuracy: 0.05)
    }

    func testTheBadgeIsDrawnWhereTheCardsLeaveRoomForIt() {
        let none = bitmap(MenuBarGlyph.image(glyph()))
        let attention = bitmap(MenuBarGlyph.image(glyph(health: .needsHuman)))
        let fault = bitmap(MenuBarGlyph.image(glyph(health: .faulted)))
        let offline = bitmap(MenuBarGlyph.image(glyph(health: .disconnected)))

        XCTAssertEqual(alpha(none, x: 26, y: 21), 0, accuracy: 0.05)
        XCTAssertEqual(alpha(attention, x: 26, y: 21), 1, accuracy: 0.05)
        XCTAssertEqual(alpha(fault, x: 26, y: 21), 1, accuracy: 0.05)
        // A ring: empty in the middle, solid on its edge
        XCTAssertEqual(alpha(offline, x: 26, y: 21), 0, accuracy: 0.05)
        XCTAssertGreaterThan(alpha(offline, x: 28.8, y: 21), 0.8)
    }

    // Dot and triangle both fill the badge's centre; these two points tell them apart
    func testTheDotAndTheTriangleAreNotTheSameShape() {
        let attention = bitmap(MenuBarGlyph.image(glyph(health: .needsHuman)))
        let fault = bitmap(MenuBarGlyph.image(glyph(health: .faulted)))

        // Level with the centre and 3 left of it: inside the circle, outside the triangle's slanted edge
        XCTAssertGreaterThan(alpha(attention, x: 22.95, y: 21), 0.8)
        XCTAssertLessThan(alpha(fault, x: 22.95, y: 21), 0.2)
        // Near the triangle's lower corner: inside the triangle, outside the circle
        XCTAssertGreaterThan(alpha(fault, x: 29.0, y: 23.5), 0.8)
        XCTAssertLessThan(alpha(attention, x: 29.0, y: 23.5), 0.2)
    }
}
