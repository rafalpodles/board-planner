import Foundation

/// What the menu bar icon draws: the logo's six cards, and how lit each one is. A function of the
/// state, so it is the one place that decides what an icon means; the view only paints it.
///
/// Monochrome by construction. The menu bar draws this as a template image, so health is carried
/// by how many cards are lit and by the badge's shape, never by colour.
public struct IconGlyph: Equatable, Sendable {
    public enum Badge: Equatable, Sendable {
        case none
        /// A task is waiting for a person
        case attention
        /// The machine could not run the last task
        case fault
        /// The app cannot reach the worker
        case offline
    }

    public static let cardCount = 6
    /// The brand's own opacities for the six cards (public/logo.svg)
    public static let restingOpacities: [Double] = [0.9, 0.6, 0.9, 0.6, 0.4, 0.9]
    public static let unlitOpacity = 0.25

    public let opacities: [Double]
    /// The one card that breathes, while a run is on a stage that has not finished it
    public let breathing: Int?
    public let badge: Badge
}

extension WorkerState {
    /// Stage n lights the first n cards: seven stages over six cards, so claiming has none lit and
    /// merging has all of them, with the card for the current stage breathing in between.
    public func iconGlyph(now: Date) -> IconGlyph {
        let resting = IconGlyph.restingOpacities
        switch effectiveHealth(now: now) {
        case .idle:
            return IconGlyph(opacities: resting, breathing: nil, badge: .none)
        case .paused:
            return IconGlyph(opacities: resting.map { $0 * 0.5 }, breathing: nil, badge: .none)
        case .working:
            let lit = min(stageIndex ?? 0, IconGlyph.cardCount)
            let opacities = (0..<IconGlyph.cardCount).map { $0 < lit ? 1.0 : IconGlyph.unlitOpacity }
            return IconGlyph(opacities: opacities, breathing: lit < IconGlyph.cardCount ? lit : nil, badge: .none)
        case .needsHuman:
            return IconGlyph(opacities: resting, breathing: nil, badge: .attention)
        case .faulted:
            return IconGlyph(opacities: resting, breathing: nil, badge: .fault)
        case .disconnected:
            return IconGlyph(opacities: resting.map { $0 * 0.5 }, breathing: nil, badge: .offline)
        }
    }
}
