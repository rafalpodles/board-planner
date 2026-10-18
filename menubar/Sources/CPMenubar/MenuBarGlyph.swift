import AppKit
import CPMenubarCore

/// Paints an `IconGlyph` as the template image the menu bar wants: black with alpha, which the
/// system tints for light, dark and a busy wallpaper. Drawn in the logo's own coordinates
/// (public/logo.svg), cropped to the cards and the badge.
enum MenuBarGlyph {
    static let size = NSSize(width: 20, height: 16)
    static let viewBox = NSRect(x: 3, y: 4, width: 28, height: 22)

    /// One breath is these four frames, 0 dim to 1 lit
    static let breaths: [CGFloat] = [0, 0.5, 1, 0.5]

    static func image(_ glyph: IconGlyph, breath: CGFloat = 1) -> NSImage {
        let image = NSImage(size: size, flipped: true) { bounds in
            let scale = min(bounds.width / viewBox.width, bounds.height / viewBox.height)
            let transform = NSAffineTransform()
            transform.scaleX(by: scale, yBy: scale)
            transform.translateX(by: -viewBox.minX, yBy: -viewBox.minY)
            transform.concat()

            for (index, card) in Brand.cards.enumerated() {
                var opacity = CGFloat(glyph.opacities[index])
                if glyph.breathing == index {
                    opacity = CGFloat(IconGlyph.unlitOpacity) + (1 - CGFloat(IconGlyph.unlitOpacity)) * breath
                }
                NSColor.black.withAlphaComponent(opacity).setFill()
                NSBezierPath(roundedRect: NSRect(x: card.x, y: card.y, width: 6, height: 4), xRadius: 1, yRadius: 1).fill()
            }
            drawBadge(glyph.badge)
            return true
        }
        image.isTemplate = true
        return image
    }

    private static let badgeCentre = NSPoint(x: 26, y: 21)

    private static func drawBadge(_ badge: IconGlyph.Badge) {
        guard badge != .none else { return }
        let centre = badgeCentre

        NSColor.black.setFill()
        NSColor.black.setStroke()
        switch badge {
        case .attention:
            NSBezierPath(ovalIn: NSRect(x: centre.x - 3.4, y: centre.y - 3.4, width: 6.8, height: 6.8)).fill()
        case .fault:
            let triangle = NSBezierPath()
            triangle.move(to: NSPoint(x: centre.x, y: centre.y - 4.2))
            triangle.line(to: NSPoint(x: centre.x + 4.2, y: centre.y + 3.2))
            triangle.line(to: NSPoint(x: centre.x - 4.2, y: centre.y + 3.2))
            triangle.close()
            triangle.fill()
        case .offline:
            let ring = NSBezierPath(ovalIn: NSRect(x: centre.x - 2.8, y: centre.y - 2.8, width: 5.6, height: 5.6))
            ring.lineWidth = 1.6
            ring.stroke()
        case .none:
            break
        }
    }
}
