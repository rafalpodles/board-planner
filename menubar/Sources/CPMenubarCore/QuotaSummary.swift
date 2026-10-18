import Foundation

/// What the panel says about the Claude subscription's limit, from the last `rate_limit_event` the
/// CLI sent. Nil when that event carried nothing to show: the CLI sends it only near thresholds, so
/// silence is the ordinary case and a tile with a made-up number would be worse than no tile.
public struct QuotaSummary: Equatable, Sendable {
    public let label: String
    public let value: String
    public let resets: String?
    public let exhausted: Bool

    public init?(_ quota: Quota, now: Date, calendar: Calendar = .current) {
        let exhausted = quota.status == "rejected"
        guard exhausted || quota.utilization != nil else { return nil }

        switch quota.rateLimitType {
        case "seven_day": label = "Weekly limit"
        case "five_hour": label = "5-hour limit"
        default: label = "Usage limit"
        }
        value = exhausted ? "Reached" : "\(Int(((quota.utilization ?? 0) * 100).rounded()))%"
        self.exhausted = exhausted
        resets = quota.resetsAt.map { QuotaSummary.resets(at: Date(timeIntervalSince1970: $0), now: now, calendar: calendar) }
    }

    private static func resets(at date: Date, now: Date, calendar: Calendar) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        let sameDay = calendar.isDate(date, inSameDayAs: now)
        formatter.dateFormat = sameDay ? "HH:mm" : "EEE"
        return "resets " + formatter.string(from: date)
    }
}
