import Foundation

public enum RemoteMatch {
    public static func normalise(_ remote: String) -> String {
        var value = remote.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { return "" }

        for scheme in ["ssh://", "git://", "https://", "http://"] where value.lowercased().hasPrefix(scheme) {
            value = String(value.dropFirst(scheme.count))
            break
        }
        if let at = value.firstIndex(of: "@"), !value[value.startIndex..<at].contains("/") {
            value = String(value[value.index(after: at)...])
        }
        if let colon = value.firstIndex(of: ":"), !value[value.startIndex..<colon].contains("/") {
            let after = value[value.index(after: colon)...]
            let startsWithPort = after.first?.isNumber == true
            if !startsWithPort {
                value = value.replacingCharacters(in: colon...colon, with: "/")
            }
        }
        while value.hasSuffix("/") { value = String(value.dropLast()) }
        if value.lowercased().hasSuffix(".git") { value = String(value.dropLast(4)) }

        return value.lowercased()
    }

    public static func same(_ a: String, _ b: String) -> Bool {
        let left = normalise(a)
        return !left.isEmpty && left == normalise(b)
    }
}
