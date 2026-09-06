import Foundation

public enum BoardURL {
    public static func normalise(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }

        let withoutTrailingSlash = trimmed.hasSuffix("/") ? String(trimmed.dropLast()) : trimmed
        if withoutTrailingSlash.contains("://") { return withoutTrailingSlash }

        let host = withoutTrailingSlash.split(separator: "/").first.map(String.init) ?? withoutTrailingSlash
        let bare = host.split(separator: ":").first.map(String.init) ?? host
        let isLocal = bare == "localhost" || bare == "127.0.0.1" || bare == "::1" || bare.hasSuffix(".local")

        return (isLocal ? "http://" : "https://") + withoutTrailingSlash
    }
}
