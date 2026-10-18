import SwiftUI
import CPMenubarCore

enum Brand {
    static let blue = Color(red: 0x3B / 255, green: 0x82 / 255, blue: 0xF6 / 255)
    static let actionBlue = Color(red: 0x25 / 255, green: 0x63 / 255, blue: 0xEB / 255)

    /// The logo's six cards in its 32-unit square (public/logo.svg): column, row, opacity.
    static let cards: [(x: CGFloat, y: CGFloat, opacity: Double)] = [
        (5, 6, IconGlyph.restingOpacities[0]), (5, 12, IconGlyph.restingOpacities[1]),
        (13, 6, IconGlyph.restingOpacities[2]), (13, 12, IconGlyph.restingOpacities[3]),
        (13, 18, IconGlyph.restingOpacities[4]), (21, 6, IconGlyph.restingOpacities[5]),
    ]
}

/// The mark as the brand guide draws it: blue rounded square, three columns of staggered cards. Not
/// recoloured, shadowed or re-spaced.
struct BrandMark: View {
    var size: CGFloat = 30

    var body: some View {
        Canvas { context, canvas in
            let unit = canvas.width / 32
            context.fill(
                Path(roundedRect: CGRect(origin: .zero, size: canvas), cornerRadius: 8 * unit),
                with: .color(Brand.blue))
            for card in Brand.cards {
                let rect = CGRect(x: card.x * unit, y: card.y * unit, width: 6 * unit, height: 4 * unit)
                context.fill(
                    Path(roundedRect: rect, cornerRadius: unit),
                    with: .color(.white.opacity(card.opacity)))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

struct StatePill: View {
    let text: String
    let color: Color

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(text).font(.caption).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 3)
        .background(.quaternary.opacity(0.6), in: Capsule())
        .accessibilityElement(children: .combine)
    }
}

struct StageRail: View {
    let stage: Int
    let labels: [String]

    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 3) {
                ForEach(labels.indices, id: \.self) { index in
                    Capsule()
                        .fill(index < stage ? Brand.blue : (index == stage ? Brand.blue.opacity(0.45) : Color.secondary.opacity(0.25)))
                        .frame(height: 4)
                }
            }
            HStack {
                Text(labels[stage]).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text("\(stage + 1) of \(labels.count)").font(.caption).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Stage \(stage + 1) of \(labels.count): \(labels[stage])")
    }
}

struct ToolLog: View {
    let tools: [ToolActivity]

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(tools.enumerated()), id: \.offset) { _, tool in
                (Text(tool.name).foregroundStyle(.primary) + Text(tool.target.map { " \($0)" } ?? "").foregroundStyle(.secondary))
                    .font(.system(size: 11.5, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct MetricTile: View {
    let label: String
    let value: String
    var detail: String?
    var tint: Color?

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(value).font(.system(size: 18, weight: .medium)).foregroundStyle(tint ?? .primary)
                if let detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .combine)
    }
}

struct NoteCard: View {
    let text: String
    let tint: Color

    var body: some View {
        Text(text)
            .font(.callout)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 11)
            .padding(.vertical, 9)
            .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct FooterButtonStyle: ButtonStyle {
    var tint: Color?
    @State private var hovering = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout)
            .foregroundStyle(tint ?? .primary)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(
                hovering || configuration.isPressed ? Color.secondary.opacity(0.15) : .clear,
                in: RoundedRectangle(cornerRadius: 6)
            )
            .onHover { hovering = $0 }
    }
}
