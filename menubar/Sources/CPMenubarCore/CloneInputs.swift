import Foundation

public enum CloneInputs {
    private static let schemes = ["https://", "http://", "ssh://"]

    public static func isRemote(_ value: String) -> Bool {
        guard !value.isEmpty, !value.hasPrefix("-") else { return false }
        guard value.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else { return false }
        if let scheme = schemes.first(where: { value.hasPrefix($0) }) {
            return value.count > scheme.count
        }
        return isScpLike(value)
    }

    private static func isScpLike(_ value: String) -> Bool {
        guard !value.contains("://"), let colon = value.firstIndex(of: ":") else { return false }
        let authority = value[value.startIndex..<colon]
        guard let at = authority.firstIndex(of: "@") else { return false }
        return !authority[authority.startIndex..<at].isEmpty
            && !authority[authority.index(after: at)...].isEmpty
            && !value[value.index(after: colon)...].isEmpty
    }

    public static func isProjectKey(_ value: String) -> Bool {
        guard let first = value.first, first.isASCII, first.isLetter || first.isNumber else {
            return false
        }
        return value.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }

    public static func isContained(_ target: String, in parent: String) -> Bool {
        let root = (parent as NSString).standardizingPath
        let resolved = (target as NSString).standardizingPath
        return resolved.hasPrefix(root.hasSuffix("/") ? root : root + "/")
    }
}
