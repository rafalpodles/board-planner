import Foundation

public enum CPMenubarCore {
    public static let unknownVersion = "0.0.0-unknown"

    // bundle.sh stamps the release tag's version into Info.plist; a build run outside the bundle
    // has no version to report.
    public static var version: String { version(from: Bundle.main.infoDictionary) }

    static func version(from info: [String: Any]?) -> String {
        guard let value = (info?["CFBundleShortVersionString"] as? String)?
            .trimmingCharacters(in: .whitespaces), !value.isEmpty
        else { return unknownVersion }
        return value
    }
}
