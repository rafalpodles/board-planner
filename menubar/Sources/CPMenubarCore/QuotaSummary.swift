import Foundation

/// What the panel says about the Claude subscription's limit, from the last `rate_limit_event` the
/// CLI sent. Nil when that event carried nothing to show: the CLI sends it only near thresholds, so
/// silence is the ordinary case and a tile with a made-up number would be worse than no tile.
public struct QuotaSummary: Equatable, Sendable {
    public let label: String
    public let value: String
    public let resets: String?
    public let exhausted: Bool

    public init?(_ quota: Quota, now: Date, calendar: Calendar = .current, locale: Locale = .current) {
        let exhausted = quota.status == "rejected"
        guard exhausted || quota.utilization != nil else { return nil }
        // The CLI reports only during a run, so on an idle machine this is the last thing it said. A
        // window that has already reset is not a limit any more, and a time in the past is wrong.
        if let resetsAt = quota.resetsAt, Date(timeIntervalSince1970: resetsAt) <= now { return nil }

        switch quota.rateLimitType {
        case "seven_day": label = "Weekly limit"
        case "seven_day_opus": label = "Weekly Opus limit"
        case "seven_day_sonnet": label = "Weekly Sonnet limit"
        case "five_hour": label = "5-hour limit"
        default: label = "Usage limit"
        }
        value = exhausted ? "Reached" : "\(Int(((quota.utilization ?? 0) * 100).rounded()))%"
        self.exhausted = exhausted
        resets = quota.resetsAt.map {
            QuotaSummary.resets(at: Date(timeIntervalSince1970: $0), now: now, calendar: calendar, locale: locale)
        }
    }

    // A clock time today, a weekday within the next six days, a date beyond that: "resets Fri" must
    // never mean a Friday a week away that reads as today.
    private static func resets(at date: Date, now: Date, calendar: Calendar, locale: Locale) -> String {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day ?? 0
        let template = days == 0 ? "Hm" : (days < 6 ? "EEE" : "d MMM")
        formatter.setLocalizedDateFormatFromTemplate(template)
        return "resets " + formatter.string(from: date)
    }
}
